import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { translations } from "../../client/src/i18n.js";
import { selectEligibleResyncSkus } from "../../client/src/components/admin/platform/giniResyncDisplay.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniResyncAudit } from "./models/GiniResyncAudit.js";
import { GiniResyncJob } from "./models/GiniResyncJob.js";
import { GiniResyncLock } from "./models/GiniResyncLock.js";
import { GiniResyncPreview } from "./models/GiniResyncPreview.js";
import { GiniSyncProductResult } from "./models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH } from "./utils/giniSigner.js";
import { normalizeGiniCategories } from "./utils/giniCategoryTree.js";
import { GINI_DEFAULT_BASE_URL, getGiniConnectionPublic, saveGiniConnection, setGiniFetch, testGiniConnection } from "./services/giniConnection.js";
import { setGiniMediaFetch } from "./services/giniSyncOne.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { toResolvedProduct } from "./utils/productView.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "./utils/platformTaxonomy.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "./utils/giniSyncOnePlan.js";
import { buildGiniPlanFromParts, giniPayloadHash, mappingFromTree } from "./utils/giniSyncEvaluate.js";
import { GINI_HISTORICAL_HOLD_SKUS } from "./utils/giniHistoricalHold.js";
import { assessGiniResyncRemote, classifyGiniResyncRow, giniResyncWritesEnabled, resyncRowCanSend } from "./utils/giniResyncContract.js";
import { giniBulkWritesEnabled } from "./services/giniSyncAll.js";
import { giniUpdateWritesEnabled } from "./services/giniProductUpdate.js";
import {
  reconcileGiniResync,
  resetGiniResyncForTests,
  runGiniResyncPreview,
  setGiniResyncBeforeSend,
  setGiniResyncPaceMs,
  startGiniResync,
} from "./services/giniResync.js";

const CLIENT_ID = "gini-resync-client";
const SECRET = "gini-resync-secret-not-for-the-browser";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
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
const CONFIRMED_AT = "2026-11-02T11:35:20.425Z";

let memory;
let calls;
let catalog;
let allowPost;
let postMode;
let skuMode;
let searchMode;
let createdSeq;

function mockResponse(status, body, contentType = "application/json") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null) },
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

function formFields(options) {
  const fields = {};
  if (!options?.body?.entries) return fields;
  for (const [key, value] of options.body.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

function findByToken(token) {
  const text = decodeURIComponent(String(token || ""));
  const byId = catalog.filter((item) => String(item.id) === text);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return { ambiguous: true };
  const matches = catalog.filter((item) => giniSkuKey(item.sku) === giniSkuKey(text));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return { ambiguous: true };
  return null;
}

function installFetch() {
  calls = [];
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push({ method, url: target, options });
    if (method !== "GET" && method !== "POST") throw new Error(`Unexpected GINI method ${method} ${target}`);
    if (method === "POST" && !allowPost) throw new Error(`GINI write attempted: ${method} ${target}`);
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, LIVE_TREE);
    if (method === "POST") {
      const path = target.split("?")[0];
      if (!path.endsWith(GINI_PRODUCTS_PATH) || path.includes("/products/")) throw new Error(`Unexpected create path ${path}`);
      return handlePost(options);
    }
    if (method === "GET" && target.includes("/products/")) return handleLookup(skuFromProductUrl(target));
    if (method === "GET" && target.includes("/products?")) return handleSearch(target);
    throw new Error(`unexpected ${method} ${target}`);
  });
}

function handleLookup(token) {
  if (skuMode === "error" && !/^\d+$/.test(token)) return mockResponse(500, { message: "upstream" });
  const found = findByToken(token);
  if (!found || found.ambiguous) return mockResponse(found?.ambiguous ? 500 : 404, { message: "Product not found." });
  return mockResponse(200, { data: { id: found.id, sku: found.sku, merchant_id: "merchant-1" } });
}

function handleSearch(target) {
  if (searchMode === "error") return mockResponse(500, { message: "search down" });
  const page = Number(new URL(target).searchParams.get("page") || "1");
  if (searchMode === "truncated") {
    return mockResponse(200, { data: [], meta: { last_page: 6, total: 0, current_page: page } });
  }
  if (searchMode === "no-meta") return mockResponse(200, { data: [] });
  if (searchMode === "duplicate") {
    const search = new URL(target).searchParams.get("search") || "";
    return mockResponse(200, {
      data: [
        { id: "701", sku: search, merchant_id: "merchant-1" },
        { id: "702", sku: search, merchant_id: "merchant-1" },
      ],
      meta: { last_page: 1, total: 2 },
    });
  }
  const search = new URL(target).searchParams.get("search") || "";
  const matches = catalog.filter((item) => giniSkuKey(item.sku) === giniSkuKey(search));
  return mockResponse(200, {
    data: matches.map((item) => ({ id: item.id, sku: item.sku, merchant_id: "merchant-1" })),
    meta: { last_page: 1, total: matches.length },
  });
}

function handlePost(options) {
  const fields = formFields(options);
  if (!fields.sku) throw new Error("create form has no sku");
  if (postMode === "lose") throw new Error("connection lost before a GINI response");
  if (postMode === "lose-applied") {
    catalog.push({ id: "99002", sku: fields.sku });
    throw new Error("connection lost after GINI applied the create");
  }
  if (postMode === "reject") return mockResponse(422, { message: "The sku field is invalid." });
  createdSeq += 1;
  const id = String(createdSeq);
  catalog.push({ id, sku: fields.sku });
  return mockResponse(201, { data: { id, sku: fields.sku } });
}

function installMedia() {
  setGiniMediaFetch(async () => ({
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "image/png" : null;
      },
    },
    async arrayBuffer() {
      return PNG;
    },
  }));
}

function posts() {
  return calls.filter((item) => item.method === "POST");
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
    ...(overrides._id ? { _id: overrides._id } : {}),
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
  return { hash: giniPayloadHash(plan.payloadPreview), price: plan.giniPrice, quantity: plan.quantity };
}

async function confirmSend(product, planned, giniProductId, { remote = false } = {}) {
  await GiniSyncSendState.create({
    partner: "gini",
    productId: String(product._id),
    sku: product.itemCode,
    skuKey: giniSkuKey(product.itemCode),
    giniProductId,
    payloadHash: planned.hash,
    jobId: "confirmed-full-sync",
    confirmedAt: new Date(CONFIRMED_AT),
  });
  const created = await GiniSyncProductResult.create({
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
  if (remote) catalog.push({ id: giniProductId, sku: product.itemCode });
  return created;
}

function enableResyncWrites() {
  process.env.GINI_RESYNC_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_RESYNC_WRITES = "true";
}

function disableResyncWrites() {
  delete process.env.GINI_RESYNC_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_RESYNC_WRITES;
}

function clearOtherGates() {
  delete process.env.GINI_BULK_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
  delete process.env.GINI_UPDATE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
  delete process.env.GINI_IMAGE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_IMAGE_WRITES;
}

async function stage(sku, { giniProductId = "801", remote = false, isActive = true } = {}) {
  await mapCollection();
  const product = await makeProduct(sku, { isActive });
  const planned = await payloadFor(product._id);
  const created = await confirmSend(product, planned, giniProductId, { remote });
  return { product, planned, created };
}

function sendOne(preview, sku, extra = {}) {
  return startGiniResync({
    confirm: true,
    previewId: preview.previewId,
    previewSignature: preview.previewSignature,
    skus: [sku],
    expectedCount: 1,
    scope: "one",
    ...extra,
  });
}

function absent(status = 404) {
  return { state: "absent", status };
}

describe("GINI re-sync contract", () => {
  it("does not treat one failed GET as deletion and keeps the selection gate narrow", () => {
    const saved = { savedSku: "SKU-1", savedGiniProductId: "801" };
    const missing = assessGiniResyncRemote({
      ...saved,
      skuRead: absent(),
      idRead: absent(),
      search: { state: "absent", status: 200, matches: [] },
    });
    assert.equal(missing.remoteState, "verified_missing");
    const oneGet = assessGiniResyncRemote({
      ...saved,
      skuRead: absent(),
      idRead: absent(),
      search: { state: "uncertain", status: 500, matches: [] },
    });
    assert.equal(oneGet.remoteState, "uncertain");
    assert.equal(oneGet.code, "confirmed_send_unverified");
    const skuError = assessGiniResyncRemote({
      ...saved,
      skuRead: { state: "uncertain", status: 500 },
      idRead: absent(),
      search: { state: "absent", status: 200, matches: [] },
    });
    assert.equal(skuError.remoteState, "uncertain");
    const mismatch = assessGiniResyncRemote({
      ...saved,
      skuRead: { state: "found", status: 200, giniProductId: "999", sku: "SKU-1" },
      idRead: absent(),
      search: { state: "found", status: 200, matches: [{ giniProductId: "999", sku: "SKU-1" }] },
    });
    assert.equal(mismatch.code, "confirmed_send_id_mismatch");
    const conflict = assessGiniResyncRemote({
      ...saved,
      skuRead: absent(),
      idRead: { state: "found", status: 200, giniProductId: "801", sku: "OTHER" },
      search: { state: "absent", status: 200, matches: [] },
    });
    assert.equal(conflict.code, "remote_identity_conflict");
    const duplicate = assessGiniResyncRemote({
      ...saved,
      skuRead: { state: "found", status: 200, giniProductId: "1", sku: "SKU-1" },
      idRead: absent(),
      search: { state: "duplicate", status: 200, matches: [{ giniProductId: "1", sku: "SKU-1" }, { giniProductId: "2", sku: "SKU-1" }] },
    });
    assert.equal(duplicate.code, "duplicate_remote_sku");
    const truncated = assessGiniResyncRemote({
      ...saved,
      skuRead: absent(),
      idRead: absent(),
      search: { state: "absent", status: 200, matches: [], incomplete: true },
    });
    assert.equal(truncated.remoteState, "uncertain");
    assert.equal(truncated.code, "search_pagination_incomplete");
    const truncatedRow = classifyGiniResyncRow({
      savedSku: "SKU-1",
      currentSku: "SKU-1",
      productFound: true,
      remote: truncated,
    });
    assert.equal(truncatedRow.classification, "RECONCILIATION");
    assert.equal(truncatedRow.eligible, false);
    assert.equal(resyncRowCanSend(truncatedRow), false);
    assert.equal(GINI_HISTORICAL_HOLD_SKUS.length, 60);
    for (const sku of GINI_HISTORICAL_HOLD_SKUS) {
      const row = classifyGiniResyncRow({
        savedSku: sku,
        currentSku: sku.toLowerCase(),
        productFound: true,
        remote: missing,
      });
      assert.equal(row.classification, "BLOCKED");
      assert.equal(row.code, "historical_sku_hold");
      assert.equal(row.historical, true);
      assert.equal(row.eligible, false);
      assert.equal(row.locallyEligible, false);
      assert.equal(row.remoteState, "verified_missing");
      assert.equal(resyncRowCanSend({ ...row, sku, skuKey: giniSkuKey(sku) }), false);
      assert.equal(
        resyncRowCanSend(
          {
            sku,
            skuKey: giniSkuKey(sku),
            eligible: true,
            classification: "VERIFIED_MISSING",
            historical: false,
            locallyEligible: true,
            remoteState: "verified_missing",
          },
          { authorizeHistorical: true, single: true }
        ),
        false
      );
    }
    const selected = selectEligibleResyncSkus({
      missingEligible: [
        { sku: "SKU-OK", eligible: true, classification: "VERIFIED_MISSING", remoteState: "verified_missing" },
        { sku: "LP-ID141232", eligible: true, classification: "VERIFIED_MISSING", historical: true, remoteState: "verified_missing" },
        { sku: "HB-632", eligible: true, classification: "VERIFIED_MISSING", code: "historical_sku_hold", remoteState: "verified_missing" },
        { sku: "STILL", eligible: true, classification: "EXISTING", remoteState: "existing" },
        { sku: "BLOCKED", eligible: false, classification: "VERIFIED_MISSING", remoteState: "verified_missing" },
        { sku: "MAYBE", eligible: true, classification: "VERIFIED_MISSING", remoteState: "uncertain" },
      ],
      existingProducts: [{ sku: "LIVE", eligible: true, classification: "EXISTING" }],
      blockedProducts: [{ sku: "NO", eligible: true, classification: "BLOCKED" }],
      reconciliationProducts: [{ sku: "E6310221", eligible: true, classification: "RECONCILIATION" }],
    });
    assert.deepEqual(selected, ["SKU-OK"]);
  });

  it("keeps re-sync writes behind their own gates and out of the page source", () => {
    clearOtherGates();
    disableResyncWrites();
    assert.equal(giniResyncWritesEnabled(), false);
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    assert.equal(giniResyncWritesEnabled(), false);
    assert.equal(giniBulkWritesEnabled(), true);
    assert.equal(giniUpdateWritesEnabled(), true);
    process.env.GINI_RESYNC_WRITES_ENABLED = "TRUE";
    process.env.GINI_ALLOW_LIVE_RESYNC_WRITES = "true";
    assert.equal(giniResyncWritesEnabled(), false);
    process.env.GINI_RESYNC_WRITES_ENABLED = "true";
    assert.equal(giniResyncWritesEnabled(), true);
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    assert.equal(giniBulkWritesEnabled(), false);
    assert.equal(giniResyncWritesEnabled(), true);
    disableResyncWrites();
    clearOtherGates();

    const source = fs.readFileSync(new URL("./services/giniResync.js", import.meta.url), "utf8");
    const page = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniResyncDeleted.jsx", import.meta.url), "utf8");
    assert.equal(source.includes("performGiniJsonRequest"), false);
    assert.equal(source.includes('method: "PUT"'), false);
    assert.equal(source.includes('method: "PATCH"'), false);
    assert.equal(source.includes('method: "DELETE"'), false);
    assert.equal(source.includes('method: "POST"'), true);
    assert.equal(page.includes("process.env"), false);
    assert.equal(page.includes("data-gini-resync-select-all"), true);
    assert.equal(page.includes("data-gini-resync-one"), true);
    assert.equal(page.includes("all: false"), true);
    assert.equal(page.includes("authorizeHistorical"), false);
    assert.equal(source.includes("authorizeHistorical === true &&"), false);
    assert.equal(GiniResyncLock.schema.options.autoIndex, false);
    assert.equal(GiniResyncLock.schema.options.autoCreate, false);
    assert.equal(GiniResyncAudit.schema.options.autoIndex, false);
    assert.equal(GiniResyncAudit.schema.options.autoCreate, false);
    assert.equal(GiniResyncJob.schema.options.autoIndex, false);
    assert.equal(GiniResyncPreview.schema.options.autoIndex, false);
    assert.equal(fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").includes("autoIndex"), false);
    assert.match(translations.en.giniResyncConfirm, /\{count\}/);
    assert.match(translations.ku.giniResyncWritesOff, /GINI_RESYNC_WRITES_ENABLED/);
    assert.match(translations.ar.giniResyncWritesOff, /GINI_ALLOW_LIVE_RESYNC_WRITES/);
    for (const name of ["../.env", "../.env.local", "../.env.example", "./.env", "./.env.local", "./.env.example"]) {
      const file = new URL(name, import.meta.url);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, "utf8");
      assert.equal(/GINI_RESYNC_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_RESYNC_WRITES\s*=\s*true/.test(text), false);
    }
  });
});

describe("GINI deleted-product re-sync", { concurrency: 1, timeout: 180000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-resync"));
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    installFetch();
    installMedia();
    await Promise.all([
      GiniResyncLock.createIndexes(),
      GiniResyncAudit.createIndexes(),
      GiniResyncJob.createIndexes(),
      GiniResyncPreview.createIndexes(),
    ]);
    await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    const tested = await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    assert.equal(tested.status, "connected");
  });

  after(async () => {
    resetGiniResyncForTests();
    disableResyncWrites();
    clearOtherGates();
    setGiniFetch(null);
    setGiniMediaFetch(null);
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    resetGiniResyncForTests();
    setGiniResyncPaceMs(0);
    disableResyncWrites();
    clearOtherGates();
    catalog = [];
    allowPost = false;
    postMode = "ok";
    skuMode = "ok";
    searchMode = "ok";
    createdSeq = 99000;
    installFetch();
    installMedia();
    await Promise.all([
      Product.deleteMany({}),
      Commission.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "gini" }),
      GiniSyncProductResult.deleteMany({}),
      GiniSyncSendState.deleteMany({}),
      GiniResyncPreview.deleteMany({}),
      GiniResyncAudit.deleteMany({}),
      GiniResyncJob.deleteMany({}),
      GiniResyncLock.deleteMany({}),
      Partner.updateOne({ slug: "gini" }, { $set: { isActive: true } }),
    ]);
    if ((await getGiniConnectionPublic()).status !== "connected") {
      await saveGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
      await testGiniConnection({ baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET });
    }
    calls = [];
  });

  it("previews a deleted SKU without writing and keeps the original send", async () => {
    const { created } = await stage("SKU-GONE");
    const before = await GiniSyncSendState.findOne({ sku: "SKU-GONE" }).lean();
    const preview = await runGiniResyncPreview();
    assert.equal(preview.readOnly, true);
    assert.equal(preview.sentToGini, 0);
    assert.equal(preview.putFallback, false);
    assert.equal(preview.createMethod, "POST");
    assert.equal(preview.provesDeletionFromPortal, false);
    assert.equal(preview.account.clientId, CLIENT_ID);
    assert.equal(preview.account.baseHost, "merchant.gini.iq");
    assert.equal(preview.confirmed, 1);
    assert.equal(preview.stillExisting, 0);
    assert.equal(preview.verifiedMissing, 1);
    assert.equal(preview.eligible, 1);
    assert.equal(preview.blocked, 0);
    assert.equal(preview.reconciliation, 0);
    assert.equal(preview.missingEligible[0].sku, "SKU-GONE");
    assert.equal(preview.missingEligible[0].reads.sku.state, "absent");
    assert.equal(preview.missingEligible[0].reads.id.state, "absent");
    assert.equal(preview.missingEligible[0].reads.search.state, "absent");
    assert.equal(posts().length, 0);
    const after = await GiniSyncSendState.findOne({ sku: "SKU-GONE" }).lean();
    assert.equal(after.giniProductId, before.giniProductId);
    assert.equal(after.payloadHash, before.payloadHash);
    assert.equal(after.jobId, before.jobId);
    assert.equal(new Date(after.confirmedAt).toISOString(), CONFIRMED_AT);
    assert.equal((await GiniSyncProductResult.findById(created._id).lean()).giniProductId, "801");
  });

  it("keeps an existing product, an id mismatch, a remote conflict, and a duplicate out of re-sync", async () => {
    await stage("SKU-LIVE", { remote: true, giniProductId: "811" });
    await stage("SKU-MIS", { giniProductId: "821" });
    catalog.push({ id: "999", sku: "SKU-MIS" });
    await stage("SKU-CONFLICT", { giniProductId: "831" });
    catalog.push({ id: "831", sku: "OTHER-SKU" });
    await stage("SKU-DUP", { giniProductId: "841" });
    await makeProduct("SKU-DUP");
    calls = [];
    const preview = await runGiniResyncPreview();
    assert.equal(posts().length, 0);
    assert.equal(preview.existingProducts.some((row) => row.sku === "SKU-LIVE"), true);
    assert.equal(preview.reconciliationProducts.find((row) => row.sku === "SKU-MIS")?.code, "confirmed_send_id_mismatch");
    assert.equal(preview.reconciliationProducts.find((row) => row.sku === "SKU-CONFLICT")?.code, "remote_identity_conflict");
    assert.equal(preview.blockedProducts.find((row) => row.sku === "SKU-DUP")?.code, "duplicate_brownstore_sku");
    assert.equal(selectEligibleResyncSkus(preview).length, 0);
    enableResyncWrites();
    await assert.rejects(() => sendOne(preview, "SKU-LIVE"), (err) => err.code === "confirmed_local_send");
    await assert.rejects(() => sendOne(preview, "SKU-MIS"), (err) => err.code === "confirmed_send_id_mismatch");
    await assert.rejects(() => sendOne(preview, "SKU-CONFLICT"), (err) => err.code === "remote_identity_conflict");
    await assert.rejects(() => sendOne(preview, "SKU-DUP"), (err) => err.code === "duplicate_brownstore_sku");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-LIVE" }).lean()).giniProductId, "811");
  });

  it("does not re-sync an uncertain read or a product that is no longer eligible", async () => {
    await stage("SKU-OFF", { isActive: false });
    const inactive = await runGiniResyncPreview();
    assert.equal(inactive.blockedProducts.find((row) => row.sku === "SKU-OFF")?.code, "product_inactive");
    assert.equal(inactive.eligible, 0);
    await stage("SKU-FUZZY");
    skuMode = "error";
    calls = [];
    const fuzzy = await runGiniResyncPreview();
    assert.equal(fuzzy.missingEligible.length, 0);
    assert.equal(fuzzy.reconciliationProducts.find((row) => row.sku === "SKU-FUZZY")?.code, "confirmed_send_unverified");
    enableResyncWrites();
    await assert.rejects(() => sendOne(inactive, "SKU-OFF"), (err) => err.code === "product_inactive");
    await assert.rejects(() => sendOne(fuzzy, "SKU-FUZZY"), (err) => err.code === "confirmed_send_unverified");
    assert.equal(posts().length, 0);

    skuMode = "ok";
    searchMode = "error";
    const partial = await runGiniResyncPreview();
    assert.equal(partial.reconciliationProducts.find((row) => row.sku === "SKU-FUZZY")?.remoteState, "uncertain");
    assert.equal(partial.verifiedMissing, 0);
    assert.equal(posts().length, 0);
  });

  it("does not classify a SKU as missing when search pagination stops early", async () => {
    await stage("SKU-PAGE");
    searchMode = "truncated";
    calls = [];
    const preview = await runGiniResyncPreview();
    const row = preview.reconciliationProducts.find((item) => item.sku === "SKU-PAGE");
    const pages = calls
      .filter((item) => item.method === "GET" && item.url.includes("/products?"))
      .map((item) => new URL(item.url).searchParams.get("page"));
    assert.deepEqual(pages, ["1", "2", "3", "4", "5"]);
    assert.equal(pages.includes("6"), false);
    assert.equal(row?.code, "search_pagination_incomplete");
    assert.equal(row?.remoteState, "uncertain");
    assert.equal(row?.eligible, false);
    assert.equal(preview.verifiedMissing, 0);
    assert.equal(preview.eligible, 0);
    assert.deepEqual(selectEligibleResyncSkus(preview), []);
    enableResyncWrites();
    allowPost = true;
    await assert.rejects(() => sendOne(preview, "SKU-PAGE"), (err) => err.code === "search_pagination_incomplete");
    assert.equal(posts().length, 0);
    const state = await GiniSyncSendState.findOne({ sku: "SKU-PAGE" }).lean();
    assert.equal(state.giniProductId, "801");
    assert.equal(state.jobId, "confirmed-full-sync");
    assert.equal(state.confirmedAt.toISOString(), CONFIRMED_AT);
    assert.equal(state.resyncHistory?.length || 0, 0);

    searchMode = "no-meta";
    const missingMeta = await runGiniResyncPreview();
    assert.equal(missingMeta.reconciliationProducts.find((item) => item.sku === "SKU-PAGE")?.code, "search_pagination_incomplete");
    assert.equal(missingMeta.verifiedMissing, 0);
    assert.equal(posts().length, 0);
  });

  it("does not send when search returns two GINI ids for one SKU", async () => {
    await stage("SKU-TWO");
    searchMode = "duplicate";
    const preview = await runGiniResyncPreview();
    const row = preview.reconciliationProducts.find((item) => item.sku === "SKU-TWO");
    assert.equal(row?.code, "duplicate_remote_sku");
    assert.equal(row?.eligible, false);
    assert.equal(preview.verifiedMissing, 0);
    enableResyncWrites();
    allowPost = true;
    calls = [];
    await assert.rejects(() => sendOne(preview, "SKU-TWO"), (err) => err.code === "duplicate_remote_sku");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-TWO" }).lean()).giniProductId, "801");
  });

  it("recreates one verified-missing product with a new id and preserves the original create", async () => {
    const { created } = await stage("SKU-NEW");
    const preview = await runGiniResyncPreview();
    calls = [];
    enableResyncWrites();
    allowPost = true;
    const result = await sendOne(preview, "SKU-NEW");
    assert.equal(result.ok, true);
    assert.equal(result.sentToGini, 1);
    assert.equal(result.method, "POST");
    assert.equal(posts().length, 1);
    assert.equal(posts()[0].url.split("?")[0].endsWith(GINI_PRODUCTS_PATH), true);
    assert.equal(calls.some((item) => item.method === "PUT" || item.method === "PATCH" || item.method === "DELETE"), false);
    const state = await GiniSyncSendState.findOne({ sku: "SKU-NEW" }).lean();
    assert.notEqual(state.giniProductId, "801");
    assert.equal(state.originalGiniProductId, "801");
    assert.equal(state.jobId, "confirmed-full-sync");
    assert.equal(new Date(state.confirmedAt).toISOString(), CONFIRMED_AT);
    assert.equal(state.resyncHistory.length, 1);
    assert.equal(state.resyncHistory[0].previousGiniProductId, "801");
    assert.equal(state.resyncHistory[0].newGiniProductId, state.giniProductId);
    assert.equal(state.payloadHash, preview.missingEligible[0].currentHash);
    const original = await GiniSyncProductResult.findById(created._id).lean();
    assert.equal(original.giniProductId, "801");
    assert.equal(original.classification, "CREATED");
    assert.equal(original.payloadHash, created.payloadHash);
    const audit = await GiniResyncAudit.findOne({ sku: "SKU-NEW" }).lean();
    assert.equal(audit.method, "POST");
    assert.equal(audit.path, GINI_PRODUCTS_PATH);
    assert.equal(audit.status, "confirmed");
    assert.equal(audit.attempt, 1);
    assert.equal(audit.previousGiniProductId, "801");
    assert.equal(audit.responseGiniProductId, state.giniProductId);
    assert.equal(result.results[0].giniProductId, state.giniProductId);
  });

  it("keeps a lost POST uncertain, reconciles by read, and only then allows one new create", async () => {
    await stage("SKU-LOST");
    const preview = await runGiniResyncPreview();
    calls = [];
    enableResyncWrites();
    allowPost = true;
    postMode = "lose";
    const lost = await sendOne(preview, "SKU-LOST");
    assert.equal(lost.results[0].code, "create_uncertain");
    assert.equal(posts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-LOST" }).lean()).giniProductId, "801");
    await assert.rejects(() => sendOne(preview, "SKU-LOST"), (err) => err.code === "resync_uncertain");
    assert.equal(posts().length, 1);
    const reconciled = await reconcileGiniResync({ confirm: true, sku: "SKU-LOST" });
    assert.equal(reconciled.sentToGini, 0);
    assert.equal(reconciled.code, "reconciled_absent");
    assert.equal(posts().length, 1);
    assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-LOST" }).lean()).giniProductId, "801");
    assert.equal((await GiniResyncAudit.findOne({ sku: "SKU-LOST" }).lean()).status, "reconciled_absent");
    postMode = "ok";
    const fresh = await runGiniResyncPreview();
    assert.equal(fresh.eligible, 1);
    const again = await sendOne(fresh, "SKU-LOST");
    assert.equal(again.ok, true);
    assert.equal(posts().length, 2);
    const state = await GiniSyncSendState.findOne({ sku: "SKU-LOST" }).lean();
    assert.notEqual(state.giniProductId, "801");
    assert.equal(state.originalGiniProductId, "801");
    assert.equal(state.jobId, "confirmed-full-sync");
    assert.equal((await GiniResyncAudit.find({ sku: "SKU-LOST" }).sort({ createdAt: 1 }).lean())[1].attempt, 2);
  });

  it("adopts a lost create when the new id is readable and does not POST again", async () => {
    await stage("SKU-RECOVER");
    const preview = await runGiniResyncPreview();
    calls = [];
    enableResyncWrites();
    allowPost = true;
    postMode = "lose-applied";
    const result = await sendOne(preview, "SKU-RECOVER");
    assert.equal(posts().length, 1);
    assert.equal(result.results[0].code, "create_recovered_by_sku");
    assert.equal(result.results[0].giniProductId, "99002");
    const state = await GiniSyncSendState.findOne({ sku: "SKU-RECOVER" }).lean();
    assert.equal(state.giniProductId, "99002");
    assert.equal(state.originalGiniProductId, "801");
    assert.equal(state.jobId, "confirmed-full-sync");
    const second = await sendOne(preview, "SKU-RECOVER");
    assert.equal(second.sentToGini, 0);
    assert.equal(second.results[0].code, "preview_stale");
    assert.equal(posts().length, 1);
  });

  it("prevents a second click from creating twice", async () => {
    await stage("SKU-CLICK");
    const preview = await runGiniResyncPreview();
    enableResyncWrites();
    allowPost = true;
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    let opened;
    const started = new Promise((resolve) => {
      opened = resolve;
    });
    setGiniResyncBeforeSend(() => {
      opened();
      return held;
    });
    calls = [];
    const first = sendOne(preview, "SKU-CLICK");
    await started;
    await assert.rejects(() => sendOne(preview, "SKU-CLICK"), (err) => err.code === "resync_in_progress");
    release();
    const done = await first;
    assert.equal(done.ok, true);
    assert.equal(posts().length, 1);
  });

  it("blocks all 60 historical SKUs when re-sync writes are enabled", async () => {
    for (const sku of GINI_HISTORICAL_HOLD_SKUS) {
      await stage(sku, { giniProductId: "900000" });
    }
    await stage("SKU-OPEN", { giniProductId: "851" });
    const preview = await runGiniResyncPreview();
    assert.equal(preview.historical, 60);
    assert.equal(preview.eligible, 1);
    assert.deepEqual(selectEligibleResyncSkus(preview), ["SKU-OPEN"]);
    for (const sku of GINI_HISTORICAL_HOLD_SKUS) {
      const row = preview.blockedProducts.find((item) => giniSkuKey(item.sku) === giniSkuKey(sku));
      assert.equal(row?.code, "historical_sku_hold");
      assert.equal(row?.eligible, false);
      assert.equal(row?.remoteState, "verified_missing");
    }
    enableResyncWrites();
    allowPost = true;
    calls = [];
    await assert.rejects(() => sendOne(preview, "hb-632"), (err) => err.code === "historical_sku_hold");
    await assert.rejects(() => sendOne(preview, "e6310221"), (err) => err.code === "historical_sku_hold");
    await assert.rejects(
      () => sendOne(preview, "LP-ID141232", { authorizeHistorical: true }),
      (err) => err.code === "historical_sku_hold"
    );
    await assert.rejects(
      () => sendOne(preview, "SKU-OPEN", { authorizeHistorical: true }),
      (err) => err.code === "historical_sku_hold"
    );
    assert.equal(posts().length, 0);
    const sent = await sendOne(preview, "SKU-OPEN");
    assert.equal(sent.ok, true);
    assert.equal(posts().length, 1);
    const held = await GiniSyncSendState.find({ skuKey: { $in: GINI_HISTORICAL_HOLD_SKUS.map((sku) => giniSkuKey(sku)) } }).lean();
    assert.equal(held.length, 60);
    assert.equal(held.every((row) => row.giniProductId === "900000" && (row.resyncHistory?.length || 0) === 0), true);
  });

  it("keeps the confirmed ZJP00.000BK product when GINI still has id 570278", async () => {
    await mapCollection();
    const product = await makeProduct("ZJP00.000BK", { _id: "6aae476f023c0be610d48024" });
    const planned = await payloadFor(product._id);
    await confirmSend(product, planned, "570278", { remote: true });
    enableResyncWrites();
    allowPost = true;
    const preview = await runGiniResyncPreview();
    assert.equal(preview.existingProducts.some((row) => row.sku === "ZJP00.000BK" && row.savedGiniProductId === "570278"), true);
    assert.equal(selectEligibleResyncSkus(preview).includes("ZJP00.000BK"), false);
    calls = [];
    await assert.rejects(() => sendOne(preview, "ZJP00.000BK", { authorizeHistorical: true }), (err) => err.code === "historical_sku_hold");
    await assert.rejects(() => sendOne(preview, "ZJP00.000BK"), (err) => err.code === "confirmed_local_send");
    assert.equal(posts().length, 0);
    const state = await GiniSyncSendState.findOne({ sku: "ZJP00.000BK" }).lean();
    assert.equal(String(state.productId), "6aae476f023c0be610d48024");
    assert.equal(state.giniProductId, "570278");
    assert.equal(state.resyncHistory?.length || 0, 0);
  });

  it("does not post when the re-sync indexes are missing", async () => {
    await stage("SKU-INDEX");
    const preview = await runGiniResyncPreview();
    const indexes = await GiniResyncLock.collection.indexes();
    for (const index of indexes) {
      if (index.name !== "_id_") await GiniResyncLock.collection.dropIndex(index.name);
    }
    try {
      enableResyncWrites();
      allowPost = true;
      calls = [];
      await assert.rejects(() => sendOne(preview, "SKU-INDEX"), (err) => err.code === "resync_indexes_unavailable");
      await assert.rejects(() => runGiniResyncPreview(), (err) => err.code === "resync_indexes_unavailable");
      assert.equal(posts().length, 0);
      assert.equal((await GiniSyncSendState.findOne({ sku: "SKU-INDEX" }).lean()).giniProductId, "801");
    } finally {
      await GiniResyncLock.createIndexes();
    }
  });

  it("refuses an automatic full re-sync and does not follow another write gate", async () => {
    await stage("SKU-GATE");
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    allowPost = true;
    await assert.rejects(
      () => startGiniResync({ confirm: true, scope: "one", skus: ["SKU-GATE"], expectedCount: 1 }),
      (err) => err.code === "resync_writes_disabled"
    );
    enableResyncWrites();
    await assert.rejects(
      () => startGiniResync({
        confirm: true,
        all: true,
        scope: "selected",
        skus: ["SKU-GATE"],
        expectedCount: 1,
      }),
      (err) => err.code === "bulk_resync_refused"
    );
    await assert.rejects(
      () => startGiniResync({ confirm: false, scope: "one", skus: ["SKU-GATE"], expectedCount: 1 }),
      (err) => err.code === "confirm_required"
    );
    const preview = await runGiniResyncPreview();
    await assert.rejects(
      () => startGiniResync({
        confirm: true,
        previewId: preview.previewId,
        previewSignature: preview.previewSignature,
        skus: ["SKU-GATE"],
        expectedCount: 2,
        scope: "one",
      }),
      (err) => err.code === "confirm_required"
    );
    assert.equal(posts().length, 0);
    assert.equal(giniBulkWritesEnabled(), true);
    assert.equal(giniResyncWritesEnabled(), true);
  });
});
