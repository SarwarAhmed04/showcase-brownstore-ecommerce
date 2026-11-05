import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { translations } from "../../client/src/i18n.js";
import { canReplaceGiniImage, giniImageSelectionRequired } from "../../client/src/components/admin/platform/giniSyncAllDisplay.js";
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
import { GINI_DEFAULT_BASE_URL, getGiniConnectionPublic, saveGiniConnection, setGiniFetch, testGiniConnection } from "./services/giniConnection.js";
import { setGiniMediaFetch } from "./services/giniSyncOne.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { toResolvedProduct } from "./utils/productView.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "./utils/platformTaxonomy.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "./utils/giniSyncOnePlan.js";
import { buildGiniPlanFromParts, giniPayloadHash, mappingFromTree } from "./utils/giniSyncEvaluate.js";
import {
  assessGiniImageChange,
  classifyGiniImageReplacement,
  giniImageReplacementIsolation,
  giniImageWritesEnabled,
} from "./utils/giniProductUpdateContract.js";
import { runGiniChangedPreview } from "./services/giniSyncAll.js";
import { startGiniChangedSync } from "./services/giniProductUpdate.js";
import {
  buildGiniImageReplacementForm,
  reconcileGiniImageReplacement,
  resolveGiniImageReplacement,
  startGiniImageReplacement,
} from "./services/giniImageReplacement.js";

const CLIENT_ID = "gini-image-client";
const SECRET = "gini-image-secret-not-for-the-browser";
const OLD = "https://s3.example/products/old.jpg";
const OTHER = "https://s3.example/products/keep.jpg";
const NEW = "https://s3.example/products/new.jpg";
const SOURCE = "https://api.brownstore.net/api/media/uploads/products/next.webp";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
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
let imageMode;
let mediaMode;
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

function headerValue(headers, name) {
  const found = Object.keys(headers || {}).find((key) => key.toLowerCase() === name.toLowerCase());
  return found ? headers[found] : "";
}

function skuFromProductUrl(target) {
  const path = String(target).split("?")[0];
  const marker = "/products/";
  const index = path.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(path.slice(index + marker.length));
}

function installFetch() {
  calls = [];
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push({ method, url: target, body: options.body, headers: options.headers });
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, LIVE_TREE);
    if (method === "GET" && target.includes("/products?")) {
      return mockResponse(200, { data: [], meta: { last_page: 1, total: 0 } });
    }
    if (!target.includes("/products/")) throw new Error(`unexpected ${method} ${target}`);
    const key = giniSkuKey(skuFromProductUrl(target));
    const found = remote.get(key);
    if (method === "GET") {
      if (!found) return mockResponse(404, { message: "Product not found." });
      return mockResponse(200, { data: { id: found.id, sku: found.sku, price: found.price, quantity: found.quantity, images: found.images } });
    }
    if (method === "PUT") {
      if (!found) return mockResponse(404, { message: "Product not found." });
      const sent = JSON.parse(String(options.body || "{}"));
      if (putMode === "rejected") return mockResponse(422, { message: "The price field is invalid." });
      const next = { ...found, price: sent.price ?? found.price, quantity: sent.quantity ?? found.quantity };
      remote.set(key, next);
      return mockResponse(200, { data: { id: found.id, sku: found.sku, price: next.price, quantity: next.quantity, images: next.images } });
    }
    if (method !== "POST") throw new Error(`Unexpected GINI method ${method}`);
    if (imageMode === "auth") return mockResponse(401, { message: "unauthorized" });
    if (imageMode === "rejected") return mockResponse(422, { message: "rejected" });
    if (imageMode === "rate") return mockResponse(429, { message: "slow" }, { "retry-after": "120" });
    if (imageMode === "created") return mockResponse(201, { data: { id: found.id, sku: found.sku } });
    if (imageMode === "timeout") {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      throw error;
    }
    if (imageMode === "server") return mockResponse(500, { message: "down" });
    if (imageMode === "verified") found.images = found.nextImages || [NEW];
    else if (imageMode === "deleted") found.images = (found.images || []).filter((url) => url !== OLD);
    else if (imageMode === "extra") found.images = [...(found.images || []), NEW];
    return mockResponse(200, { data: { id: found.id, sku: found.sku } });
  });
}

function installMedia() {
  setGiniMediaFetch(async () => {
    if (mediaMode === "big") {
      return {
        status: 200,
        headers: {
          get: (name) => (String(name).toLowerCase() === "content-length" ? String(6 * 1024 * 1024) : String(name).toLowerCase() === "content-type" ? "image/png" : null),
        },
        async arrayBuffer() {
          return PNG;
        },
      };
    }
    if (mediaMode === "bad") {
      return {
        status: 200,
        headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "text/plain" : null) },
        async arrayBuffer() {
          return Buffer.from("not-an-image");
        },
      };
    }
    return {
      status: 200,
      headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : null) },
      async arrayBuffer() {
        return PNG;
      },
    };
  });
}

function posts() {
  return calls.filter((item) => item.method === "POST" && item.url.includes("/products/"));
}

function simpleVariant(stock = 10, image = "/uploads/products/patch.webp") {
  return [
    {
      color: { en: "white", ar: "", ku: "" },
      images: [{ url: image, isMain: true }],
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
    isActive: true,
    variants: overrides.variants || simpleVariant(overrides.stock ?? 10),
  });
}

async function mapCollection() {
  await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner: "gini", brownCollectionId: "col-acne" },
    { $set: { values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" } } },
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

async function confirmSend(product, planned, giniProductId, images = [OLD]) {
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
    images: [...images],
    nextImages: [NEW],
  });
}

function enableUpdateWrites() {
  process.env.GINI_UPDATE_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
}

function enableImageWrites() {
  process.env.GINI_IMAGE_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_IMAGE_WRITES = "true";
}

function disableImageWrites() {
  delete process.env.GINI_IMAGE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_IMAGE_WRITES;
}

async function stage(sku, images = [OLD]) {
  await mapCollection();
  const product = await makeProduct(sku);
  const planned = await payloadFor(product._id);
  await confirmSend(product, planned, "88001", images);
  await Product.updateOne({ _id: product._id }, { $set: { variants: simpleVariant(10, "/uploads/products/next.webp") } });
  return { product, planned };
}

async function changedRow(sku) {
  const preview = await runGiniChangedPreview();
  return { preview, row: preview.changedProducts.find((item) => item.sku === sku) };
}

function startImage(preview, sku, urls = {}) {
  return startGiniImageReplacement({
    confirm: true,
    previewId: preview.previewId,
    previewSignature: preview.previewSignature,
    sku,
    deleteImageUrl: urls.deleteImageUrl === undefined ? OLD : urls.deleteImageUrl,
    replacementImageUrl: urls.replacementImageUrl === undefined ? SOURCE : urls.replacementImageUrl,
  });
}

describe("GINI image replacement contract", () => {
  it("enables Replace one image only when the returned selection flag and both URLs are present", () => {
    const preview = {
      previewId: "preview",
      previewSignature: "signature",
      updatesSupported: true,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    };
    const remoteUrl = "https://cdn.example/products/old.jpg";
    const sourceUrl = "https://api.brownstore.net/api/media/uploads/products/next.webp";
    const omittedFlag = {
      sku: "5301ATVN",
      identityMatched: true,
      giniProductId: "566640",
      liveGiniProductId: "566640",
      imageReplacementBlocked: false,
      images: { selectionRequired: true, remoteImages: [remoteUrl], currentImages: [sourceUrl] },
    };
    assert.equal(giniImageSelectionRequired(omittedFlag), true);
    assert.equal(giniImageSelectionRequired({ imageSelectionRequired: false, images: { selectionRequired: true } }), false);
    assert.equal(
      canReplaceGiniImage({
        imageWritesEnabled: true,
        preview,
        row: omittedFlag,
        deleteImageUrl: remoteUrl,
        replacementImageUrl: sourceUrl,
      }),
      true
    );
    assert.equal(
      canReplaceGiniImage({
        imageWritesEnabled: true,
        preview,
        row: omittedFlag,
        deleteImageUrl: "",
        replacementImageUrl: sourceUrl,
      }),
      false
    );
    assert.equal(
      canReplaceGiniImage({
        imageWritesEnabled: false,
        preview,
        row: { ...omittedFlag, imageSelectionRequired: true },
        deleteImageUrl: remoteUrl,
        replacementImageUrl: sourceUrl,
      }),
      false
    );
    assert.equal(
      canReplaceGiniImage({
        imageWritesEnabled: true,
        preview,
        row: { ...omittedFlag, imageReplacementBlocked: true, imageSelectionRequired: true },
        deleteImageUrl: remoteUrl,
        replacementImageUrl: sourceUrl,
      }),
      false
    );
  });

  it("classifies delayed, verified, and conflicting image lists without guessing", () => {
    assert.equal(classifyGiniImageReplacement({ previousImages: [OLD, OTHER], deleteUrl: OLD, liveImages: [OLD, OTHER] }).state, "not_applied");
    assert.equal(classifyGiniImageReplacement({ previousImages: [OLD, OTHER], deleteUrl: OLD, liveImages: [OTHER] }).state, "pending_verification");
    const verified = classifyGiniImageReplacement({ previousImages: [OLD, OTHER], deleteUrl: OLD, liveImages: [OTHER, NEW] });
    assert.equal(verified.state, "verified");
    assert.equal(verified.addedUrl, NEW);
    assert.equal(classifyGiniImageReplacement({ previousImages: [OLD, OTHER], deleteUrl: OLD, liveImages: [OLD, OTHER, NEW] }).state, "uncertain");
    assert.equal(classifyGiniImageReplacement({ previousImages: [OLD, OTHER], deleteUrl: OLD, liveImages: [NEW] }).state, "uncertain");
    const form = buildGiniImageReplacementForm({ deleteImageUrl: OLD, file: { blob: new Blob([PNG], { type: "image/png" }), filename: "image-1.png" } });
    const entries = [...form.entries()];
    assert.deepEqual(entries.map((entry) => entry[0]), ["_method", "delete_images[]", "images[]"]);
    assert.equal(entries[0][1], "PUT");
    assert.equal(entries[1][1], OLD);
    assert.equal(entries.length, 3);

    const savedPayload = {
      name: "Name",
      description: "Description",
      sku: "IMG-1",
      price: 6500,
      quantity: 10,
      security_stock: 1,
      category_id: 1,
      subcategory_id: 10,
      is_visible: 1,
      images: [{ url: "https://cdn.example/old.webp" }],
    };
    const savedHash = giniPayloadHash(savedPayload);
    const imageOnly = giniImageReplacementIsolation({
      savedHash,
      currentPayload: { ...savedPayload, images: [{ url: "https://cdn.example/new.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
      savedImageUrls: ["https://cdn.example/old.webp"],
    });
    assert.equal(imageOnly.confirmHash, true);
    assert.equal(imageOnly.block, false);
    const withQuantity = giniImageReplacementIsolation({
      savedHash,
      currentPayload: { ...savedPayload, quantity: 11, images: [{ url: "https://cdn.example/new.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
      savedImageUrls: ["https://cdn.example/old.webp"],
    });
    assert.equal(withQuantity.block, true);
    assert.equal(withQuantity.code, "unrelated_field_unsynced");
    assert.equal(withQuantity.confirmHash, false);
    const withPrice = giniImageReplacementIsolation({
      savedHash,
      currentPayload: { ...savedPayload, price: 9000, images: [{ url: "https://cdn.example/new.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
      savedImageUrls: ["https://cdn.example/old.webp"],
    });
    assert.equal(withPrice.code, "unrelated_field_unsynced");
    const withName = giniImageReplacementIsolation({
      savedHash,
      currentPayload: { ...savedPayload, name: "Other", images: [{ url: "https://cdn.example/new.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
      savedImageUrls: ["https://cdn.example/old.webp"],
    });
    assert.equal(withName.block, true);
    assert.equal(withName.confirmHash, false);
    const noBaseline = giniImageReplacementIsolation({
      savedHash,
      currentPayload: { ...savedPayload, images: [{ url: "https://cdn.example/new.webp" }] },
      savedPrice: 6500,
      savedQuantity: 10,
      savedImageUrls: null,
    });
    assert.equal(noBaseline.block, false);
    assert.equal(noBaseline.confirmHash, false);

    const sameAddress = assessGiniImageChange({
      savedImageCount: 1,
      currentImageUrls: ["https://cdn.example/a.webp"],
      hashExplainedByPriceQuantity: true,
    });
    assert.equal(sameAddress.status, "urls_match_content_unverified");
    assert.equal(sameAddress.byteChangesDetectable, false);
    assert.equal(sameAddress.historicalImageBaseline, false);
    assert.equal(sameAddress.selectionRequired, false);
    assert.equal(sameAddress.contentVerified, false);
    assert.equal(sameAddress.imagePairInferred, false);
    const fingerprinted = assessGiniImageChange({
      savedImageUrls: ["https://cdn.example/a.webp"],
      currentImageUrls: ["https://cdn.example/a.webp"],
      savedContentFingerprints: ["sha-old"],
      currentContentFingerprints: ["sha-new"],
    });
    assert.equal(fingerprinted.status, "content_changed");
    assert.equal(fingerprinted.byteChangesDetectable, true);
    assert.equal(fingerprinted.selectionRequired, true);
    assert.equal(fingerprinted.historicalImageBaseline, true);
  });
});

describe("GINI image replacement", { concurrency: 1, timeout: 120000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-image-replacement"));
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    installFetch();
    installMedia();
    await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    const tested = await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    assert.equal(tested.status, "connected");
  });

  after(async () => {
    disableImageWrites();
    delete process.env.GINI_UPDATE_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    setGiniFetch(null);
    setGiniMediaFetch(null);
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    disableImageWrites();
    delete process.env.GINI_UPDATE_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    remote = new Map();
    imageMode = "delayed";
    mediaMode = "ok";
    putMode = "ok";
    installFetch();
    installMedia();
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
    ]);
    if ((await getGiniConnectionPublic()).status !== "connected") {
      await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
      await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    }
    calls = [];
  });

  it("keeps image writes off for bulk flags, price flags, and inexact values", async () => {
    await assert.rejects(() => startGiniImageReplacement({ confirm: true, sku: "IMG-1", deleteImageUrl: OLD, replacementImageUrl: SOURCE }), (err) => err.code === "image_writes_disabled");
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    await assert.rejects(() => startGiniImageReplacement({ confirm: true, sku: "IMG-1", deleteImageUrl: OLD, replacementImageUrl: SOURCE }), (err) => err.code === "image_writes_disabled");
    process.env.GINI_IMAGE_WRITES_ENABLED = "TRUE";
    process.env.GINI_ALLOW_LIVE_IMAGE_WRITES = "true";
    assert.equal(giniImageWritesEnabled(), false);
    await assert.rejects(() => startGiniImageReplacement({ confirm: true, sku: "IMG-1", deleteImageUrl: OLD, replacementImageUrl: SOURCE }), (err) => err.code === "image_writes_disabled");
    assert.equal(posts().length, 0);
  });

  it("does not invent an image pair from a missing baseline or a count change", async () => {
    enableImageWrites();
    const { product, planned } = await stage("IMG-BASE");
    await Product.updateOne(
      { _id: product._id },
      {
        $set: {
          variants: [
            {
              color: { en: "white", ar: "", ku: "" },
              images: [
                { url: "/uploads/products/next.webp", isMain: true },
                { url: "/uploads/products/second.webp", isMain: false },
              ],
              sizes: [{ size: "medium", stockQuantity: 10 }],
            },
          ],
        },
      }
    );
    const { preview, row } = await changedRow("IMG-BASE");
    assert.equal(preview.imageContractVerified, true);
    assert.equal(preview.imageWritesEnabled, true);
    assert.equal(preview.imageWriteSupported, false);
    assert.equal(row.images.status, "count_changed_unverified");
    assert.equal(row.images.imagePairInferred, false);
    assert.equal(row.images.selectionRequired, true);
    assert.deepEqual(row.images.added, []);
    assert.deepEqual(row.images.removed, []);
    assert.deepEqual(row.images.previousImages, []);
    assert.deepEqual(row.images.remoteImages, [OLD]);
    assert.equal(row.updateEligible, false);
    calls = [];
    await assert.rejects(() => startImage(preview, "IMG-BASE", { deleteImageUrl: "", replacementImageUrl: "" }), (err) => err.code === "single_image_required");
    await assert.rejects(
      () => startGiniImageReplacement({ confirm: true, previewId: preview.previewId, previewSignature: preview.previewSignature, sku: "IMG-BASE", deleteImageUrl: [OLD, OTHER], replacementImageUrl: SOURCE }),
      (err) => err.code === "single_image_required"
    );
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-BASE" }).lean()).payloadHash, planned.hash);
  });

  it("signs one POST with an empty body and sends the exact live URL plus one file", async () => {
    enableImageWrites();
    const { product, planned } = await stage("IMG-ONE", [OLD, OTHER]);
    remote.get(giniSkuKey("IMG-ONE")).nextImages = [OTHER, NEW];
    imageMode = "verified";
    const before = await Product.findById(product._id).lean();
    const { preview, row } = await changedRow("IMG-ONE");
    assert.equal(row.images.selectionRequired, true);
    assert.equal(row.imageSelectionRequired, true);
    assert.equal(row.images.remoteImages.includes(OLD), true);
    assert.equal(
      canReplaceGiniImage({
        imageWritesEnabled: true,
        preview,
        row,
        deleteImageUrl: OLD,
        replacementImageUrl: SOURCE,
      }),
      true
    );
    calls = [];
    const result = await startImage(preview, "IMG-ONE");
    assert.equal(result.ok, true);
    assert.equal(result.sentToGini, 1);
    assert.equal(result.method, "POST");
    assert.equal(posts().length, 1);
    const post = posts()[0];
    assert.equal(post.method, "POST");
    assert.equal(headerValue(post.headers, "content-type"), "");
    assert.equal(headerValue(post.headers, "idempotency-key"), "");
    const signed = signGiniRequest({
      method: "POST",
      path: new URL(post.url).pathname,
      body: "",
      timestamp: headerValue(post.headers, "x-timestamp"),
      clientSecret: SECRET,
    });
    assert.equal(headerValue(post.headers, "x-signature"), signed.signature);
    const putSignature = signGiniRequest({
      method: "PUT",
      path: signed.path,
      body: "",
      timestamp: headerValue(post.headers, "x-timestamp"),
      clientSecret: SECRET,
    });
    assert.notEqual(signed.signature, putSignature.signature);
    const entries = [...post.body.entries()];
    assert.deepEqual(
      entries.map((entry) => entry[0]),
      ["_method", "delete_images[]", "images[]"]
    );
    assert.equal(entries[0][1], "PUT");
    assert.equal(entries[1][1], OLD);
    assert.equal(entries.filter((entry) => entry[0] === "delete_images[]").length, 1);
    assert.equal(entries.filter((entry) => entry[0] === "images[]").length, 1);
    assert.equal(entries.some((entry) => ["price", "quantity", "name", "category_id"].includes(entry[0])), false);
    const state = await GiniSyncSendState.findOne({ sku: "IMG-ONE" }).lean();
    assert.equal(result.code, "image_verified_hash_kept");
    assert.equal(state.payloadHash, planned.hash);
    assert.equal(state.createPayloadHash || "", "");
    assert.equal(state.jobId, "confirmed-full-sync");
    assert.equal(state.giniProductId, "88001");
    assert.equal(state.sku, "IMG-ONE");
    const kept = await Product.findById(product._id).lean();
    assert.equal(kept.variants[0].images[0].url, before.variants[0].images[0].url);
    assert.equal(await GiniSyncProductResult.countDocuments({ sku: "IMG-ONE", classification: "CREATED" }), 1);
    assert.equal(JSON.stringify(await GiniProductUpdateAudit.findOne({ sku: "IMG-ONE" }).lean()).includes(SECRET), false);
  });

  it("does not post when the live id, SKU, or image URL does not match", async () => {
    enableImageWrites();
    const { planned } = await stage("IMG-ID");
    const { preview } = await changedRow("IMG-ID");
    remote.get(giniSkuKey("IMG-ID")).id = "99999";
    calls = [];
    await assert.rejects(() => startImage(preview, "IMG-ID"), (err) => err.code === "confirmed_send_id_mismatch");
    remote.get(giniSkuKey("IMG-ID")).id = "88001";
    remote.get(giniSkuKey("IMG-ID")).sku = "OTHER-SKU";
    await assert.rejects(() => startImage(preview, "IMG-ID"), (err) => err.code === "confirmed_send_id_mismatch");
    remote.get(giniSkuKey("IMG-ID")).sku = "IMG-ID";
    remote.delete(giniSkuKey("IMG-ID"));
    await assert.rejects(() => startImage(preview, "IMG-ID"), (err) => err.code === "confirmed_send_missing");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-ID" }).lean()).payloadHash, planned.hash);
  });

  it("rejects an oversized or invalid file and a product over the image limit before posting", async () => {
    enableImageWrites();
    const { planned } = await stage("IMG-LIMIT");
    const { preview } = await changedRow("IMG-LIMIT");
    mediaMode = "big";
    calls = [];
    await assert.rejects(() => startImage(preview, "IMG-LIMIT"), (err) => err.code === "invalid_image");
    mediaMode = "bad";
    await assert.rejects(() => startImage(preview, "IMG-LIMIT"), (err) => err.code === "invalid_image");
    mediaMode = "ok";
    remote.get(giniSkuKey("IMG-LIMIT")).images = [OLD, OTHER];
    await assert.rejects(() => startImage(preview, "IMG-LIMIT"), (err) => err.code === "remote_image_conflict");
    await stage("IMG-ELEVEN", [OLD, ...Array.from({ length: 10 }, (_, index) => `https://s3.example/products/extra-${index}.jpg`)]);
    const eleven = await changedRow("IMG-ELEVEN");
    await assert.rejects(() => startImage(eleven.preview, "IMG-ELEVEN"), (err) => err.code === "image_limit");
    await stage("IMG-DUP", [OLD, OLD]);
    const duplicate = await changedRow("IMG-DUP");
    await assert.rejects(() => startImage(duplicate.preview, "IMG-DUP"), (err) => err.code === "image_url_ambiguous");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-LIMIT" }).lean()).payloadHash, planned.hash);
  });

  it("allows one replacement when the live product already has 10 images and the chosen URL is present", async () => {
    enableImageWrites();
    const images = [OLD, ...Array.from({ length: 9 }, (_, index) => `https://s3.example/products/keep-${index}.jpg`)];
    await stage("IMG-TEN", images);
    const { preview } = await changedRow("IMG-TEN");
    calls = [];
    const result = await startImage(preview, "IMG-TEN");
    assert.equal(posts().length, 1);
    assert.equal(result.pendingVerification, true);
    assert.equal(result.ok, false);
    const entries = [...posts()[0].body.entries()].filter((entry) => entry[0] === "delete_images[]");
    assert.equal(entries.length, 1);
    assert.equal(entries[0][1], OLD);
  });

  it("records delayed propagation as pending and does not upload again", async () => {
    enableImageWrites();
    const { planned } = await stage("IMG-WAIT", [OLD, OTHER]);
    imageMode = "delayed";
    const { preview } = await changedRow("IMG-WAIT");
    calls = [];
    const first = await startImage(preview, "IMG-WAIT");
    assert.equal(first.code, "image_pending_verification");
    assert.equal(first.pendingVerification, true);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-WAIT" }).lean()).payloadHash, planned.hash);
    await assert.rejects(() => startImage(preview, "IMG-WAIT"), (err) => err.code === "image_pending_verification");
    assert.equal(posts().length, 1);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const reading = await reconcileGiniImageReplacement({ confirm: true, sku: "IMG-WAIT" });
      assert.equal(reading.code, "image_pending_verification");
      assert.equal(reading.pendingVerification, true);
    }
    const pending = await GiniProductUpdateAudit.findOne({ sku: "IMG-WAIT", kind: "image_replacement" }).lean();
    assert.equal(pending.status, "pending_verification");
    assert.equal(pending.reconcileReads, 3);
    assert.deepEqual(pending.reconcileHistory, ["not_applied", "not_applied", "not_applied"]);
    await assert.rejects(() => startImage(preview, "IMG-WAIT"), (err) => err.code === "image_pending_verification");
    assert.equal(posts().length, 1);
    remote.get(giniSkuKey("IMG-WAIT")).images = [OTHER, NEW];
    calls = [];
    const reconciled = await reconcileGiniImageReplacement({ confirm: true, sku: "IMG-WAIT" });
    assert.equal(reconciled.ok, true);
    assert.equal(reconciled.code, "image_verified_hash_kept");
    assert.equal(posts().length, 0);
    const state = await GiniSyncSendState.findOne({ sku: "IMG-WAIT" }).lean();
    assert.equal(state.payloadHash, planned.hash);
    assert.equal(state.giniProductId, "88001");
    assert.equal(state.jobId, "confirmed-full-sync");
  });

  it("does not retry a timeout, a remote conflict, or an auth or validation rejection", async () => {
    enableImageWrites();
    const { planned } = await stage("IMG-RETRY", [OLD, OTHER]);
    const { preview } = await changedRow("IMG-RETRY");
    imageMode = "timeout";
    calls = [];
    const timedOut = await startImage(preview, "IMG-RETRY");
    assert.equal(timedOut.code, "image_pending_verification");
    await assert.rejects(() => startImage(preview, "IMG-RETRY"), (err) => err.code === "image_pending_verification");
    assert.equal(posts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-RETRY" }).lean()).payloadHash, planned.hash);

    await GiniProductUpdateAudit.deleteMany({});
    await GiniProductUpdateJob.deleteMany({});
    imageMode = "extra";
    calls = [];
    const conflict = await startImage(preview, "IMG-RETRY");
    assert.equal(conflict.code, "image_uncertain");
    await assert.rejects(() => startImage(preview, "IMG-RETRY"), (err) => err.code === "image_pending_verification");
    assert.equal(posts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-RETRY" }).lean()).payloadHash, planned.hash);

    await GiniProductUpdateAudit.deleteMany({});
    await GiniProductUpdateJob.deleteMany({});
    remote.get(giniSkuKey("IMG-RETRY")).images = [OLD, OTHER];
    imageMode = "auth";
    calls = [];
    const denied = await startImage(preview, "IMG-RETRY");
    assert.equal(denied.code, "auth_failed");
    assert.equal(posts().length, 1);
    imageMode = "rejected";
    const rejected = await startImage(preview, "IMG-RETRY");
    assert.equal(rejected.code, "update_rejected");
    assert.equal(posts().length, 2);
    imageMode = "rate";
    const limited = await startImage(preview, "IMG-RETRY");
    assert.equal(limited.code, "rate_limited");
    await assert.rejects(() => startImage(preview, "IMG-RETRY"), (err) => err.code === "rate_limited");
    assert.equal(posts().length, 3);
    imageMode = "created";
    await GiniProductUpdateAudit.deleteMany({});
    remote.get(giniSkuKey("IMG-RETRY")).images = [OLD, OTHER];
    const created = await startImage(preview, "IMG-RETRY");
    assert.equal(created.ok, false);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-RETRY" }).lean()).payloadHash, planned.hash);
  });

  it("does not replace a historical SKU or send while another update is unverified", async () => {
    enableImageWrites();
    await assert.rejects(() => startGiniImageReplacement({ confirm: true, sku: "LP-ID141232", deleteImageUrl: OLD, replacementImageUrl: SOURCE }), (err) => err.code === "historical_sku_unresolved");
    await assert.rejects(() => startGiniImageReplacement({ confirm: true, sku: "E6310221", deleteImageUrl: OLD, replacementImageUrl: SOURCE }), (err) => err.code === "historical_sku_unresolved");
    const { product } = await stage("IMG-HOLD");
    await Product.updateOne({ _id: product._id }, { $set: { variants: simpleVariant(11, "/uploads/products/patch.webp") } });
    const pricePreview = await changedRow("IMG-HOLD");
    await GiniProductUpdateAudit.create({
      partner: "gini",
      kind: "image_replacement",
      sku: "IMG-HOLD",
      skuKey: giniSkuKey("IMG-HOLD"),
      status: "pending_verification",
      requestSent: true,
      method: "POST",
    });
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    calls = [];
    await assert.rejects(
      () =>
        startGiniChangedSync({
          confirm: true,
          previewId: pricePreview.preview.previewId,
          previewSignature: pricePreview.preview.previewSignature,
          sku: "IMG-HOLD",
          expectedChanges: pricePreview.row.updateChanges,
        }),
      (err) => err.code === "image_pending_verification"
    );
    assert.equal(posts().length, 0);
    assert.equal(calls.some((item) => item.method === "PUT"), false);
  });

  it("blocks image replacement when quantity or price also changed and keeps the confirmed hash", async () => {
    enableImageWrites();
    const quantity = await stage("IMG-QTY");
    await Product.updateOne({ _id: quantity.product._id }, { $set: { "variants.0.sizes.0.stockQuantity": 11 } });
    const quantityPreview = await changedRow("IMG-QTY");
    assert.equal(quantityPreview.row.imageReplacementBlocked, true);
    assert.equal(quantityPreview.row.imageReplacementBlocker, "unrelated_field_unsynced");
    calls = [];
    await assert.rejects(() => startImage(quantityPreview.preview, "IMG-QTY"), (err) => err.code === "unrelated_field_unsynced");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-QTY" }).lean()).payloadHash, quantity.planned.hash);

    const price = await stage("IMG-PRICE");
    await Product.updateOne({ _id: price.product._id }, { $set: { price: 9000 } });
    const pricePreview = await changedRow("IMG-PRICE");
    calls = [];
    await assert.rejects(() => startImage(pricePreview.preview, "IMG-PRICE"), (err) => err.code === "unrelated_field_unsynced");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-PRICE" }).lean()).payloadHash, price.planned.hash);
    assert.equal((await GiniSyncProductResult.countDocuments({ sku: "IMG-PRICE", classification: "CREATED" })), 1);
  });

  it("rejects a changed BrownStore payload or a changed live image list before posting", async () => {
    enableImageWrites();
    const { product, planned } = await stage("IMG-STALE");
    const { preview } = await changedRow("IMG-STALE");
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.images.0.url": "/uploads/products/third.webp" } });
    calls = [];
    await assert.rejects(() => startImage(preview, "IMG-STALE"), (err) => err.code === "preview_stale");
    await Product.updateOne({ _id: product._id }, { $set: { "variants.0.images.0.url": "/uploads/products/next.webp" } });
    remote.get(giniSkuKey("IMG-STALE")).images = [OLD, NEW];
    await assert.rejects(() => startImage(preview, "IMG-STALE"), (err) => err.code === "remote_image_conflict");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-STALE" }).lean()).payloadHash, planned.hash);
  });

  it("does not unlock a delayed upload while GINI keeps returning the original image list", async () => {
    enableImageWrites();
    const { planned } = await stage("IMG-LOCK", [OLD, OTHER]);
    imageMode = "delayed";
    const { preview } = await changedRow("IMG-LOCK");
    calls = [];
    await startImage(preview, "IMG-LOCK");
    await assert.rejects(() => resolveGiniImageReplacement({ confirm: true, sku: "IMG-LOCK", resolution: "not_applied" }), (err) => err.code === "confirm_required");
    remote.get(giniSkuKey("IMG-LOCK")).images = [OLD, OTHER, NEW];
    const rejected = await resolveGiniImageReplacement({
      confirm: true,
      sku: "IMG-LOCK",
      resolution: "not_applied",
      acknowledgeDelay: true,
    });
    assert.equal(rejected.code, "image_pending_verification");
    assert.equal((await GiniProductUpdateAudit.findOne({ sku: "IMG-LOCK" }).lean()).status, "pending_verification");
    remote.get(giniSkuKey("IMG-LOCK")).images = [OLD, OTHER];
    const resolved = await resolveGiniImageReplacement({
      confirm: true,
      sku: "IMG-LOCK",
      resolution: "not_applied",
      acknowledgeDelay: true,
    });
    assert.equal(resolved.code, "image_manually_resolved");
    assert.equal(resolved.sentToGini, 0);
    assert.equal(posts().length, 1);
    const audit = await GiniProductUpdateAudit.findOne({ sku: "IMG-LOCK" }).lean();
    assert.equal(audit.status, "manually_resolved_not_applied");
    assert.ok(audit.reconcileHistory.includes("manual_rejected"));
    assert.ok(audit.reconcileHistory.includes("manual_not_applied"));
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-LOCK" }).lean()).payloadHash, planned.hash);
    calls = [];
    const again = await startImage(preview, "IMG-LOCK");
    assert.equal(again.code, "image_pending_verification");
    assert.equal(posts().length, 1);
  });

  it("replaces one selected image after the price is confirmed and does not write twice", async () => {
    enableImageWrites();
    enableUpdateWrites();
    await mapCollection();
    const product = await makeProduct("5301ATVN", { price: 818500, stock: 10 });
    const planned = await payloadFor(product._id);
    await confirmSend(product, planned, "53011", [OLD]);
    await Product.updateOne(
      { _id: product._id },
      { $set: { price: 818000, variants: simpleVariant(10, "/uploads/products/next.webp") } }
    );
    const blocked = await changedRow("5301ATVN");
    const repeatedPreview = await changedRow("5301ATVN");
    assert.equal(blocked.preview.sentToGini, 0);
    assert.equal(repeatedPreview.preview.sentToGini, 0);
    assert.deepEqual(blocked.row.updateChanges, repeatedPreview.row.updateChanges);
    assert.equal(blocked.row.updateEligible, true);
    assert.deepEqual(blocked.row.updateChanges, [{ field: "price", old: 818500, new: 818000 }]);
    assert.equal(blocked.row.imageReplacementBlocked, true);
    assert.equal(blocked.row.images.imagePairInferred, false);
    assert.deepEqual(blocked.row.images.previousImages, []);
    assert.deepEqual(blocked.row.images.added, []);
    assert.equal(blocked.row.images.remoteImages.includes(OLD), true);
    assert.equal(blocked.row.images.currentImages.includes(SOURCE), true);
    calls = [];
    await assert.rejects(() => startImage(blocked.preview, "5301ATVN"), (err) => err.code === "unrelated_field_unsynced");
    assert.equal(posts().length, 0);
    assert.equal(calls.some((item) => item.method === "PUT"), false);
    const price = await startGiniChangedSync({
      confirm: true,
      previewId: blocked.preview.previewId,
      previewSignature: blocked.preview.previewSignature,
      sku: "5301ATVN",
      expectedChanges: blocked.row.updateChanges,
    });
    assert.equal(price.ok, true);
    assert.equal(price.code, "fields_confirmed_hash_kept");
    assert.equal(calls.filter((item) => item.method === "PUT").length, 1);
    assert.equal(calls.find((item) => item.method === "PUT").body, '{"price":818000}');
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean()).payloadHash, planned.hash);
    const pending = await changedRow("5301ATVN");
    assert.equal(pending.preview.sentToGini, 0);
    assert.equal(pending.row.updateEligible, false);
    assert.equal(pending.row.changes.some((change) => change.field === "price"), false);
    assert.equal(pending.row.images.selectionRequired, true);
    assert.equal(pending.row.images.verificationNeeded, true);
    assert.equal(pending.row.images.imagePairInferred, false);
    assert.equal(pending.row.imageReplacementBlocked, false);
    remote.get(giniSkuKey("5301ATVN")).nextImages = [NEW];
    imageMode = "verified";
    calls = [];
    const replaced = await startImage(pending.preview, "5301ATVN", { deleteImageUrl: OLD, replacementImageUrl: SOURCE });
    assert.equal(replaced.ok, true);
    assert.equal(replaced.sentToGini, 1);
    assert.equal(replaced.code, "image_verified_hash_kept");
    assert.equal(posts().length, 1);
    const entries = [...posts()[0].body.entries()];
    assert.equal(entries.filter((entry) => entry[0] === "delete_images[]").map((entry) => entry[1]).join("\n"), OLD);
    assert.equal(entries.filter((entry) => entry[0] === "images[]").length, 1);
    assert.equal(entries.some((entry) => entry[0] === "price" || entry[0] === "quantity"), false);
    assert.equal(calls.some((item) => item.method === "PUT"), false);
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
    const priceAudit = await GiniProductUpdateAudit.findOne({ sku: "5301ATVN", method: "PUT" }).lean();
    assert.equal(priceAudit.status, "updated");
    assert.equal(priceAudit.confirmsPayloadHash, false);
    assert.equal(priceAudit.nextPayloadHash, "");
    const imageAudit = await GiniProductUpdateAudit.findOne({ sku: "5301ATVN", kind: "image_replacement" }).lean();
    assert.equal(imageAudit.status, "reconciled_applied");
    assert.equal(imageAudit.errorCode, "image_verified_hash_kept");
    calls = [];
    await assert.rejects(
      () => startImage(pending.preview, "5301ATVN"),
      (err) => err.code === "remote_image_conflict" || err.code === "preview_stale"
    );
    const again = await runGiniChangedPreview();
    assert.equal(again.sentToGini, 0);
    const after = again.changedProducts.find((row) => row.sku === "5301ATVN");
    assert.equal(after.updateEligible, false);
    assert.equal(after.changes.some((change) => change.field === "price"), false);
    assert.equal(posts().length, 0);
    assert.equal(calls.some((item) => item.method === "PUT" || item.method === "PATCH" || item.method === "DELETE"), false);
    assert.equal((await GiniSyncSendState.findOne({ sku: "5301ATVN" }).lean()).payloadHash, planned.hash);
  });

  it("a delayed or rejected image update never marks the image confirmed", async () => {
    enableImageWrites();
    enableUpdateWrites();
    await mapCollection();
    const delayedProduct = await makeProduct("IMG-DELAY", { price: 818500, stock: 10 });
    const delayedPlan = await payloadFor(delayedProduct._id);
    await confirmSend(delayedProduct, delayedPlan, "53012", [OLD]);
    await Product.updateOne(
      { _id: delayedProduct._id },
      { $set: { price: 818000, variants: simpleVariant(10, "/uploads/products/next.webp") } }
    );
    const delayedPreview = await changedRow("IMG-DELAY");
    calls = [];
    const delayedPrice = await startGiniChangedSync({
      confirm: true,
      previewId: delayedPreview.preview.previewId,
      previewSignature: delayedPreview.preview.previewSignature,
      sku: "IMG-DELAY",
      expectedChanges: delayedPreview.row.updateChanges,
    });
    assert.equal(delayedPrice.ok, true);
    assert.equal(posts().length, 0);
    imageMode = "delayed";
    const waiting = await changedRow("IMG-DELAY");
    calls = [];
    const delayed = await startImage(waiting.preview, "IMG-DELAY");
    assert.equal(delayed.ok, false);
    assert.equal(delayed.code, "image_pending_verification");
    assert.equal(posts().length, 1);
    const waitingAudit = await GiniProductUpdateAudit.findOne({ sku: "IMG-DELAY", kind: "image_replacement" }).lean();
    assert.equal(waitingAudit.status, "pending_verification");
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-DELAY" }).lean()).payloadHash, delayedPlan.hash);
    const stillWaiting = await changedRow("IMG-DELAY");
    assert.equal(stillWaiting.preview.sentToGini, 0);
    assert.equal(stillWaiting.row.updateEligible, false);
    assert.equal(stillWaiting.row.images.verificationNeeded, true);
    assert.equal(stillWaiting.row.images.selectionRequired, true);
    calls = [];
    await assert.rejects(() => startImage(waiting.preview, "IMG-DELAY"), (err) => err.code === "image_pending_verification");
    const read = await reconcileGiniImageReplacement({ confirm: true, sku: "IMG-DELAY" });
    assert.equal(read.ok, false);
    assert.equal(read.sentToGini, 0);
    assert.notEqual((await GiniProductUpdateAudit.findOne({ sku: "IMG-DELAY", kind: "image_replacement" }).lean()).status, "reconciled_applied");
    assert.equal((await GiniProductUpdateAudit.findOne({ sku: "IMG-DELAY", method: "PUT" }).lean()).status, "updated");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-DELAY" }).lean()).payloadHash, delayedPlan.hash);

    const rejectedProduct = await makeProduct("IMG-REJECT", { price: 818500, stock: 10 });
    const rejectedPlan = await payloadFor(rejectedProduct._id);
    await confirmSend(rejectedProduct, rejectedPlan, "53013", [OLD]);
    await Product.updateOne(
      { _id: rejectedProduct._id },
      { $set: { price: 818000, variants: simpleVariant(10, "/uploads/products/next.webp") } }
    );
    const rejectedPreview = await changedRow("IMG-REJECT");
    await startGiniChangedSync({
      confirm: true,
      previewId: rejectedPreview.preview.previewId,
      previewSignature: rejectedPreview.preview.previewSignature,
      sku: "IMG-REJECT",
      expectedChanges: rejectedPreview.row.updateChanges,
    });
    const ready = await changedRow("IMG-REJECT");
    imageMode = "rejected";
    calls = [];
    const rejected = await startImage(ready.preview, "IMG-REJECT");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "update_rejected");
    assert.equal(posts().length, 1);
    const rejectedAudit = await GiniProductUpdateAudit.findOne({ sku: "IMG-REJECT", kind: "image_replacement" }).lean();
    assert.equal(rejectedAudit.status, "failed");
    assert.equal((await GiniSyncSendState.findOne({ sku: "IMG-REJECT" }).lean()).payloadHash, rejectedPlan.hash);
    const stillRejected = await runGiniChangedPreview();
    assert.equal(stillRejected.sentToGini, 0);
    const rejectedRow = stillRejected.changedProducts.find((row) => row.sku === "IMG-REJECT");
    assert.equal(rejectedRow.updateEligible, false);
    assert.equal(rejectedRow.images.verificationNeeded, true);
    assert.equal(rejectedRow.images.selectionRequired, true);
    assert.equal(posts().length, 1);
    assert.equal((await GiniSyncProductResult.findOne({ sku: "IMG-REJECT", classification: "CREATED" }).lean()).giniPrice, 818500);
  });

  it("does not turn image gates on in the page or environment files", () => {
    const page = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniSyncAll.jsx", import.meta.url), "utf8");
    const updateSource = fs.readFileSync(new URL("./services/giniProductUpdate.js", import.meta.url), "utf8");
    assert.equal(page.includes("process.env"), false);
    assert.equal(page.includes("disabled={!canReplaceImage}"), true);
    assert.equal(page.includes("canReplaceGiniImage"), true);
    assert.equal(page.includes("data-gini-replace-image"), true);
    assert.equal(updateSource.includes("delete_images"), false);
    assert.equal(updateSource.includes('"POST"'), false);
    assert.match(translations.en.giniImageWriteBlocked, /_method=PUT/);
    assert.equal(translations.en.giniImageWriteBlocked.includes("not published"), false);
    assert.match(translations.ku.giniImageWriteBlocked, /GINI_IMAGE_WRITES_ENABLED/);
    assert.match(translations.ar.giniImageWriteBlocked, /GINI_ALLOW_LIVE_IMAGE_WRITES/);
    for (const name of ["../.env", "../.env.local", "../.env.example", "./.env", "./.env.local", "./.env.example"]) {
      const file = new URL(name, import.meta.url);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      assert.equal(/GINI_IMAGE_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_IMAGE_WRITES\s*=\s*true/.test(text), false);
      assert.equal(/GINI_UPDATE_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_UPDATE_WRITES\s*=\s*true/.test(text), false);
    }
  });
});
