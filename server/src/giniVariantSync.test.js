import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildGiniPlanFromParts } from "./utils/giniSyncEvaluate.js";
import { classifyVariantProduct, giniVariantSyncWritesEnabled, proposalConflicts, proposeVariantSku } from "./utils/giniVariantCatalog.js";
import { buildReusableVariantFields } from "./utils/giniVariantPayload.js";
import { canSendGiniVariantSync } from "../../client/src/components/admin/platform/giniVariantSyncDisplay.js";
import { runPreparedVariantStageA, runPreparedVariantStageB } from "./services/giniVariantSync.js";

const OPEN = { GINI_VARIANT_SYNC_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_SYNC: "true" };
const COLOR = { attributeId: "3696", name: "Color", values: ["Blue", "Black", "Purple"] };

function doc(overrides = {}) {
  return {
    _id: "product-1",
    itemCode: "100",
    name: { en: "Phone", ar: "هاتف" },
    description: { ar: "وصف" },
    brand: { name: "Xiaomi" },
    createdBy: { _id: "vendor-1", name: "Jawal Flex" },
    variants: [
      { _id: "v1", color: { en: "Blue" }, images: [{ url: "/a.webp" }], sizes: [{ _id: "s1", size: "large", stockQuantity: 10 }] },
      { _id: "v2", color: { en: "Black" }, images: [{ url: "/b.webp" }], sizes: [{ _id: "s2", size: "large", stockQuantity: 4 }] },
      { _id: "v3", color: { en: "Purple" }, images: [{ url: "/c.webp" }], sizes: [{ _id: "s3", size: "large", stockQuantity: 6 }] },
    ],
    ...overrides,
  };
}

function memoryOperation(status = "idle") {
  let row = { status };
  return {
    async read() {
      return { ...row };
    },
    async update(patch) {
      row = { ...row, ...patch };
      return { ...row };
    },
  };
}

test("variant sync writes stay off unless both gates are set", () => {
  assert.equal(giniVariantSyncWritesEnabled({}), false);
  assert.equal(giniVariantSyncWritesEnabled({ GINI_VARIANT_SYNC_WRITES_ENABLED: "true" }), false);
  assert.equal(canSendGiniVariantSync(), false);
  assert.equal(fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8").includes("variant-sync/send"), false);
});

test("three colors keep separate stock and a deterministic SKU", () => {
  const row = classifyVariantProduct({
    doc: doc(),
    giniPrice: 1000,
    mappingOk: true,
    categoryId: "3",
    subcategoryId: "3",
    ownerIds: ["product-1"],
    colorContract: COLOR,
  });
  assert.equal(row.status, "READY_FOR_REVIEW");
  assert.equal(row.canSend, false);
  assert.deepEqual(row.combinations.map((item) => item.stock), [10, 4, 6]);
  assert.deepEqual(row.combinations.map((item) => item.proposedSku), ["100-BLUE", "100-BLACK", "100-PURPLE"]);
  assert.equal(proposeVariantSku("100", "Blue", "large", { multipleSizes: false }), "100-BLUE");
});

test("color and size products stay blocked until a size attribute exists", () => {
  const sized = doc({
    variants: [
      { _id: "v1", color: { en: "Blue" }, images: [{ url: "/a.webp" }], sizes: [{ _id: "s1", size: "Small", stockQuantity: 2 }, { _id: "s2", size: "Medium", stockQuantity: 3 }] },
    ],
  });
  const row = classifyVariantProduct({ doc: sized, giniPrice: 1000, mappingOk: true, ownerIds: ["product-1"], colorContract: COLOR });
  assert.equal(row.status, "BLOCKED");
  assert.equal(row.blockers.includes("size_attribute_unverified"), true);
  assert.equal(row.combinations.some((item) => item.attributeId), false);
});

test("two vendors sharing a parent SKU need an ownership decision", () => {
  const row = classifyVariantProduct({
    doc: doc(),
    giniPrice: 1000,
    mappingOk: true,
    ownerIds: ["product-1", "product-2"],
    colorContract: COLOR,
  });
  assert.equal(row.status, "NEEDS_REVIEW");
  assert.equal(row.blockers.includes("duplicate_parent_sku"), true);
  const chosen = classifyVariantProduct({
    doc: doc({ _id: "product-2" }),
    giniPrice: 1000,
    mappingOk: true,
    ownerIds: ["product-1", "product-2"],
    canonicalOwnerId: "product-1",
    colorContract: COLOR,
  });
  assert.equal(chosen.status, "BLOCKED");
  assert.equal(chosen.blockers.includes("other_vendor_owns_parent"), true);
});

test("missing category, attribute, and SKU approval are separate blockers", () => {
  const unmapped = classifyVariantProduct({ doc: doc(), giniPrice: 1000, mappingOk: false, ownerIds: ["product-1"], colorContract: COLOR });
  assert.equal(unmapped.blockers.includes("missing_mapping"), true);
  const unknownColor = classifyVariantProduct({ doc: doc(), giniPrice: 1000, mappingOk: true, ownerIds: ["product-1"], colorContract: null });
  assert.equal(unknownColor.blockers.includes("missing_attribute"), true);
  assert.equal(unknownColor.status, "BLOCKED");
  const ready = classifyVariantProduct({ doc: doc(), giniPrice: 1000, mappingOk: true, ownerIds: ["product-1"], colorContract: COLOR });
  assert.equal(ready.blockers.includes("missing_variant_sku_approval"), true);
  assert.notEqual(ready.status, "APPROVED_FOR_FUTURE_SYNC");
});

test("a verified remote parent is not treated as a new simple product", () => {
  const identities = [
    { sourceVariantId: "v1", sourceSizeId: "s1", approvedSku: "100-BLUE", confirmedGiniVariantId: "1", status: "verified" },
    { sourceVariantId: "v2", sourceSizeId: "s2", approvedSku: "100-BLACK", confirmedGiniVariantId: "2", status: "verified" },
    { sourceVariantId: "v3", sourceSizeId: "s3", approvedSku: "100-PURPLE", confirmedGiniVariantId: "3", status: "verified" },
  ];
  const row = classifyVariantProduct({
    doc: doc(),
    giniPrice: 1000,
    mappingOk: true,
    ownerIds: ["product-1", "product-2"],
    canonicalOwnerId: "product-1",
    identities,
    colorContract: COLOR,
    remoteParent: { giniProductId: "613402", productId: "product-1" },
  });
  assert.equal(row.status, "VERIFIED_REMOTE");
  assert.equal(row.canSend, false);
  const simple = buildGiniPlanFromParts({
    doc: { _id: "simple", itemCode: "100", name: { en: "Phone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [{ color: { en: "Blue" }, sizes: [{ size: "large" }] }] },
    resolved: { name: { en: "Phone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [{}], stock: 1, isActive: true },
    priced: { price: 1000, storePrice: 1000 },
    duplicateProductIds: ["simple"],
    mapping: { blockers: [] },
    existing: { exists: false },
  });
  assert.equal(simple.blockers.includes("variant_parent_protected"), false);
  const guarded = buildGiniPlanFromParts({
    doc: { _id: "simple", itemCode: "100", name: { en: "Phone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [{ color: { en: "Blue" }, sizes: [{ size: "large" }] }] },
    resolved: { name: { en: "Phone", ar: "هاتف" }, description: { ar: "وصف" }, brand: { name: "Xiaomi" }, variants: [{}], stock: 1, isActive: true },
    priced: { price: 1000, storePrice: 1000 },
    duplicateProductIds: ["simple"],
    mapping: { blockers: [] },
    existing: { exists: false },
    protectedVariantSku: true,
  });
  assert.equal(guarded.canSend, false);
  assert.equal(guarded.blockers.includes("variant_parent_protected"), true);
});

test("duplicate proposed SKUs are conflicts and preview builds no write", () => {
  const conflicts = proposalConflicts([
    { productId: "a", combinations: [{ proposedSku: "100-BLUE", sourceVariantId: "1", sourceSizeId: "1" }] },
    { productId: "b", combinations: [{ proposedSku: "100-blue", sourceVariantId: "2", sourceSizeId: "2" }] },
  ]);
  assert.equal(conflicts.length, 1);
  const fields = buildReusableVariantFields([{ sku: "100-BLUE", price: 10, stock: 2, attributeId: "3696", value: "Blue" }]);
  assert.equal(fields.method, "PUT");
  assert.equal(fields.fields.some((field) => field.key === "variants[0][attributes][0][attribute_id]" && field.value === "3696"), true);
});

test("preview mode and a closed gate do not call GINI", async () => {
  const calls = [];
  const perform = async (request) => {
    calls.push(request.method);
    throw new Error("live");
  };
  const closed = await runPreparedVariantStageA({ sku: "100", approved: true, writesEnabled: true, perform });
  assert.equal(closed.code, "variant_sync_writes_disabled");
  assert.equal(calls.length, 0);
  const stageB = await runPreparedVariantStageB({ sku: "100", approved: true, writesEnabled: false, perform });
  assert.equal(stageB.code, "variant_sync_writes_disabled");
  assert.equal(calls.length, 0);
});

test("an existing parent is not created again, and an uncertain create is not retried", async () => {
  const operation = memoryOperation("idle");
  const methods = [];
  const existing = await runPreparedVariantStageA({
    sku: "100",
    approved: true,
    writesEnabled: true,
    env: OPEN,
    operation,
    perform: async (request) => {
      methods.push(request.method);
      return { status: 200, json: { data: { id: "9", sku: "100" } } };
    },
  });
  assert.equal(existing.code, "parent_already_exists");
  assert.equal(methods.includes("POST"), false);
  const uncertain = memoryOperation("parent_uncertain");
  const retry = await runPreparedVariantStageA({
    sku: "100",
    approved: true,
    writesEnabled: true,
    env: OPEN,
    operation: uncertain,
    perform: async (request) => {
      methods.push(request.method);
      if (request.method === "POST") throw new Error("retry");
      return { status: 404, json: {} };
    },
  });
  assert.equal(retry.sent, false);
  assert.equal(retry.code, "parent_create_uncertain");
  assert.equal(methods.includes("POST"), false);
});

test("unknown existing variants are not overwritten", async () => {
  const methods = [];
  const result = await runPreparedVariantStageB({
    sku: "100",
    approved: true,
    writesEnabled: true,
    env: OPEN,
    approvedRows: [{ sku: "100-BLUE", stock: 10, attributeId: "3696" }],
    perform: async (request) => {
      methods.push(request.method);
      if (request.path.endsWith("/variants")) {
        return { status: 200, json: { data: [{ sku: "OTHER", quantity: 1, attributes: [{ id: 1, value: "Red" }] }] } };
      }
      return { status: 200, json: { data: { sku: "100", quantity: 0, is_visible: 0 } } };
    },
  });
  assert.equal(result.code, "remote_variants_not_replaced");
  assert.equal(methods.includes("PUT"), false);
});

test("an unchosen vendor does not keep a conflict against the approved owner", () => {
  const conflicts = proposalConflicts([
    { productId: "owner", blockers: [], combinations: [{ proposedSku: "71868-BLUE", sourceVariantId: "1", sourceSizeId: "1" }] },
    { productId: "other", blockers: ["other_vendor_owns_parent"], combinations: [{ proposedSku: "71868-BLUE", sourceVariantId: "2", sourceSizeId: "2" }] },
  ]);
  assert.equal(conflicts.length, 0);
});

test("the five-product pilot is preview-only and stops before an unresolved duplicate", async () => {
  const { buildPilotView, GINI_VARIANT_PILOT_SLOTS } = await import("./utils/giniVariantPilot.js");
  const { pilotStageAllowed } = await import("../../client/src/components/admin/platform/giniVariantSyncDisplay.js");
  const { runGiniVariantPilotStage } = await import("./services/giniVariantPilot.js");
  const routes = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
  assert.equal(GINI_VARIANT_PILOT_SLOTS.map((slot) => slot.parentSku).includes("75244"), false);
  assert.equal(routes.includes("variant-sync/pilot/send-all"), false);
  assert.equal(routes.includes("variant-sync/bulk"), false);
  assert.equal(pilotStageAllowed(), false);
  const categories = [
    { id: "2", isActive: true, subcategories: [{ id: "18", isActive: true }] },
    { id: "19", isActive: true, subcategories: [{ id: "4", isActive: true }] },
    { id: "9", isActive: true, subcategories: [{ id: "21", isActive: true }] },
    { id: "3", isActive: true, subcategories: [{ id: "3", isActive: true }] },
  ];
  const attribute = { id: 3696, name: "Color", type: "color", values: ["Blue", "Black", "Purple"] };
  const remote = { exists: false, state: "absent", status: 404 };
  const row = (fields) => ({
    vendorId: "vendor",
    status: "READY_FOR_REVIEW",
    blockers: ["missing_variant_sku_approval"],
    multipleSizes: false,
    ...fields,
  });
  const preview = buildPilotView({
    writesEnabled: false,
    attribute,
    categories,
    remoteBySku: { KE20: remote, "EFR-575D-1ADF": remote, "EI-8888": remote, "71868": remote, "69392": remote },
    texts: {
      "6adc7938b3764a909f6929d6": { name: "HOT PLATES", description: "A hot plate" },
      "6adc7944b3764a909f6930de": { name: "Watch", description: "A watch" },
      "6adc7945b3764a909f6931b1": { name: "Steam Iron", description: "An iron" },
    },
    products: [
      row({
        productId: "6adc7938b3764a909f6929d6",
        name: "HOT PLATES",
        vendor: "Kozano",
        parentSku: "KE20",
        categoryId: "2",
        subcategoryId: "18",
        combinations: [
          { sourceVariantId: "a", sourceSizeId: "b", color: "Blue", size: "Small", stock: 10, price: 26500, images: 2, proposedSku: "KE20-BLUE", attributeId: "3696" },
          { sourceVariantId: "c", sourceSizeId: "d", color: "Black", size: "Small", stock: 10, price: 26500, images: 1, proposedSku: "KE20-BLACK", attributeId: "3696" },
        ],
      }),
      row({
        productId: "6adc7945b3764a909f6931b1",
        name: "Steam Iron",
        vendor: "Sokany",
        parentSku: "EI-8888",
        categoryId: "9",
        subcategoryId: "21",
        combinations: [
          { sourceVariantId: "e", sourceSizeId: "f", color: "blue", size: "Small", stock: 10, price: 119750, images: 1, proposedSku: "EI-8888-BLUE", attributeId: "3696" },
          { sourceVariantId: "g", sourceSizeId: "h", color: "purple", size: "Small", stock: 10, price: 119750, images: 1, proposedSku: "EI-8888-PURPLE", attributeId: "3696" },
        ],
      }),
      row({
        productId: "6adfa1c9b3764a909f694535",
        name: "F8 Ultra Smartphone",
        vendor: "IT Lobby",
        parentSku: "71868",
        categoryId: "3",
        subcategoryId: "3",
        status: "NEEDS_REVIEW",
        blockers: ["duplicate_parent_sku", "missing_variant_sku_approval"],
        combinations: [
          { sourceVariantId: "i", sourceSizeId: "j", color: "Blue", size: "large", stock: 3, price: 1260000, images: 2, proposedSku: "71868-BLUE", attributeId: "3696" },
          { sourceVariantId: "k", sourceSizeId: "l", color: "Black", size: "large", stock: 3, price: 1260000, images: 1, proposedSku: "71868-BLACK", attributeId: "3696" },
        ],
      }),
      row({
        productId: "6ae09068b3764a909f694955",
        name: "F8 Ultra Smartphone",
        vendor: "Jawal Flex",
        parentSku: "71868",
        categoryId: "3",
        subcategoryId: "3",
        status: "NEEDS_REVIEW",
        blockers: ["duplicate_parent_sku", "missing_variant_sku_approval"],
        combinations: [
          { sourceVariantId: "m", sourceSizeId: "n", color: "Blue", size: "large", stock: 3, price: 1260000, images: 2, proposedSku: "71868-BLUE", attributeId: "3696" },
          { sourceVariantId: "o", sourceSizeId: "p", color: "Black", size: "large", stock: 3, price: 1260000, images: 1, proposedSku: "71868-BLACK", attributeId: "3696" },
        ],
      }),
    ],
  });
  assert.equal(preview.canSend, false);
  assert.equal(preview.bulkSyncEnabled, false);
  assert.equal(preview.writesEnabled, false);
  assert.equal(preview.products.length, 5);
  assert.equal(preview.products[0].queue, "blocked");
  assert.equal(preview.products[0].blockers.includes("missing_variant_sku_approval"), true);
  assert.deepEqual(preview.products.find((item) => item.parentSku === "EI-8888").combinations.map((item) => item.giniColor), ["Blue", "Purple"]);
  const duplicate = preview.products.find((item) => item.parentSku === "71868");
  assert.equal(duplicate.ownerRequired, true);
  assert.equal(duplicate.productId, "");
  assert.equal(duplicate.candidates.length, 2);
  const calls = [];
  const refused = await runGiniVariantPilotStage(
    { productId: duplicate.candidates[0].productId, stage: "parent", confirm: true },
    { preview, persist: false, env: OPEN, perform: async () => { calls.push("write"); return { status: 500 }; } }
  );
  assert.equal(refused.code, "duplicate_parent_sku");
  assert.equal(refused.sentToGini, 0);
  assert.equal(calls.length, 0);
});

test("a closed pilot gate does not create a parent, and an uncertain parent is not posted again", async () => {
  const { buildPilotView } = await import("./utils/giniVariantPilot.js");
  const { runGiniVariantPilotStage } = await import("./services/giniVariantPilot.js");
  const ready = buildPilotView({
    writesEnabled: true,
    attribute: { id: "3696", name: "Color", values: ["Blue", "Black"] },
    categories: [{ id: "2", isActive: true, subcategories: [{ id: "18", isActive: true }] }],
    remoteBySku: { KE20: { exists: false, state: "absent", status: 404 } },
    texts: { "6adc7938b3764a909f6929d6": { name: "HOT PLATES", description: "A hot plate" } },
    products: [{
      productId: "6adc7938b3764a909f6929d6",
      name: "HOT PLATES",
      vendor: "Kozano",
      vendorId: "vendor",
      parentSku: "KE20",
      categoryId: "2",
      subcategoryId: "18",
      status: "APPROVED_FOR_FUTURE_SYNC",
      blockers: [],
      multipleSizes: false,
      combinations: [
        { sourceVariantId: "a", sourceSizeId: "b", color: "Blue", size: "Small", stock: 10, price: 26500, images: 1, proposedSku: "KE20-BLUE", attributeId: "3696" },
        { sourceVariantId: "c", sourceSizeId: "d", color: "Black", size: "Small", stock: 10, price: 26500, images: 1, proposedSku: "KE20-BLACK", attributeId: "3696" },
      ],
    }],
  });
  assert.equal(ready.products[0].queue, "next");
  const calls = [];
  const closed = await runGiniVariantPilotStage(
    { productId: "6adc7938b3764a909f6929d6", stage: "parent", confirm: true },
    { preview: ready, persist: false, env: {}, perform: async () => { calls.push("live"); throw new Error("live"); } }
  );
  assert.equal(closed.code, "variant_sync_writes_disabled");
  assert.equal(calls.length, 0);
  const uncertain = buildPilotView({
    writesEnabled: true,
    attribute: { id: "3696", name: "Color", values: ["Blue", "Black"] },
    categories: [{ id: "2", isActive: true, subcategories: [{ id: "18", isActive: true }] }],
    operations: [{ productId: "6adc7938b3764a909f6929d6", status: "parent_uncertain" }],
    remoteBySku: { KE20: { exists: false, state: "absent", status: 404 } },
    texts: { "6adc7938b3764a909f6929d6": { name: "HOT PLATES", description: "A hot plate" } },
    products: ready.products[0] ? [{
      productId: "6adc7938b3764a909f6929d6",
      name: "HOT PLATES",
      vendor: "Kozano",
      parentSku: "KE20",
      categoryId: "2",
      subcategoryId: "18",
      status: "APPROVED_FOR_FUTURE_SYNC",
      blockers: [],
      combinations: ready.products[0].combinations,
    }] : [],
  });
  assert.equal(uncertain.products[0].queue, "stopped");
  const stopped = await runGiniVariantPilotStage(
    { productId: "6adc7938b3764a909f6929d6", stage: "parent", confirm: true },
    { preview: uncertain, persist: false, env: OPEN, perform: async () => { calls.push("retry"); return { status: 201 }; } }
  );
  assert.equal(stopped.sent, false);
  assert.equal(stopped.code, "pilot_stopped_uncertain");
  assert.equal(calls.includes("retry"), false);
});
