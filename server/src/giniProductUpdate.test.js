import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniChangedPreviewSnapshot } from "./models/GiniChangedPreviewSnapshot.js";
import { GiniProductUpdateAudit } from "./models/GiniProductUpdateAudit.js";
import { GiniProductUpdateJob } from "./models/GiniProductUpdateJob.js";
import { GiniProductUpdateLock } from "./models/GiniProductUpdateLock.js";
import { GiniSyncJob } from "./models/GiniSyncJob.js";
import { GiniSyncProductResult } from "./models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH, signGiniRequest } from "./utils/giniSigner.js";
import { normalizeGiniCategories } from "./utils/giniCategoryTree.js";
import { GINI_DEFAULT_BASE_URL, getGiniConnectionPublic, performGiniJsonRequest, setGiniFetch } from "./services/giniConnection.js";
import { saveGiniConnection, testGiniConnection } from "./services/giniConnection.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { toResolvedProduct } from "./utils/productView.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "./utils/platformTaxonomy.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "./utils/giniSyncOnePlan.js";
import {
  buildGiniPlanFromParts,
  giniPayloadHash,
  mappingFromTree,
} from "./utils/giniSyncEvaluate.js";
import {
  assessGiniImageChange,
  classifyGiniImageReplacement,
  explainGiniPriceQuantityChange,
  giniPartialUpdateBody,
  giniPartialUpdateKeys,
  GINI_CHANGED_SYNC_FIELDS,
  GINI_PUT_DOCUMENTED_FIELDS,
} from "./utils/giniProductUpdateContract.js";
import { runGiniChangedPreview } from "./services/giniSyncAll.js";
import {
  pauseGiniChangedSync,
  resetGiniUpdateForTests,
  resumeGiniChangedSync,
  setGiniUpdateBeforeSend,
  startGiniChangedSync,
  stopGiniChangedSync,
} from "./services/giniProductUpdate.js";

const CLIENT_ID = "gini-update-client";
const SECRET = "gini-update-secret-not-for-the-browser";
const LIVE_TREE = {
  data: [
    {
      id: 1,
      name: "Home",
      slug: "home",
      is_active: 1,
      subcategories: [{ id: 10, name: "Blenders", slug: "blenders", is_active: 1 }],
    },
  ],
};
const CATEGORIES = normalizeGiniCategories(LIVE_TREE).categories;

let memory;
let calls;
let remote;
let putMode;

function mockResponse(status, body, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function skuFromProductUrl(target) {
  const path = String(target).split("?")[0];
  const marker = "/products/";
  const index = path.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(path.slice(index + marker.length).replace(/\/stock$/, ""));
}

function headerValue(headers, name) {
  const found = Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : "";
}

function installFetch() {
  calls = [];
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push({ method, url: target, body: options.body, headers: options.headers });
    if (method !== "GET" && method !== "PUT") throw new Error(`Unexpected GINI method ${method}`);
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, LIVE_TREE);
    if (!target.includes("/products/")) throw new Error(`unexpected ${method} ${target}`);
    const sku = skuFromProductUrl(target);
    const key = giniSkuKey(sku);
    const found = remote.get(key);
    if (method === "GET") {
      if (!found) return mockResponse(404, { message: "Product not found." });
      return mockResponse(200, {
        data: { id: found.id, sku: found.sku, price: found.price, quantity: found.quantity, name: "Live product" },
      });
    }
    const sent = JSON.parse(String(options.body || "{}"));
    if (putMode === "timeout") {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    if (putMode === "timeout-applied") {
      remote.set(key, { ...found, price: sent.price ?? found.price, quantity: sent.quantity ?? found.quantity });
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    if (putMode === "timeout-ambiguous") {
      remote.set(key, { ...found, quantity: 99 });
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    if (putMode === "auth") return mockResponse(401, { message: "Invalid signature" });
    if (putMode === "rejected") return mockResponse(422, { message: "The quantity field is invalid." });
    if (putMode === "rate") return mockResponse(429, { message: "Too many requests" }, { "retry-after": "120" });
    if (putMode === "wrong-id") {
      return mockResponse(200, { data: { id: "999999", sku: found.sku, price: sent.price ?? found.price, quantity: sent.quantity ?? found.quantity } });
    }
    const next = { ...found, price: sent.price ?? found.price, quantity: sent.quantity ?? found.quantity };
    remote.set(key, next);
    return mockResponse(200, { data: { id: found.id, sku: found.sku, price: next.price, quantity: next.quantity } });
  });
}

function puts() {
  return calls.filter((item) => item.method === "PUT");
}

function simpleVariant(stock = 10) {
  return [
    {
      color: { en: "white", ar: "", ku: "" },
      images: [{ url: "/uploads/products/patch.webp", isMain: true }],
      sizes: [{ size: "medium", stockQuantity: stock }],
    },
  ];
}

async function makeProduct(itemCode, overrides = {}) {
  return Product.create({
    ibsherId: overrides.ibsherId || `ibs-${crypto.randomBytes(4).toString("hex")}`,
    itemCode,
    name: overrides.name || { en: `${itemCode} name`, ar: `${itemCode} اسم`, ku: itemCode },
    description: overrides.description || { en: "English description.", ar: "وصف عربي للمنتج", ku: "وەسف" },
    price: overrides.price === undefined ? 6500 : overrides.price,
    discountPrice: 0,
    brand: { _id: "brand-cosrx", name: "COSRX" },
    category: { _id: "cat-beauty", name: { en: "Beauty" } },
    subCategory: { _id: "sub-skin", name: { en: "Skin" } },
    collectionName: { _id: "col-acne", name: { en: "Acne" } },
    isActive: overrides.isActive !== false,
    variants: overrides.variants || simpleVariant(overrides.stock ?? 10),
  });
}

async function mapCollection() {
  await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner: "gini", brownCollectionId: "col-acne" },
    {
      $set: {
        values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" },
      },
    },
    { upsert: true }
  );
}

async function payloadFor(productId) {
  const doc = await Product.findById(productId).lean();
  const [rules, eligibility] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
  ]);
  const plan = buildGiniPlanFromParts({
    doc,
    resolved: toResolvedProduct(doc),
    priced: partnerPricePreview(doc, rules),
    duplicateProductIds: [String(doc._id)],
    mapping: mappingFromTree(taxonomyValuesForProduct(doc, eligibility), CATEGORIES),
    existing: null,
  });
  return { hash: giniPayloadHash(plan.payloadPreview), price: plan.giniPrice, quantity: plan.quantity, payload: plan.payloadPreview };
}

async function confirmSend(product, planned, giniProductId) {
  await GiniSyncSendState.create({
    partner: "gini",
    productId: String(product._id),
    sku: product.itemCode,
    skuKey: giniSkuKey(product.itemCode),
    giniProductId,
    payloadHash: planned.hash,
    jobId: "confirmed-full-sync",
    confirmedAt: new Date("2026-11-02T11:35:20.425Z"),
  });
  await GiniSyncProductResult.create({
    jobId: new mongoose.Types.ObjectId(),
    partner: "gini",
    productId: String(product._id),
    sku: product.itemCode,
    skuKey: giniSkuKey(product.itemCode),
    classification: "CREATED",
    giniProductId,
    giniPrice: planned.price,
    quantity: planned.quantity,
    imageCount: 1,
    payloadHash: planned.hash,
  });
  remote.set(giniSkuKey(product.itemCode), {
    id: giniProductId,
    sku: product.itemCode,
    price: planned.price,
    quantity: planned.quantity,
  });
}

function enableUpdateWrites() {
  process.env.GINI_UPDATE_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
}

function disableUpdateWrites() {
  delete process.env.GINI_UPDATE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
}

async function changedRow(sku) {
  const preview = await runGiniChangedPreview();
  const row = preview.changedProducts.find((item) => item.sku === sku);
  return { preview, row };
}

async function startRow(preview, row) {
  return startGiniChangedSync({
    confirm: true,
    previewId: preview.previewId,
    previewSignature: preview.previewSignature,
    sku: row.sku,
    expectedChanges: row.updateChanges,
  });
}

describe("GINI update contract helpers", () => {
  it("builds a quantity-only or price-only partial JSON body", () => {
    const base = {
      name: "Headphones",
      description: "Noise cancelling",
      sku: "5301ATVN",
      price: 6500,
      quantity: 10,
      security_stock: 1,
      category_id: 1,
      subcategory_id: 10,
      is_visible: 1,
      images: [{ url: "https://cdn.example/a.webp" }],
    };
    const saved = giniPayloadHash(base);
    const quantityOnly = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, quantity: 11 },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(quantityOnly.ok, true);
    assert.deepEqual(quantityOnly.changes, [{ field: "quantity", old: 10, new: 11 }]);
    assert.equal(giniPartialUpdateBody(quantityOnly.changes), '{"quantity":11}');
    const priceOnly = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, price: 7000 },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(giniPartialUpdateBody(priceOnly.changes), '{"price":7000}');
    assert.equal(priceOnly.confirmFullHash, true);
    const both = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, price: 7000, quantity: 11 },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(giniPartialUpdateBody(both.changes), '{"price":7000,"quantity":11}');
    const renamed = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, name: "Other" },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(renamed.ok, false);
    assert.equal(renamed.code, "unsupported_field_change");
    const image = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, images: [{ url: "https://cdn.example/b.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(image.ok, false);
    assert.equal(image.confirmFullHash, false);
    const mixed = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, price: 818000, images: [{ url: "https://cdn.example/b.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(mixed.ok, true);
    assert.equal(mixed.confirmFullHash, false);
    assert.equal(mixed.nextHash, "");
    assert.deepEqual(mixed.changes, [{ field: "price", old: 6500, new: 818000 }]);
    assert.equal(giniPartialUpdateBody(mixed.changes), '{"price":818000}');
    const priceAndName = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: { ...base, price: 7000, name: "Other" },
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(priceAndName.confirmFullHash, false);
    assert.equal(giniPartialUpdateBody(priceAndName.changes), '{"price":7000}');
    const same = explainGiniPriceQuantityChange({
      savedHash: saved,
      currentPayload: base,
      savedPrice: 6500,
      savedQuantity: 10,
    });
    assert.equal(same.code, "unchanged");
    for (const field of GINI_CHANGED_SYNC_FIELDS) assert.equal(GINI_PUT_DOCUMENTED_FIELDS.includes(field), true);
  });

  it("classifies image changes without inventing a missing baseline or sending a file", () => {
    const added = assessGiniImageChange({
      savedImageCount: 1,
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/b.webp"],
    });
    assert.equal(added.status, "added");
    assert.deepEqual(added.added, ["https://cdn.example/b.webp"]);
    assert.equal(added.imageWriteSupported, false);

    const removed = assessGiniImageChange({
      savedImageCount: 2,
      savedImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/b.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
    });
    assert.equal(removed.status, "removed");
    assert.deepEqual(removed.removed, ["https://cdn.example/b.webp"]);

    const replaced = assessGiniImageChange({
      savedImageCount: 2,
      savedImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/b.webp"],
      currentImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/c.webp"],
    });
    assert.equal(replaced.status, "replaced_urls");
    assert.deepEqual(replaced.added, ["https://cdn.example/c.webp"]);
    assert.deepEqual(replaced.removed, ["https://cdn.example/b.webp"]);
    assert.deepEqual(replaced.previousImages, ["https://cdn.example/a.webp", "https://cdn.example/b.webp"]);

    const content = assessGiniImageChange({
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
      savedContentFingerprints: ["sha-old"],
      currentContentFingerprints: ["sha-new"],
    });
    assert.equal(content.status, "content_changed");
    assert.equal(content.replaced[0].previousFingerprint, "sha-old");
    assert.equal(content.replaced[0].nextFingerprint, "sha-new");
    assert.equal(content.added.length, 0);

    const sameUrl = assessGiniImageChange({
      savedImageCount: 1,
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
      hashExplainedByPriceQuantity: true,
    });
    assert.equal(sameUrl.status, "urls_match_content_unverified");
    assert.equal(sameUrl.contentVerified, false);

    const missing = assessGiniImageChange({
      savedImageCount: null,
      currentImageUrls: ["https://cdn.example/a.webp"],
    });
    assert.equal(missing.status, "baseline_missing");
    assert.equal(missing.verificationNeeded, true);
    assert.deepEqual(missing.previousImages, []);
    assert.deepEqual(missing.added, []);

    const countOnly = assessGiniImageChange({
      savedImageCount: 1,
      currentImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/b.webp"],
    });
    assert.equal(countOnly.status, "count_changed_unverified");
    assert.deepEqual(countOnly.added, []);
    assert.deepEqual(countOnly.removed, []);

    const unchanged = assessGiniImageChange({
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
      savedContentFingerprints: ["sha-same"],
      currentContentFingerprints: ["sha-same"],
    });
    assert.equal(unchanged.status, "unchanged_urls");
    assert.equal(unchanged.contentVerified, true);
    assert.equal(unchanged.imageWriteSupported, false);

    const order = assessGiniImageChange({
      savedImageUrls: ["https://cdn.example/a.webp", "https://cdn.example/b.webp"],
      currentImageUrls: ["https://cdn.example/b.webp", "https://cdn.example/a.webp"],
    });
    assert.equal(order.status, "order_changed");
    assert.equal(order.orderChanged, true);
    assert.equal(order.orderSupported, false);

    const remote = assessGiniImageChange({
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
      remoteImageUrls: ["https://s3.example/products/img1.jpg"],
    });
    assert.equal(remote.remoteConflict, true);
    assert.equal(remote.imageWriteSupported, false);
  });

  it("keeps price and quantity on JSON PUT and leaves image replacement in its own request", () => {
    const signed = signGiniRequest({
      method: "POST",
      path: "/api/v2.0/third-party/products/5301ATVN",
      body: "",
      timestamp: "1700000000",
      clientSecret: SECRET,
    });
    assert.equal(signed.method, "POST");
    assert.equal(signed.body, "");
    assert.equal(signed.signature, crypto.createHmac("sha256", SECRET).update(`POST${signed.path}1700000000`).digest("hex"));
    const asPut = signGiniRequest({
      method: "PUT",
      path: signed.path,
      body: "",
      timestamp: "1700000000",
      clientSecret: SECRET,
    });
    assert.notEqual(signed.signature, asPut.signature);
    const delayed = classifyGiniImageReplacement({
      previousImages: ["https://s3.example/old.jpg"],
      deleteUrl: "https://s3.example/old.jpg",
      liveImages: ["https://s3.example/old.jpg"],
    });
    assert.equal(delayed.state, "not_applied");
    const updateSource = fs.readFileSync(new URL("./services/giniProductUpdate.js", import.meta.url), "utf8");
    assert.equal(updateSource.includes("images[]"), false);
    assert.equal(updateSource.includes("delete_images"), false);
    assert.equal(updateSource.includes('"POST"'), false);
    assert.equal(updateSource.includes('"DELETE"'), false);
    assert.equal(updateSource.includes('"PATCH"'), false);
  });

  it("rejects any verb other than PUT before a request is sent", async () => {
    await assert.rejects(
      () => performGiniJsonRequest({ method: "POST", path: GINI_PRODUCTS_PATH, rawBody: "{}" }),
      (err) => err.code === "update_method_rejected"
    );
  });
});

describe("GINI changed sync", { concurrency: 1, timeout: 120000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-product-update"));
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    installFetch();
    await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    const tested = await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    assert.equal(tested.status, "connected");
  });

  after(async () => {
    resetGiniUpdateForTests();
    disableUpdateWrites();
    setGiniFetch(null);
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    resetGiniUpdateForTests();
    disableUpdateWrites();
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    remote = new Map();
    putMode = "ok";
    installFetch();
    await Promise.all([
      Product.deleteMany({}),
      Commission.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "gini" }),
      GiniSyncJob.deleteMany({}),
      GiniSyncProductResult.deleteMany({}),
      GiniSyncSendState.deleteMany({}),
      GiniChangedPreviewSnapshot.deleteMany({}),
      GiniProductUpdateAudit.deleteMany({}),
      GiniProductUpdateJob.deleteMany({}),
      GiniProductUpdateLock.deleteMany({}),
      Partner.updateOne({ slug: "gini" }, { $set: { isActive: true } }),
    ]);
    if ((await getGiniConnectionPublic()).status !== "connected") {
      await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
      await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    }
    calls = [];
  });

  async function stage(sku, { stock = 10, price = 6500, giniProductId = "801" } = {}) {
    await mapCollection();
    const product = await makeProduct(sku, { stock, price });
    const planned = await payloadFor(product._id);
    await confirmSend(product, planned, giniProductId);
    return { product, planned };
  }

  it("keeps update writes disabled unless both update gates are exactly true", async () => {
    await assert.rejects(
      () => startGiniChangedSync({ confirm: true, sku: "5301ATVN", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }),
      (err) => err.code === "update_writes_disabled"
    );
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    await assert.rejects(() => startGiniChangedSync({ confirm: true, sku: "5301ATVN", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }), (err) => err.code === "update_writes_disabled");
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    await assert.rejects(() => startGiniChangedSync({ confirm: true, sku: "5301ATVN", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }), (err) => err.code === "update_writes_disabled");
    process.env.GINI_UPDATE_WRITES_ENABLED = "TRUE";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    await assert.rejects(() => startGiniChangedSync({ confirm: true, sku: "5301ATVN", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }), (err) => err.code === "update_writes_disabled");
    assert.equal(puts().length, 0);
  });

  it("does not update an unchanged product, a bad preview, or a historical SKU", async () => {
    enableUpdateWrites();
    const { product } = await stage("SKU-SAME", { giniProductId: "810" });
    const preview = await runGiniChangedPreview();
    assert.equal(preview.changed, 0);
    await assert.rejects(
      () =>
        startGiniChangedSync({
          confirm: true,
          previewId: preview.previewId,
          previewSignature: preview.previewSignature,
          sku: "SKU-SAME",
          expectedChanges: [{ field: "quantity", old: 10, new: 11 }],
        }),
      (err) => err.code === "not_update_eligible"
    );
    await assert.rejects(
      () => startGiniChangedSync({ confirm: true, previewId: "not-a-preview", previewSignature: "x", sku: "SKU-SAME", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }),
      (err) => err.code === "preview_required"
    );
    await assert.rejects(
      () => startGiniChangedSync({ confirm: true, sku: "LP-ID141232", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }),
      (err) => err.code === "historical_sku_unresolved"
    );
    await assert.rejects(
      () => startGiniChangedSync({ confirm: true, sku: "E6310221", expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }),
      (err) => err.code === "historical_sku_unresolved"
    );
    await assert.rejects(
      () => startGiniChangedSync({ confirm: true, scope: "all", sku: product.itemCode, expectedChanges: [{ field: "quantity", old: 10, new: 11 }] }),
      (err) => err.code === "single_product_required"
    );
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-SAME" }).lean()).payloadHash.length > 10, true);
  });

  it("sends one quantity-only PUT and stores the new hash only after the live id matches", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("5301ATVN", { stock: 10, giniProductId: "53011" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const beforeProduct = await Product.findById(product._id).lean();
    const { preview, row } = await changedRow("5301ATVN");
    assert.equal(row.updateEligible, true);
    assert.deepEqual(row.updateChanges, [{ field: "quantity", old: 10, new: 11 }]);
    calls = [];
    const result = await startRow(preview, row);
    assert.equal(result.ok, true);
    assert.equal(result.sentToGini, 1);
    assert.equal(result.method, "PUT");
    assert.equal(puts().length, 1);
    const put = puts()[0];
    assert.equal(put.body, '{"quantity":11}');
    assert.deepEqual(giniPartialUpdateKeys(put.body), ["quantity"]);
    assert.equal(headerValue(put.headers, "content-type"), "application/json");
    assert.equal(headerValue(put.headers, "idempotency-key"), "");
    assert.equal(put.url.includes(`${GINI_PRODUCTS_PATH}/5301ATVN`), true);
    const signed = signGiniRequest({
      method: "PUT",
      path: new URL(put.url).pathname,
      body: put.body,
      timestamp: headerValue(put.headers, "x-timestamp"),
      clientSecret: SECRET,
    });
    assert.equal(headerValue(put.headers, "x-signature"), signed.signature);
    assert.equal(signed.body, put.body);
    const state = await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean();
    const after = await payloadFor(product._id);
    assert.equal(state.payloadHash, after.hash);
    assert.notEqual(state.payloadHash, planned.hash);
    assert.equal(state.createPayloadHash, planned.hash);
    assert.equal(state.jobId, "confirmed-full-sync");
    assert.equal(state.giniProductId, "53011");
    assert.equal(state.sku, "5301ATVN");
    assert.ok(state.lastUpdateConfirmedAt);
    const kept = await Product.findById(product._id).lean();
    assert.equal(kept.price, beforeProduct.price);
    assert.equal(kept.variants[0].sizes[0].stockQuantity, 11);
    assert.equal(await GiniSyncProductResult.countDocuments({ classification: "CREATED" }), 1);
    const audit = await GiniProductUpdateAudit.findOne({ sku: "5301ATVN", status: "updated" }).lean();
    assert.equal(audit.method, "PUT");
    assert.equal(audit.createJobId, "confirmed-full-sync");
    assert.equal(JSON.stringify(audit).includes(SECRET), false);
    calls = [];
    await assert.rejects(() => startRow(preview, row), (err) => err.code === "payload_hash_mismatch");
    assert.equal(puts().length, 0);
  });

  it("does not upload or delete images when price, stock, and images change together", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("SKU-IMG", { stock: 10, price: 6500, giniProductId: "901" });
    await Product.updateOne(
      { _id: product._id },
      {
        $set: {
          price: 9000,
          "variants.0.sizes.0.stockQuantity": 4,
          "variants.0.images": [
            { url: "/uploads/products/patch.webp", isMain: true },
            { url: "/uploads/products/second.webp", isMain: false },
          ],
        },
      }
    );
    const { preview, row } = await changedRow("SKU-IMG");
    assert.equal(preview.imageWriteSupported, false);
    assert.equal(preview.imageOrderSupported, false);
    assert.equal(row.images.status, "count_changed_unverified");
    assert.equal(row.images.verificationNeeded, true);
    assert.equal(row.images.savedImageCount, 1);
    assert.equal(row.images.currentImageCount, 2);
    assert.deepEqual(row.images.previousImages, []);
    assert.deepEqual(row.images.added, []);
    assert.deepEqual(row.images.removed, []);
    assert.equal(row.updateEligible, true);
    assert.equal(row.imageReplacementBlocked, true);
    assert.equal(row.images.imagePairInferred, false);
    assert.deepEqual(row.images.added, []);
    assert.deepEqual(row.images.removed, []);
    assert.deepEqual(row.updateChanges.map((change) => change.field), ["price", "quantity"]);
    assert.ok(row.changes.some((change) => change.field === "imageCount" && change.old === 1 && change.new === 2));
    calls = [];
    await assert.rejects(
      () =>
        startGiniChangedSync({
          confirm: true,
          previewId: preview.previewId,
          previewSignature: preview.previewSignature,
          sku: "SKU-IMG",
          expectedChanges: [{ field: "quantity", old: 10, new: 4 }],
        }),
      (err) => err.code === "preview_mismatch"
    );
    assert.equal(puts().length, 0);
    const updated = await startRow(preview, row);
    assert.equal(updated.ok, true);
    assert.equal(updated.code, "fields_confirmed_hash_kept");
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].body, '{"price":9000,"quantity":4}');
    assert.equal(calls.some((item) => item.method === "POST" || item.method === "PATCH" || item.method === "DELETE"), false);
    const state = await GiniSyncSendState.findOne({ sku: "SKU-IMG" }).lean();
    assert.equal(state.payloadHash, planned.hash);
    assert.equal(state.createPayloadHash || "", "");
    assert.equal(state.jobId, "confirmed-full-sync");
    const created = await GiniSyncProductResult.findOne({ sku: "SKU-IMG", classification: "CREATED" }).lean();
    assert.equal(created.payloadHash, planned.hash);
    assert.equal(created.giniPrice, planned.price);
    assert.equal(created.quantity, 10);
    assert.equal(created.imageCount, 1);
    const audit = await GiniProductUpdateAudit.findOne({ sku: "SKU-IMG", status: "updated" }).lean();
    assert.equal(audit.confirmsPayloadHash, false);
    assert.equal(audit.nextPayloadHash, "");
    assert.equal(audit.kind === "image_replacement", false);
    const again = await changedRow("SKU-IMG");
    assert.equal(again.preview.sentToGini, 0);
    assert.equal(again.row.updateEligible, false);
    assert.equal(again.row.updateChanges.length, 0);
    assert.equal(again.row.images.selectionRequired, true);
    assert.equal(again.row.images.imagePairInferred, false);
    assert.equal(again.row.imageReplacementBlocked, false);
    assert.equal(again.row.changes.some((change) => change.field === "price" || change.field === "quantity"), false);
    assert.equal(again.row.changes.some((change) => change.field === "imageCount"), true);
    calls = [];
    await assert.rejects(() => startRow(preview, row), (err) => err.code === "preview_stale" || err.code === "preview_mismatch");
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-IMG" }).lean()).payloadHash, planned.hash);
  });

  it("sends a price-only PUT without quantity or other fields", async () => {
    enableUpdateWrites();
    const { product } = await stage("PRICE-1", { price: 6500, giniProductId: "820" });
    await Product.updateOne({ _id: product._id }, { $set: { price: 9000 } });
    const { preview, row } = await changedRow("PRICE-1");
    assert.deepEqual(row.updateChanges, [{ field: "price", old: 6500, new: 9000 }]);
    calls = [];
    const result = await startRow(preview, row);
    assert.equal(result.ok, true);
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].body, '{"price":9000}');
    assert.equal((await GiniSyncSendState.findOne({ sku: "PRICE-1" }).lean()).giniProductId, "820");
  });

  it("does not send when the live id differs, the product is missing, or the preview hash is stale", async () => {
    enableUpdateWrites();
    const { product } = await stage("SKU-LIVE", { stock: 10, giniProductId: "830" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const first = await changedRow("SKU-LIVE");
    remote.set(giniSkuKey("SKU-LIVE"), { ...remote.get(giniSkuKey("SKU-LIVE")), id: "999" });
    calls = [];
    await assert.rejects(() => startRow(first.preview, first.row), (err) => err.code === "confirmed_send_id_mismatch");
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-LIVE" }).lean()).payloadHash !== first.row.updateChanges, true);

    remote.set(giniSkuKey("SKU-LIVE"), { id: "830", sku: "SKU-LIVE", price: 6500, quantity: 10 });
    const second = await changedRow("SKU-LIVE");
    remote.delete(giniSkuKey("SKU-LIVE"));
    calls = [];
    await assert.rejects(() => startRow(second.preview, second.row), (err) => err.code === "confirmed_send_missing");
    assert.equal(puts().length, 0);

    remote.set(giniSkuKey("SKU-LIVE"), { id: "830", sku: "SKU-LIVE", price: 6500, quantity: 10 });
    const third = await changedRow("SKU-LIVE");
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 12 } });
    calls = [];
    await assert.rejects(() => startRow(third.preview, third.row), (err) => err.code === "preview_stale" || err.code === "preview_mismatch");
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-LIVE" }).lean()).giniProductId, "830");
  });

  it("records authentication and validation failures without a second PUT or a new hash", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("SKU-AUTH", { stock: 10, giniProductId: "840" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 4 } });
    const authPreview = await changedRow("SKU-AUTH");
    putMode = "auth";
    calls = [];
    const auth = await startRow(authPreview.preview, authPreview.row);
    assert.equal(auth.ok, false);
    assert.equal(auth.code, "auth_failed");
    assert.equal(puts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-AUTH" }).lean()).payloadHash, planned.hash);

    putMode = "rejected";
    const rejectedPreview = await changedRow("SKU-AUTH");
    calls = [];
    const rejected = await startRow(rejectedPreview.preview, rejectedPreview.row);
    assert.equal(rejected.code, "update_rejected");
    assert.equal(puts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-AUTH" }).lean()).payloadHash, planned.hash);
  });

  it("reconciles a lost response before any later PUT", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("SKU-TIME", { stock: 10, giniProductId: "850" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-TIME");
    putMode = "timeout";
    calls = [];
    const lost = await startRow(preview.preview, preview.row);
    assert.equal(lost.ok, false);
    assert.equal(lost.reconciled, true);
    assert.equal(lost.code, "update_not_applied");
    assert.equal(puts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-TIME" }).lean()).payloadHash, planned.hash);

    putMode = "ok";
    calls = [];
    const again = await startRow(preview.preview, preview.row);
    assert.equal(again.ok, true);
    assert.equal(puts().length, 1);
    const after = await payloadFor(product._id);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-TIME" }).lean()).payloadHash, after.hash);
  });

  it("confirms a lost response from the live product without sending a second PUT", async () => {
    enableUpdateWrites();
    const { product } = await stage("SKU-RECOVER", { stock: 10, giniProductId: "860" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-RECOVER");
    putMode = "timeout-applied";
    calls = [];
    const result = await startRow(preview.preview, preview.row);
    assert.equal(result.ok, true);
    assert.equal(result.reconciled, true);
    assert.equal(puts().length, 1);
    const after = await payloadFor(product._id);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-RECOVER" }).lean()).payloadHash, after.hash);
  });

  it("does not send again while a lost update is still ambiguous", async () => {
    enableUpdateWrites();
    const { planned } = await stage("SKU-AMBIG", { stock: 10, giniProductId: "870" });
    const product = await Product.findOne({ itemCode: "SKU-AMBIG" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-AMBIG");
    putMode = "timeout-ambiguous";
    const lost = await startRow(preview.preview, preview.row);
    assert.equal(lost.code, "update_uncertain");
    calls = [];
    putMode = "ok";
    const second = await startRow(preview.preview, preview.row);
    assert.equal(second.ok, false);
    assert.equal(second.code, "update_uncertain");
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-AMBIG" }).lean()).payloadHash, planned.hash);
  });

  it("waits out a rate limit and does not retry inside the failed attempt", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("SKU-RATE", { stock: 10, giniProductId: "880" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-RATE");
    putMode = "rate";
    calls = [];
    const limited = await startRow(preview.preview, preview.row);
    assert.equal(limited.code, "rate_limited");
    assert.equal(puts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-RATE" }).lean()).payloadHash, planned.hash);
    calls = [];
    await assert.rejects(() => startRow(preview.preview, preview.row), (err) => err.code === "rate_limited");
    assert.equal(puts().length, 0);
    await GiniProductUpdateAudit.updateMany({ sku: "SKU-RATE", status: "rate_limited" }, { $set: { retryUntil: new Date(Date.now() - 1000) } });
    putMode = "ok";
    calls = [];
    const later = await startRow(preview.preview, preview.row);
    assert.equal(later.ok, true);
    assert.equal(puts().length, 1);
  });

  it("pauses before the PUT and can resume or stop", async () => {
    enableUpdateWrites();
    const { product } = await stage("SKU-PAUSE", { stock: 10, giniProductId: "890" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-PAUSE");
    setGiniUpdateBeforeSend(async () => {
      await pauseGiniChangedSync();
    });
    calls = [];
    const paused = await startRow(preview.preview, preview.row);
    assert.equal(paused.code, "paused");
    assert.equal(puts().length, 0);
    setGiniUpdateBeforeSend(null);
    calls = [];
    const resumed = await resumeGiniChangedSync();
    assert.equal(resumed.ok, true);
    assert.equal(puts().length, 1);

    const other = await stage("SKU-STOP", { stock: 10, giniProductId: "891" });
    await Product.updateOne({ _id: other.product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 3 } });
    const stopPreview = await changedRow("SKU-STOP");
    setGiniUpdateBeforeSend(async () => {
      await stopGiniChangedSync();
    });
    calls = [];
    const stopped = await startRow(stopPreview.preview, stopPreview.row);
    assert.equal(stopped.code, "stopped");
    assert.equal(puts().length, 0);
    setGiniUpdateBeforeSend(null);
    await assert.rejects(() => resumeGiniChangedSync(), (err) => err.code === "not_paused");
  });

  it("does not run a second update while one is in progress", async () => {
    enableUpdateWrites();
    const { product } = await stage("SKU-ONCE", { stock: 10, giniProductId: "900" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const preview = await changedRow("SKU-ONCE");
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = new Promise((resolve) => {
      entered = resolve;
    });
    setGiniUpdateBeforeSend(async () => {
      entered();
      await gate;
    });
    const first = startRow(preview.preview, preview.row);
    await seen;
    await assert.rejects(() => startRow(preview.preview, preview.row), (err) => err.code === "update_in_progress");
    release();
    const result = await first;
    assert.equal(result.ok, true);
    assert.equal(puts().filter((item) => item.url.includes("SKU-ONCE")).length, 1);
  });

  it("keeps confirmed price and quantity after a successful update without rewriting create history", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("LIFE-10", { stock: 10, price: 6500, giniProductId: "910" });
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const first = await changedRow("LIFE-10");
    assert.deepEqual(first.row.updateChanges, [{ field: "quantity", old: 10, new: 11 }]);
    calls = [];
    const updated = await startRow(first.preview, first.row);
    assert.equal(updated.ok, true);
    assert.equal(puts().length, 1);

    const created = await GiniSyncProductResult.findOne({ sku: "LIFE-10", classification: "CREATED" }).lean();
    assert.equal(created.payloadHash, planned.hash);
    assert.equal(created.quantity, 10);
    assert.equal(created.giniPrice, planned.price);
    assert.equal(created.imageCount, 1);
    const confirmed = await GiniSyncSendState.findOne({ sku: "LIFE-10" }).lean();
    const quantityHash = confirmed.payloadHash;
    assert.notEqual(quantityHash, planned.hash);
    assert.equal(confirmed.createPayloadHash, planned.hash);
    assert.equal(confirmed.jobId, "confirmed-full-sync");
    assert.equal(confirmed.giniProductId, "910");
    assert.equal(await GiniSyncProductResult.countDocuments({ sku: "LIFE-10", classification: "CREATED" }), 1);

    const settled = await runGiniChangedPreview();
    assert.equal(settled.changedProducts.some((row) => row.sku === "LIFE-10"), false);

    await GiniProductUpdateAudit.create({
      partner: "gini",
      sku: "LIFE-10",
      skuKey: giniSkuKey("LIFE-10"),
      giniProductId: "910",
      kind: "json_put",
      method: "PUT",
      status: "pending",
      requestSent: true,
      previousPayloadHash: quantityHash,
      nextPayloadHash: "pending-hash",
      changes: [{ field: "quantity", old: 11, new: 50 }],
      body: { quantity: 50 },
    });
    await GiniProductUpdateAudit.create({
      partner: "gini",
      sku: "LIFE-10",
      skuKey: giniSkuKey("LIFE-10"),
      giniProductId: "910",
      kind: "json_put",
      method: "PUT",
      status: "uncertain",
      requestSent: true,
      previousPayloadHash: quantityHash,
      nextPayloadHash: "uncertain-hash",
      changes: [{ field: "quantity", old: 11, new: 40 }],
      body: { quantity: 40 },
    });

    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 12 } });
    const quantityPreview = await changedRow("LIFE-10");
    assert.equal(quantityPreview.row.fieldsCompared, true);
    assert.equal(quantityPreview.row.updateEligible, true);
    assert.deepEqual(quantityPreview.row.updateChanges, [{ field: "quantity", old: 11, new: 12 }]);
    assert.equal(quantityPreview.row.changes.some((change) => change.field === "quantity" && change.old === 10), false);

    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11, price: 9000 } });
    const pricePreview = await changedRow("LIFE-10");
    assert.equal(pricePreview.row.updateEligible, true);
    assert.deepEqual(pricePreview.row.updateChanges, [{ field: "price", old: planned.price, new: 9000 }]);
    assert.equal(pricePreview.row.changes.some((change) => change.field === "quantity"), false);

    await Product.updateOne({
      _id: product._id,
      }, {
      $set: {
        price: 6500,
        "variants.0.images": [{ url: "/uploads/products/next.webp", isMain: true }],
      },
    });
    await GiniProductUpdateAudit.create({
      partner: "gini",
      sku: "LIFE-10",
      skuKey: giniSkuKey("LIFE-10"),
      giniProductId: "910",
      kind: "image_replacement",
      method: "POST",
      status: "reconciled_applied",
      requestSent: true,
      errorCode: "image_verified_hash_kept",
      previousPayloadHash: quantityHash,
      nextPayloadHash: "",
      changes: [{ field: "quantity", old: 11, new: 99 }],
      body: { quantity: 99 },
    });
    const imagePreview = await changedRow("LIFE-10");
    assert.equal(imagePreview.row.fieldsCompared, true);
    assert.equal(imagePreview.row.updateEligible, false);
    assert.equal(imagePreview.row.updateBlocker, "unsupported_field_change");
    assert.equal(imagePreview.row.imageReplacementBlocked, false);
    assert.equal(imagePreview.row.imageReplacementBlocker, "");
    assert.equal(imagePreview.row.images.savedImageCount, 1);
    assert.equal(imagePreview.row.images.currentImageCount, 1);
    assert.equal(imagePreview.row.images.selectionRequired, true);
    assert.equal(imagePreview.row.changes.some((change) => change.field === "quantity"), false);
    assert.equal(imagePreview.row.changes.some((change) => change.field === "price"), false);

    await Product.updateOne({
      _id: product._id,
      }, {
      $set: {
        "variants.0.images": [{ url: "/uploads/products/patch.webp", isMain: true }],
        "variants.0.sizes.0.stockQuantity": 12,
      },
    });
    const rejectedPreview = await changedRow("LIFE-10");
    assert.deepEqual(rejectedPreview.row.updateChanges, [{ field: "quantity", old: 11, new: 12 }]);
    putMode = "rejected";
    calls = [];
    const rejected = await startRow(rejectedPreview.preview, rejectedPreview.row);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "update_rejected");
    assert.equal((await GiniSyncSendState.findOne({ sku: "LIFE-10" }).lean()).payloadHash, quantityHash);

    putMode = "timeout";
    const lostPreview = await changedRow("LIFE-10");
    calls = [];
    const lost = await startRow(lostPreview.preview, lostPreview.row);
    assert.equal(lost.ok, false);
    assert.equal(lost.code, "update_not_applied");
    assert.equal((await GiniSyncSendState.findOne({ sku: "LIFE-10" }).lean()).payloadHash, quantityHash);

    putMode = "timeout-ambiguous";
    const uncertainPreview = await changedRow("LIFE-10");
    calls = [];
    const uncertain = await startRow(uncertainPreview.preview, uncertainPreview.row);
    assert.equal(uncertain.ok, false);
    assert.equal(uncertain.code, "update_uncertain");
    const finalState = await GiniSyncSendState.findOne({ sku: "LIFE-10" }).lean();
    assert.equal(finalState.payloadHash, quantityHash);
    assert.equal(finalState.createPayloadHash, planned.hash);
    assert.equal(finalState.giniProductId, "910");
    assert.equal(finalState.jobId, "confirmed-full-sync");
    const stillOriginal = await GiniSyncProductResult.findOne({ sku: "LIFE-10", classification: "CREATED" }).lean();
    assert.equal(stillOriginal.payloadHash, planned.hash);
    assert.equal(stillOriginal.quantity, 10);
    assert.equal(stillOriginal.giniPrice, planned.price);
    const afterFailures = await changedRow("LIFE-10");
    assert.equal(afterFailures.row.updateEligible, true);
    assert.deepEqual(afterFailures.row.updateChanges, [{ field: "quantity", old: 11, new: 12 }]);
  });

  it("sends one price PUT for a same-count image change and leaves that image pending", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("5301ATVN", { price: 818500, stock: 10, giniProductId: "53011" });
    await Product.updateOne(
      { _id: product._id },
      { $set: { price: 818000, "variants.0.images": [{ url: "/uploads/products/next.webp", isMain: true }] } }
    );
    const first = await changedRow("5301ATVN");
    const second = await changedRow("5301ATVN");
    assert.equal(first.preview.sentToGini, 0);
    assert.equal(second.preview.sentToGini, 0);
    assert.deepEqual(first.row.updateChanges, second.row.updateChanges);
    assert.equal(first.row.updateEligible, true);
    assert.deepEqual(first.row.updateChanges, [{ field: "price", old: 818500, new: 818000 }]);
    assert.equal(first.row.images.status, "unattributed_unverified");
    assert.equal(first.row.images.verificationNeeded, true);
    assert.equal(first.row.images.selectionRequired, true);
    assert.equal(first.row.images.imagePairInferred, false);
    assert.equal(first.row.images.savedImageCount, 1);
    assert.equal(first.row.images.currentImageCount, 1);
    assert.deepEqual(first.row.images.previousImages, []);
    assert.deepEqual(first.row.images.added, []);
    assert.deepEqual(first.row.images.removed, []);
    assert.equal(first.row.imageReplacementBlocked, true);
    assert.equal(first.row.imageReplacementBlocker, "unrelated_field_unsynced");
    calls = [];
    const updated = await startRow(first.preview, first.row);
    assert.equal(updated.ok, true);
    assert.equal(updated.code, "fields_confirmed_hash_kept");
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].body, '{"price":818000}');
    assert.deepEqual(giniPartialUpdateKeys(puts()[0].body), ["price"]);
    assert.equal(calls.some((item) => item.method !== "GET" && item.method !== "PUT"), false);
    const state = await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean();
    assert.equal(state.payloadHash, planned.hash);
    assert.equal(state.createPayloadHash || "", "");
    assert.equal(state.giniProductId, "53011");
    assert.equal(state.jobId, "confirmed-full-sync");
    const created = await GiniSyncProductResult.findOne({ sku: "5301ATVN", classification: "CREATED" }).lean();
    assert.equal(created.payloadHash, planned.hash);
    assert.equal(created.giniPrice, 818500);
    assert.equal(created.quantity, 10);
    assert.equal(created.imageCount, 1);
    const pending = await changedRow("5301ATVN");
    assert.equal(pending.preview.sentToGini, 0);
    assert.equal(pending.row.classification, "CHANGED");
    assert.equal(pending.row.updateEligible, false);
    assert.deepEqual(pending.row.updateChanges, []);
    assert.equal(pending.row.changes.some((change) => change.field === "price"), false);
    assert.equal(pending.row.images.verificationNeeded, true);
    assert.equal(pending.row.images.selectionRequired, true);
    assert.equal(pending.row.images.imagePairInferred, false);
    assert.equal(pending.row.imageReplacementBlocked, false);
    calls = [];
    await assert.rejects(() => startRow(first.preview, first.row), (err) => err.code === "preview_stale" || err.code === "preview_mismatch");
    await assert.rejects(() => startRow(second.preview, second.row), (err) => err.code === "preview_stale" || err.code === "preview_mismatch");
    assert.equal(puts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean()).payloadHash, planned.hash);
    assert.equal(await GiniSyncProductResult.countDocuments({ sku: "5301ATVN", classification: "CREATED" }), 1);
  });

  it("a failed price update leaves the mixed price and image change pending", async () => {
    enableUpdateWrites();
    const { product, planned } = await stage("5301ATVN", { price: 818500, stock: 4, giniProductId: "53011" });
    await Product.updateOne(
      { _id: product._id },
      { $set: { price: 818000, "variants.0.images": [{ url: "/uploads/products/next.webp", isMain: true }] } }
    );
    const preview = await changedRow("5301ATVN");
    putMode = "rejected";
    calls = [];
    const rejected = await startRow(preview.preview, preview.row);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "update_rejected");
    assert.equal(puts().length, 1);
    assert.equal(puts()[0].body, '{"price":818000}');
    const state = await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean();
    assert.equal(state.payloadHash, planned.hash);
    assert.equal(state.lastUpdateAuditId || "", "");
    const audit = await GiniProductUpdateAudit.findOne({ sku: "5301ATVN", requestSent: true }).lean();
    assert.equal(audit.status, "failed");
    assert.equal(audit.confirmsPayloadHash, false);
    const created = await GiniSyncProductResult.findOne({ sku: "5301ATVN", classification: "CREATED" }).lean();
    assert.equal(created.giniPrice, 818500);
    assert.equal(created.payloadHash, planned.hash);
    const still = await changedRow("5301ATVN");
    assert.equal(still.row.updateEligible, true);
    assert.deepEqual(still.row.updateChanges, [{ field: "price", old: 818500, new: 818000 }]);
    assert.equal(still.row.images.verificationNeeded, true);
    assert.equal(still.row.images.selectionRequired, true);
    assert.equal(still.row.imageReplacementBlocked, true);
    assert.equal(still.preview.sentToGini, 0);
    calls = [];
    const repeated = await runGiniChangedPreview();
    assert.equal(repeated.sentToGini, 0);
    assert.equal(puts().length, 0);
    assert.equal(calls.some((item) => item.method === "POST" || item.method === "PATCH" || item.method === "DELETE"), false);
  });

  it("does not enable update gates in source or environment files", () => {
    const source = fs.readFileSync(new URL("./services/giniProductUpdate.js", import.meta.url), "utf8");
    const page = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniSyncAll.jsx", import.meta.url), "utf8");
    assert.equal(source.includes('method: "POST"'), false);
    assert.equal(source.includes('method: "DELETE"'), false);
    assert.equal(source.includes('method: "PATCH"'), false);
    assert.equal(source.includes('method: "PUT"'), true);
    assert.equal(page.includes('scope: "changed"'), false);
    assert.equal(page.includes("process.env"), false);
    for (const name of ["../.env", "../.env.local", "../.env.example", "./.env", "./.env.local", "./.env.example"]) {
      const file = new URL(name, import.meta.url);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      assert.equal(/GINI_UPDATE_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_UPDATE_WRITES\s*=\s*true/.test(text), false);
    }
  });
});
