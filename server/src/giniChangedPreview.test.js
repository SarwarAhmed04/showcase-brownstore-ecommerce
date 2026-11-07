import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { translations } from "../../client/src/i18n.js";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniSyncJob } from "./models/GiniSyncJob.js";
import { GiniSyncProductResult } from "./models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH } from "./utils/giniSigner.js";
import { normalizeGiniCategories } from "./utils/giniCategoryTree.js";
import { GINI_DEFAULT_BASE_URL, getGiniConnectionPublic, setGiniFetch } from "./services/giniConnection.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { toResolvedProduct } from "./utils/productView.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "./utils/platformTaxonomy.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "./utils/giniSyncOnePlan.js";
import {
  classifyGiniChangedPreview,
  giniChangedFieldDiffs,
  giniPayloadHash,
  buildGiniPlanFromParts,
  mappingFromTree,
} from "./utils/giniSyncEvaluate.js";
import { resetGiniBulkForTests, runGiniChangedPreview, startGiniSyncAll } from "./services/giniSyncAll.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "gini-changed-preview-test-secret";

const CLIENT_ID = "gini-changed-preview-client";
const SECRET = "gini-changed-preview-secret-not-for-the-browser";
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
const matched = { exists: true, giniProductId: "501", sku: "SKU-1" };

let memory;
let server;
let token;
let calls;
let remote;
let lookupMode;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/admin", adminRouter);
  return instance;
}

function listen(instance) {
  return new Promise((resolve) => {
    const running = instance.listen(0, "127.0.0.1", () => resolve(running));
  });
}

function mockResponse(status, body, contentType = "application/json") {
  const text = JSON.stringify(body);
  const headers = { "content-type": contentType };
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return text;
    },
  };
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
    calls.push({ method, url: target });
    if (method !== "GET") throw new Error(`GINI write attempted: ${method} ${target}`);
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, LIVE_TREE);
    if (target.includes("/products/")) return handleLookup(skuFromProductUrl(target));
    if (target.includes("/products?")) return mockResponse(200, { data: [], meta: { last_page: 1, total: 0 } });
    throw new Error(`unexpected ${target}`);
  });
}

function handleLookup(sku) {
  if (lookupMode === "error") return mockResponse(500, { message: "upstream unavailable" });
  if (lookupMode === "auth") return mockResponse(401, { message: "unauthorized" });
  const found = remote.get(giniSkuKey(sku));
  if (found) return mockResponse(200, { data: { id: found.id, sku: found.sku, name: "Live product" } });
  return mockResponse(404, { message: "Product not found." });
}

async function call(method, urlPath, { body, auth = true } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function simpleVariant(stock = 5) {
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
    variants: overrides.variants || simpleVariant(overrides.stock ?? 5),
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

async function connectGini() {
  installFetch();
  await call("PUT", "/api/admin/platforms/gini/connection", {
    body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
  });
  const tested = await call("POST", "/api/admin/platforms/gini/connection/test", {
    body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
  });
  assert.equal(tested.json.status, "connected");
  calls = [];
}

async function payloadHashFor(productId) {
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
  return { hash: giniPayloadHash(plan.payloadPreview), price: plan.giniPrice, quantity: plan.quantity, imageCount: plan.imageCount };
}

async function confirmSend(product, { giniProductId, payloadHash, price = 6500, quantity = 5, imageCount = 1 }) {
  await GiniSyncSendState.create({
    partner: "gini",
    productId: String(product._id),
    sku: product.itemCode,
    skuKey: giniSkuKey(product.itemCode),
    giniProductId,
    payloadHash,
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
    giniPrice: price,
    quantity,
    imageCount,
    payloadHash,
  });
}

function stampSends(rows) {
  return rows
    .map((row) => ({
      sku: row.sku,
      skuKey: row.skuKey,
      productId: row.productId,
      giniProductId: row.giniProductId,
      payloadHash: row.payloadHash,
      jobId: row.jobId,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
}

function stampProducts(rows) {
  return rows
    .map((row) => ({
      id: String(row._id),
      itemCode: row.itemCode,
      price: row.price,
      isActive: row.isActive !== false,
      nameEn: row.name?.en || "",
      stock: row.variants?.[0]?.sizes?.[0]?.stockQuantity,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }))
    .sort((left, right) => left.itemCode.localeCompare(right.itemCode));
}

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.toLowerCase().includes("clientsecret"), false);
  assert.equal(text.includes("X-SIGNATURE"), false);
}

function assertGetOnly() {
  assert.equal(calls.every((item) => item.method === "GET"), true);
  assert.equal(calls.some((item) => item.method === "POST" || item.method === "PUT" || item.method === "PATCH" || item.method === "DELETE"), false);
  assert.equal(calls.some((item) => item.url.includes(GINI_PRODUCTS_PATH) && item.method !== "GET"), false);
}

describe("GINI changed preview classification", () => {
  it("compares the local hash and does not treat that difference as a remote GINI change", () => {
    const changed = classifyGiniChangedPreview({
      savedSku: "SKU-1",
      savedGiniProductId: "501",
      savedHash: "old",
      currentSku: "SKU-1",
      currentHash: "new",
      productFound: true,
      found: matched,
    });
    const same = classifyGiniChangedPreview({
      savedSku: "SKU-1",
      savedGiniProductId: "501",
      savedHash: "same",
      currentSku: "SKU-1",
      currentHash: "same",
      productFound: true,
      found: matched,
    });
    assert.equal(changed.classification, "CHANGED");
    assert.equal(changed.code, "local_payload_hash_differs");
    assert.equal(changed.provesRemoteChange, false);
    assert.match(changed.reason, /not proof that the GINI product changed/);
    assert.equal(/remote product changed|updated on GINI/i.test(changed.reason), false);
    assert.equal(same.classification, "UNCHANGED");
    assert.equal(same.provesRemoteChange, false);
  });

  it("classifies a missing product, an id mismatch, an unavailable lookup, and an ineligible product", () => {
    const base = {
      savedSku: "SKU-1",
      savedGiniProductId: "501",
      savedHash: "old",
      currentSku: "SKU-1",
      currentHash: "new",
      productFound: true,
    };
    const missing = classifyGiniChangedPreview({ ...base, found: { exists: false } });
    const mismatch = classifyGiniChangedPreview({
      ...base,
      found: { exists: true, giniProductId: "999", sku: "SKU-1" },
    });
    const liveSku = classifyGiniChangedPreview({
      ...base,
      found: { exists: true, giniProductId: "501", sku: "OTHER" },
    });
    const unavailable = classifyGiniChangedPreview({ ...base, found: { error: true, status: 500 } });
    const inactive = classifyGiniChangedPreview({
      ...base,
      inactive: true,
      inactiveReasons: ["product_inactive"],
      found: matched,
    });
    const unmapped = classifyGiniChangedPreview({
      ...base,
      planBlockers: ["missing_mapping"],
      found: matched,
    });
    const noHash = classifyGiniChangedPreview({ ...base, savedHash: "", found: matched });
    const historical = classifyGiniChangedPreview({
      ...base,
      savedSku: "LP-ID141232",
      currentSku: "LP-ID141232",
      found: { exists: true, giniProductId: "521043", sku: "LP-ID141232" },
      savedGiniProductId: "521043",
    });
    assert.equal(missing.classification, "RECONCILIATION_NEEDED");
    assert.equal(missing.code, "confirmed_send_missing");
    assert.equal(mismatch.classification, "RECONCILIATION_NEEDED");
    assert.equal(mismatch.code, "confirmed_send_id_mismatch");
    assert.equal(liveSku.code, "confirmed_send_sku_mismatch");
    assert.equal(unavailable.classification, "RECONCILIATION_NEEDED");
    assert.equal(unavailable.code, "confirmed_send_unverified");
    assert.equal(inactive.classification, "BLOCKED");
    assert.equal(inactive.code, "product_inactive");
    assert.equal(unmapped.classification, "BLOCKED");
    assert.equal(unmapped.code, "missing_mapping");
    assert.equal(noHash.code, "confirmed_hash_missing");
    assert.equal(historical.classification, "RECONCILIATION_NEEDED");
    assert.equal(historical.code, "historical_sku_unresolved");
    assert.equal(historical.provesRemoteChange, false);
  });

  it("shows old and new values only for stored numeric fields that differ", () => {
    assert.deepEqual(
      giniChangedFieldDiffs(
        { price: 6500, quantity: 5, imageCount: 1 },
        { price: 9000, quantity: 2, imageCount: 1 }
      ),
      [
        { field: "price", old: 6500, new: 9000 },
        { field: "quantity", old: 5, new: 2 },
      ]
    );
    assert.deepEqual(
      giniChangedFieldDiffs({ price: 6500, quantity: 5, imageCount: 1 }, { price: 6500, quantity: 5, imageCount: 3 }),
      [{ field: "imageCount", old: 1, new: 3 }]
    );
    assert.deepEqual(giniChangedFieldDiffs({ price: null, quantity: 5, imageCount: 1 }, { price: 9000, quantity: 5, imageCount: 1 }), []);
    assert.deepEqual(giniChangedFieldDiffs(null, { price: 9000, quantity: 2, imageCount: 1 }), []);
  });

  it("keeps Changed Preview separate from the disabled Changed Sync action", () => {
    const page = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniSyncAll.jsx", import.meta.url), "utf8");
    const api = fs.readFileSync(new URL("../../client/src/api.js", import.meta.url), "utf8");
    const syncAll = fs.readFileSync(new URL("./services/giniSyncAll.js", import.meta.url), "utf8");
    assert.match(page, /data-gini-changed-preview-button="true"/);
    assert.match(page, /api\.giniChangedPreview\(\)/);
    assert.match(page, /giniChangedSyncContractRequired/);
    assert.match(page, /giniImageWriteBlocked/);
    assert.match(page, /data-gini-image-review/);
    assert.match(page, /data-gini-start-changed-sync="true"/);
    assert.match(page, /disabled=\{!canStartChangedSync\}/);
    assert.match(page, /updateWritesEnabled/);
    assert.match(page, /expectedChanges: selectedUpdate\.updateChanges/);
    assert.equal(page.includes('scope: "changed"'), false);
    assert.match(api, /\/platforms\/gini\/sync-all\/changed-preview/);
    assert.match(syncAll, /export async function runGiniChangedPreview/);
    // The stored imported-discount field can change the GINI price. It is not an IBSHER call.
    assert.equal(/miswag|elryan|ibsher/i.test(syncAll.replaceAll("ibsherDiscountPrice", "")), false);
    assert.equal(/Product\.(update|updateOne|updateMany|findOneAndUpdate|delete|deleteMany)/.test(syncAll), false);
    for (const language of ["ku", "en", "ar"]) {
      assert.equal(typeof translations[language].giniRunChangedPreview, "string");
      assert.equal(typeof translations[language].giniChangedSyncContractRequired, "string");
      assert.match(translations[language].giniChangedPreviewLocalNote, /جيني|GINI|جینی/);
    }
  });
});

describe("GINI changed preview", { concurrency: 1, timeout: 120000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-changed-preview"));
    const user = await User.create({
      email: "gini-changed-preview@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    server = await listen(app());
    installFetch();
    await connectGini();
  });

  after(async () => {
    resetGiniBulkForTests();
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    setGiniFetch(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    resetGiniBulkForTests();
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    remote = new Map();
    lookupMode = "";
    installFetch();
    await Promise.all([
      Product.deleteMany({}),
      Commission.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "gini" }),
      GiniSyncJob.deleteMany({}),
      GiniSyncProductResult.deleteMany({}),
      GiniSyncSendState.deleteMany({}),
      Partner.updateOne({ slug: "gini" }, { $set: { isActive: true } }),
    ]);
    const current = await getGiniConnectionPublic();
    if (current.status !== "connected") await connectGini();
    calls = [];
  });

  it("returns an empty read-only preview when nothing has been confirmed", async () => {
    const preview = await runGiniChangedPreview();
    assert.equal(preview.checked, 0);
    assert.equal(preview.changed, 0);
    assert.equal(preview.unchanged, 0);
    assert.equal(preview.reconciliationNeeded, 0);
    assert.equal(preview.blocked, 0);
    assert.equal(preview.sentToGini, 0);
    assert.equal(preview.readOnly, true);
    assert.equal(calls.length, 0);
  });

  it("classifies confirmed products from mocked GINI reads without sending or saving", async () => {
    await mapCollection();
    const specs = [
      ["SKU-CHANGED", "701"],
      ["SKU-SAME", "702"],
      ["SKU-MISSING", "703"],
      ["SKU-MISMATCH", "704"],
      ["SKU-INACTIVE", "705"],
      ["SKU-NAME", "706"],
      ["LP-ID141232", "521043"],
      ["E6310221", "522091"],
    ];
    const products = new Map();
    for (const [sku] of specs) products.set(sku, await makeProduct(sku));
    const hashes = new Map();
    for (const [sku, product] of products) hashes.set(sku, await payloadHashFor(product._id));
    for (const [sku, id] of specs) {
      const planned = hashes.get(sku);
      await confirmSend(products.get(sku), {
        giniProductId: id,
        payloadHash: planned.hash,
        price: planned.price,
        quantity: planned.quantity,
        imageCount: planned.imageCount,
      });
    }
    await Product.updateOne(
      { _id: products.get("SKU-CHANGED")._id },
      { $set: { price: 9000, "variants.0.sizes.0.stockQuantity": 2 } }
    );
    await Product.updateOne(
      { _id: products.get("SKU-NAME")._id },
      { $set: { "name.en": "Renamed product", "name.ar": "منتج معاد تسميته" } }
    );
    await Product.updateOne({ _id: products.get("SKU-INACTIVE")._id }, { $set: { isActive: false } });
    await Product.updateOne({ _id: products.get("LP-ID141232")._id }, { $set: { price: 8000 } });
    await Product.updateOne({ _id: products.get("E6310221")._id }, { $set: { price: 8000 } });
    for (const [sku, id] of specs) {
      if (sku === "SKU-MISSING") continue;
      remote.set(giniSkuKey(sku), { id: sku === "SKU-MISMATCH" ? "999" : id, sku });
    }

    const sendsBefore = stampSends(await GiniSyncSendState.find({}).lean());
    const productsBefore = stampProducts(await Product.find({}).lean());
    const mappingBefore = await PlatformTaxonomyConfig.findOne({ partner: "gini", brownCollectionId: "col-acne" }).lean();
    const resultCountBefore = await GiniSyncProductResult.countDocuments();
    calls = [];

    const response = await call("POST", "/api/admin/platforms/gini/sync-all/changed-preview", { body: {} });
    const preview = response.json;
    assert.equal(response.status, 200);
    assert.equal(preview.checked, 8);
    assert.equal(preview.changed, 2);
    assert.equal(preview.unchanged, 1);
    assert.equal(preview.reconciliationNeeded, 4);
    assert.equal(preview.blocked, 1);
    assert.equal(preview.changed + preview.unchanged + preview.reconciliationNeeded + preview.blocked, preview.checked);
    assert.equal(preview.sentToGini, 0);
    assert.equal(preview.readOnly, true);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.updatesSupported, true);
    assert.equal(preview.updateContractVerified, true);
    assert.equal(preview.updateWritesEnabled, false);
    assert.equal(preview.updateMethod, "PUT");
    assert.equal(preview.writesEnabled, false);
    assert.equal(preview.provesRemoteChange, false);
    assert.equal(preview.imageWriteSupported, false);
    assert.equal(preview.imageOrderSupported, false);
    assert.equal(preview.imageVerificationNeeded, 1);
    assertGetOnly();
    assertNoSecret(preview);

    const changed = new Map(preview.changedProducts.map((row) => [row.sku, row]));
    assert.deepEqual([...changed.keys()], ["SKU-CHANGED", "SKU-NAME"]);
    assert.equal(changed.get("SKU-CHANGED").provesRemoteChange, false);
    assert.match(changed.get("SKU-CHANGED").reason, /not proof that the GINI product changed/);
    assert.equal(/remote product changed|updated on GINI/i.test(changed.get("SKU-CHANGED").reason), false);
    assert.deepEqual(changed.get("SKU-CHANGED").changes, [
      { field: "price", old: 6500, new: 9000 },
      { field: "quantity", old: 5, new: 2 },
    ]);
    assert.equal(changed.get("SKU-CHANGED").updateEligible, true);
    assert.equal(changed.get("SKU-CHANGED").images.status, "urls_match_content_unverified");
    assert.equal(changed.get("SKU-CHANGED").images.contentVerified, false);
    assert.equal(changed.get("SKU-CHANGED").images.imageWriteSupported, false);
    assert.equal(changed.get("SKU-NAME").images.status, "unattributed_unverified");
    assert.equal(changed.get("SKU-NAME").images.verificationNeeded, true);
    assert.deepEqual(changed.get("SKU-NAME").images.previousImages, []);
    assert.equal(changed.get("SKU-CHANGED").identityMatched, true);
    assert.deepEqual(changed.get("SKU-CHANGED").updateChanges, changed.get("SKU-CHANGED").changes);
    assert.equal(changed.get("SKU-NAME").changes.length, 0);
    assert.equal(changed.get("SKU-NAME").updateEligible, false);
    assert.equal(changed.get("SKU-NAME").fieldsCompared, true);
    assert.match(changed.get("SKU-NAME").name, /Renamed product/);
    assert.equal(preview.changedProducts.some((row) => row.sku === "LP-ID141232" || row.sku === "E6310221"), false);

    const reconcile = new Map(preview.reconciliationProducts.map((row) => [row.sku, row.code]));
    assert.equal(reconcile.get("SKU-MISSING"), "confirmed_send_missing");
    assert.equal(reconcile.get("SKU-MISMATCH"), "confirmed_send_id_mismatch");
    assert.equal(reconcile.get("LP-ID141232"), "historical_sku_unresolved");
    assert.equal(reconcile.get("E6310221"), "historical_sku_unresolved");
    assert.equal(preview.blockedProducts[0].sku, "SKU-INACTIVE");
    assert.equal(preview.blockedProducts[0].code, "product_inactive");

    assert.deepEqual(stampSends(await GiniSyncSendState.find({}).lean()), sendsBefore);
    assert.deepEqual(stampProducts(await Product.find({}).lean()), productsBefore);
    const mappingAfter = await PlatformTaxonomyConfig.findOne({ partner: "gini", brownCollectionId: "col-acne" }).lean();
    assert.equal(mappingAfter.values.categoryId, mappingBefore.values.categoryId);
    assert.equal(mappingAfter.values.subcategoryId, mappingBefore.values.subcategoryId);
    assert.equal(new Date(mappingAfter.updatedAt).toISOString(), new Date(mappingBefore.updatedAt).toISOString());
    assert.equal(await GiniSyncProductResult.countDocuments(), resultCountBefore);
    assert.equal(await GiniSyncJob.countDocuments(), 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-MISMATCH" }).lean()).giniProductId, "704");
    assert.equal((await GiniSyncSendState.findOne({ sku: "LP-ID141232" }).lean()).giniProductId, "521043");
    assert.equal((await GiniSyncSendState.findOne({ sku: "E6310221" }).lean()).payloadHash, hashes.get("E6310221").hash);
  });

  it("keeps an unavailable GINI lookup as reconciliation and does not write", async () => {
    await mapCollection();
    const product = await makeProduct("SKU-DOWN");
    const planned = await payloadHashFor(product._id);
    await confirmSend(product, { giniProductId: "880", payloadHash: planned.hash, price: planned.price, quantity: planned.quantity, imageCount: planned.imageCount });
    lookupMode = "error";
    const before = stampSends(await GiniSyncSendState.find({}).lean());
    calls = [];
    const preview = await runGiniChangedPreview();
    assert.equal(preview.checked, 1);
    assert.equal(preview.changed, 0);
    assert.equal(preview.unchanged, 0);
    assert.equal(preview.reconciliationNeeded, 1);
    assert.equal(preview.blocked, 0);
    assert.equal(preview.reconciliationProducts[0].code, "confirmed_send_unverified");
    assert.equal(preview.sentToGini, 0);
    assert.equal(preview.provesRemoteChange, false);
    assertGetOnly();
    assert.deepEqual(stampSends(await GiniSyncSendState.find({}).lean()), before);
    assert.equal((await Product.findById(product._id).lean()).price, 6500);
  });

  it("does not start Changed Sync through the create route", async () => {
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    calls = [];
    await assert.rejects(
      () => startGiniSyncAll({ confirm: true, scope: "changed", approveFullRun: true }),
      (err) => {
        assert.equal(err.code, "invalid_scope");
        return true;
      }
    );
    assert.equal(calls.length, 0);
    assert.equal(await GiniSyncJob.countDocuments(), 0);
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
  });
});
