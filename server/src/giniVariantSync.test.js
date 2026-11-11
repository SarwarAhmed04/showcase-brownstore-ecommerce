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
