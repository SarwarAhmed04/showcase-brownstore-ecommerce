import assert from "node:assert/strict";
import test from "node:test";
import { downloadGiniProductImage, setGiniMediaFetch } from "./services/giniSyncOne.js";
import { previewGiniVariant38104, runGiniVariant38104Stage } from "./services/giniVariantPilot.js";
import { publicMediaUrl } from "./utils/commissionExcel.js";
import { isAllowedMediaUrl } from "./utils/giniSyncOnePlan.js";
import { GINI_VARIANT_PILOT_SLOTS, buildPilotView } from "./utils/giniVariantPilot.js";

const IT = "6adf9ca49dedbaa3dd573cce";
const OPEN = { GINI_VARIANT_SYNC_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_VARIANT_SYNC: "true" };
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const BLACK = "/api/media/uploads/products/38104-black.webp";
const BLUE = "/api/media/uploads/products/38104-blue.webp";

function readyPreview({ operationStatus = "idle", remote = { exists: false, state: "absent", status: 404 }, extraSku = false } = {}) {
  const combinations = [
    { sourceVariantId: "v-black", sourceSizeId: "s-black", color: "Black", size: "One", stock: 4, price: 1000, images: 1, proposedSku: "38104-BLACK", attributeId: "3696" },
    { sourceVariantId: "v-blue", sourceSizeId: "s-blue", color: "Blue", size: "One", stock: 3, price: 1000, images: 1, proposedSku: "38104-BLUE", attributeId: "3696" },
  ];
  if (extraSku) combinations.push({ sourceVariantId: "v-red", sourceSizeId: "s-red", color: "Red", size: "One", stock: 1, price: 1000, images: 1, proposedSku: "38104-RED", attributeId: "3696" });
  return buildPilotView({
    writesEnabled: false,
    slots: [{ order: 1, parentSku: "38104", productId: IT }],
    attribute: { id: "3696", name: "Color", values: ["Black", "Blue", "Red"] },
    categories: [{ id: "3", isActive: true, subcategories: [{ id: "3", isActive: true }] }],
    remoteBySku: { "38104": remote },
    operations: [{ productId: IT, status: operationStatus }],
    texts: { [IT]: { name: "IT Lobby case", description: "A local case" } },
    products: [{
      productId: IT,
      name: "IT Lobby case",
      vendor: "IT Lobby",
      vendorId: "it-lobby",
      parentSku: "38104",
      categoryId: "3",
      subcategoryId: "3",
      status: "APPROVED_FOR_FUTURE_SYNC",
      blockers: [],
      multipleSizes: false,
      combinations,
    }],
  });
}

function memoryOperation(status = "idle") {
  let row = { status };
  return () => ({
    async read() {
      return { ...row };
    },
    async update(patch) {
      row = { ...row, ...patch };
      return { ...row };
    },
  });
}

function imageRows() {
  return [
    { proposedSku: "38104-BLACK", price: 1000, stock: 4, attributeId: "3696", giniColor: "Black", imageUrl: BLACK },
    { proposedSku: "38104-BLUE", price: 1000, stock: 3, attributeId: "3696", giniColor: "Blue", imageUrl: BLUE },
  ];
}

function variantBody() {
  return [
    { id: "1", sku: "38104-BLACK", quantity: 4, price: 1000, attributes: [{ attribute_id: "3696", value: "Black" }] },
    { id: "2", sku: "38104-BLUE", quantity: 3, price: 1000, attributes: [{ attribute_id: "3696", value: "Blue" }] },
  ];
}

test("a preview media path is downloaded as bytes from its absolute BrownStore URL", async () => {
  assert.equal(isAllowedMediaUrl(BLACK), false);
  const absolute = publicMediaUrl(BLACK);
  assert.equal(absolute, "https://api.brownstore.net/api/media/uploads/products/38104-black.webp");
  assert.equal(isAllowedMediaUrl(absolute), true);
  const calls = [];
  setGiniMediaFetch(async (url) => {
    calls.push(String(url));
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : null) },
      async arrayBuffer() {
        return PNG;
      },
    };
  });
  try {
    await assert.rejects(() => downloadGiniProductImage(BLACK, 0));
    assert.equal(calls.length, 0);
    const file = await downloadGiniProductImage(absolute, 0);
    assert.equal(calls[0], absolute);
    assert.equal(file.blob.size, PNG.length);
    assert.equal(file.filename, "image-1.png");
  } finally {
    setGiniMediaFetch(null);
  }
});

test("stage A creates only the hidden 38104 parent and stage B reads back the two approved variants", async () => {
  const media = [];
  setGiniMediaFetch(async (url) => {
    media.push(String(url));
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : null) },
      async arrayBuffer() {
        return PNG;
      },
    };
  });
  const gates = ["GINI_VARIANT_SYNC_WRITES_ENABLED", "GINI_ALLOW_LIVE_VARIANT_SYNC"];
  const before = Object.fromEntries(gates.map((key) => [key, process.env[key]]));
  try {
    const blocked = [];
    const closed = await runGiniVariant38104Stage(
      { stage: "parent", confirm: true },
      { preview: readyPreview(), persist: false, env: {}, perform: async () => { blocked.push("live"); return { status: 201 }; } }
    );
    assert.equal(closed.code, "variant_sync_writes_disabled");
    assert.equal(blocked.length, 0);

    let parentGets = 0;
    let variantGets = 0;
    let created = null;
    const methods = [];
    const parent = await runGiniVariant38104Stage(
      { stage: "parent", confirm: true },
      {
        preview: readyPreview(),
        persist: false,
        env: OPEN,
        operation: memoryOperation("idle"),
        imageRows: async () => imageRows(),
        perform: async (request) => {
          methods.push(request.method);
          if (request.method === "POST") {
            created = request.form;
            return { status: 201, json: { data: { id: "900", sku: "38104" } } };
          }
          if (String(request.path).endsWith("/variants")) {
            variantGets += 1;
            return { status: 200, json: { data: [] } };
          }
          parentGets += 1;
          if (parentGets === 1) return { status: 404, json: {} };
          return { status: 200, json: { data: { id: "900", sku: "38104", quantity: 0, is_visible: 0 } } };
        },
      }
    );
    assert.equal(parent.code, "parent_verified");
    assert.equal(parent.confirmedBy, "GET");
    assert.equal(parent.sentToGini, 1);
    assert.deepEqual(methods.filter((method) => method !== "GET"), ["POST"]);
    assert.equal(created.get("sku"), "38104");
    assert.equal(created.get("quantity"), "0");
    assert.equal(created.get("is_visible"), "0");
    assert.equal(created.get("category_id"), "3");
    assert.equal(created.get("subcategory_id"), "3");
    const uploaded = created.getAll("images[]");
    assert.equal(uploaded.length, 2);
    assert.equal(uploaded.every((file) => file.size === PNG.length), true);
    assert.deepEqual(media, [publicMediaUrl(BLACK), publicMediaUrl(BLUE)]);

    const early = await runGiniVariant38104Stage(
      { stage: "variants", confirm: true },
      { preview: readyPreview(), persist: false, env: OPEN, perform: async () => { throw new Error("early"); } }
    );
    assert.equal(early.code, "stage_b_parent_not_verified");

    variantGets = 0;
    parentGets = 0;
    let saved = null;
    const variantMethods = [];
    const variants = await runGiniVariant38104Stage(
      { stage: "variants", confirm: true },
      {
        preview: readyPreview({
          operationStatus: "parent_verified",
          remote: { exists: true, state: "present", status: 200, sku: "38104", id: "900", visibility: "hidden", quantity: 0, variants: { state: "empty", rows: [] } },
        }),
        persist: false,
        env: OPEN,
        operation: memoryOperation("parent_verified"),
        imageRows: async () => imageRows(),
        perform: async (request) => {
          variantMethods.push(request.method);
          if (request.method === "PUT") {
            saved = request.form;
            return { status: 200, json: { data: [] } };
          }
          if (String(request.path).endsWith("/variants")) {
            variantGets += 1;
            return { status: 200, json: { data: variantGets === 1 ? [] : variantBody() } };
          }
          parentGets += 1;
          return { status: 200, json: { data: { id: "900", sku: "38104", quantity: parentGets === 1 ? 0 : 7, is_visible: 0 } } };
        },
      }
    );
    assert.equal(variants.code, "variants_verified");
    assert.equal(variants.confirmedBy, "GET");
    assert.deepEqual(variantMethods.filter((method) => method !== "GET"), ["PUT"]);
    assert.deepEqual(
      [saved.get("variants[0][sku]"), saved.get("variants[1][sku]")],
      ["38104-BLACK", "38104-BLUE"]
    );
    assert.equal(saved.get("variants[2][sku]"), null);
    const files = [saved.get("variants[0][image]"), saved.get("variants[1][image]")];
    assert.equal(files.every((file) => file?.size === PNG.length), true);
  } finally {
    setGiniMediaFetch(null);
    assert.deepEqual(Object.fromEntries(gates.map((key) => [key, process.env[key]])), before);
  }
});

test("38104 stays outside the five-product pilot and rejects any other variant SKU", async () => {
  assert.equal(GINI_VARIANT_PILOT_SLOTS.some((slot) => slot.parentSku === "38104"), false);
  const calls = [];
  const mismatch = await runGiniVariant38104Stage(
    { stage: "parent", confirm: true },
    { preview: readyPreview({ extraSku: true }), persist: false, env: OPEN, perform: async () => { calls.push("write"); return { status: 201 }; } }
  );
  assert.equal(mismatch.code, "approval_mismatch");
  assert.equal(calls.length, 0);
  const preview = await previewGiniVariant38104({
    loadCatalog: async () => ({
      products: [{
        productId: IT,
        vendor: "IT Lobby",
        parentSku: "38104",
        categoryId: "3",
        subcategoryId: "3",
        status: "APPROVED_FOR_FUTURE_SYNC",
        blockers: [],
        combinations: readyPreview().products[0].combinations,
      }],
      summary: {},
    }),
    skipCategoryCounts: true,
    categories: [{ id: "3", isActive: true, subcategories: [{ id: "3", isActive: true }] }],
    attribute: { id: "3696", name: "Color", values: ["Black", "Blue"] },
    remoteBySku: { "38104": { exists: false, state: "absent", status: 404 } },
    texts: { [IT]: { name: "IT Lobby case", description: "A local case" } },
    operations: [],
    perform: async () => { calls.push("live"); throw new Error("live"); },
  });
  assert.equal(preview.products.length, 1);
  assert.equal(preview.products[0].productId, IT);
  assert.deepEqual(preview.products[0].combinations.map((row) => row.proposedSku), ["38104-BLACK", "38104-BLUE"]);
  assert.equal(preview.writesEnabled, false);
  assert.equal(calls.length, 0);
});
