import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { Commission } from "./models/Commission.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { MiswagProductSyncState } from "./models/MiswagProductSyncState.js";
import { MiswagSyncJob } from "./models/MiswagSyncJob.js";
import { MiswagSyncProductResult } from "./models/MiswagSyncProductResult.js";
import { MiswagVariationBarcode } from "./models/MiswagVariationBarcode.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { applyCommissionRate } from "./utils/commission.js";
import { MISWAG_PAYLOAD_HASH_VERSION, miswagPayloadHash } from "./utils/miswagPayloadHash.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import { saveMiswagCategoryMapping } from "./services/miswagCategoryMapping.js";
import {
  ensureMiswagSyncRunner,
  getLatestMiswagSyncJob,
  pauseMiswagSyncAll,
  resumeMiswagSyncAll,
  evaluateMiswagProductForSync,
  runMiswagSyncPreview,
  startMiswagSyncAll,
  stopMiswagSyncAll,
} from "./services/miswagSyncAll.js";
import {
  classifyMiswagPayload,
  miswagSyncStateLookupCount,
  resetMiswagSyncStateLookupCount,
} from "./services/miswagSyncState.js";
import {
  buildMiswagTestPayload,
  miswagItemExternalId,
  miswagVariationExternalId,
  sendMiswagTestProduct,
} from "./services/miswagTestProduct.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-changed-sync-test-secret";
process.env.MEDIA_PUBLIC_ORIGIN = "https://api.brownstore.net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;
let server;
let token;

function mockResponse(status, body = {}, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async text() {
      return text;
    },
  };
}

function app() {
  const instance = express();
  instance.use(express.json({ limit: "8mb" }));
  instance.use("/api/admin", adminRouter);
  return instance;
}

function listen(instance) {
  return new Promise((resolve) => {
    const running = instance.listen(0, "127.0.0.1", () => resolve(running));
  });
}

async function call(method, urlPath, { body } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sampleProduct(id, overrides = {}) {
  return {
    ibsherId: `ibs-${id}`,
    itemCode: `SKU-${id}`,
    name: { en: "Food Processor Deluxe", ar: "محضرة طعام فاخرة", ku: "ئامێر" },
    description: { en: "desc", ar: "وصف عربي كافٍ للمنتج التجريبي", ku: "وەسف" },
    price: 100000,
    discountPrice: 0,
    isActive: true,
    keyword: ["processor", "kitchen"],
    createdBy: { _id: "vendor-1", name: { en: "Home" } },
    brand: { _id: "brand-1", name: { en: "Philips" } },
    category: { _id: "cat-1", name: { en: "Home Appliances" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen Appliances" } },
    collectionName: { _id: "col-1", name: { en: "Food Processors" } },
    variants: [
      {
        _id: `var-${id}`,
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/sample.jpg", isMain: true }],
        sizes: [{ _id: `size-${id}`, size: "One Size", stockQuantity: 10 }],
      },
    ],
    ...overrides,
  };
}

function plainProduct(extra = {}) {
  return sampleProduct("hash", extra);
}

function barcodeMap(id = "hash", barcode = "1234567890123") {
  return new Map([[`bs-var-var-${id}`, { barcode, source: "generated" }]]);
}

function payloadFor(doc, options = {}) {
  const id = String(doc.ibsherId || "ibs-hash").replace(/^ibs-/, "");
  const built = buildMiswagTestPayload(doc, {
    rules: options.rules || [],
    categoryId: options.categoryId || "L4-100",
    brandId: options.brandId || "42",
    isLarge: options.isLarge === true,
    barcodeAssignments: options.barcodeAssignments || barcodeMap(id),
  });
  assert.equal(built.ok, true, (built.errors || []).join(","));
  assert.equal(JSON.stringify(built.payload).includes("barcodeSource"), false);
  return built.payload;
}

function filterRule(percentage, ids = {}) {
  return {
    scope: "filter",
    isActive: true,
    percentage,
    vendorId: "vendor-1",
    brandId: "brand-1",
    categoryId: "cat-1",
    subCategoryId: ids.subCategoryId || "",
    collectionId: ids.collectionId || "",
  };
}

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf8");
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_changed_sync";
  process.env.MISWAG_API_SECRET = "sk_prd_changed_sync_secret";
  setMiswagFetch(async (url, options) => {
    const method = String(options?.method || "GET").toUpperCase();
    if (method === "HEAD") return mockResponse(200, "");
    if (String(url).includes("/v1/categories/flat")) {
      return mockResponse(200, { data: { content: [], paging: {} } });
    }
    return mockResponse(404, {});
  });
  assert.equal((await testMiswagConnection()).ok, true);
}

async function mapDefaultCollection() {
  await saveMiswagCategoryMapping("col-1", {
    categoryId: "L4-100",
    categoryName: "Food Processors",
    categoryPath: "Home > Kitchen > Food Processors",
    categoryLevel: "L4",
  });
}

function postedId(options) {
  const raw = options?.body;
  const body = typeof raw === "string" ? JSON.parse(raw) : raw;
  return body?.external_id || "";
}

function installFetch(onPost) {
  const methods = [];
  setMiswagFetch(async (url, options) => {
    const method = String(options?.method || "GET").toUpperCase();
    methods.push(method);
    if (method === "HEAD") return mockResponse(200, "");
    if (String(url).includes("/v1/brands/search")) {
      return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
    }
    if (String(url).includes("/v1/categories/flat")) {
      return mockResponse(200, { data: { content: [], paging: {} } });
    }
    if (method === "POST" && String(url).includes("/v1/items/bulk-create")) {
      return onPost(url, options);
    }
    if (method === "GET" && String(url).includes("/v1/items/")) return mockResponse(404, {});
    return mockResponse(404, {});
  });
  return methods;
}

async function waitJob(id, accepted, attempts = 50, delay = 50) {
  let job = null;
  for (let i = 0; i < attempts; i += 1) {
    job = await MiswagSyncJob.findById(id);
    if (job && accepted.includes(job.status)) return job;
    await sleep(delay);
  }
  return job;
}

function postedBody(options) {
  const raw = options?.body;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

async function completedChangedPreview() {
  const preview = await runMiswagSyncPreview({ strategy: "changed" });
  assert.equal(preview.dryRun, true);
  assert.equal(preview.sentToMiswag, 0);
  assert.equal(preview.job.mode, "preview");
  assert.equal(preview.job.strategy, "changed");
  assert.equal(preview.job.status, "preview");
  assert.ok(preview.job.finishedAt);
  return preview;
}

function startChanged(previewJobId) {
  return startMiswagSyncAll({
    confirm: true,
    strategy: "changed",
    previewJobId,
  });
}

describe("Miswag payload fingerprint", () => {
  const doc = plainProduct();

  it("hashes the final payload deterministically and ignores object key order", () => {
    const payload = payloadFor(doc);
    const reorder = (value) => {
      if (Array.isArray(value)) return value.map(reorder);
      if (!value || typeof value !== "object") return value;
      const next = {};
      for (const key of Object.keys(value).reverse()) next[key] = reorder(value[key]);
      return next;
    };
    assert.equal(miswagPayloadHash(payload), miswagPayloadHash(reorder(payload)));
    assert.equal(miswagPayloadHash(payload), miswagPayloadHash(payloadFor(doc)));
  });

  it("preserves array order in the fingerprint", () => {
    const left = { external_id: "bs-1", variations: [{ label: "M" }, { label: "L" }] };
    const right = { variations: [{ label: "L" }, { label: "M" }], external_id: "bs-1" };
    assert.notEqual(miswagPayloadHash(left), miswagPayloadHash(right));
    assert.equal(
      miswagPayloadHash(left),
      miswagPayloadHash({ variations: [{ label: "M" }, { label: "L" }], external_id: "bs-1" })
    );
  });

  it("classifies missing, equal, different, and outdated hash versions", () => {
    const payload = payloadFor(doc);
    const hash = miswagPayloadHash(payload);
    assert.equal(classifyMiswagPayload(payload, null).changeType, "new");
    assert.equal(classifyMiswagPayload(payload, { lastPayloadHash: "" }).changeType, "new");
    assert.equal(
      classifyMiswagPayload(payload, { lastPayloadHash: hash, hashVersion: 1 }).changeType,
      "unchanged"
    );
    assert.equal(
      classifyMiswagPayload(payload, { lastPayloadHash: "f".repeat(64), hashVersion: 1 }).changeType,
      "changed"
    );
    assert.equal(
      classifyMiswagPayload(payload, { lastPayloadHash: hash, hashVersion: 0 }).changeType,
      "changed"
    );
    assert.equal(MISWAG_PAYLOAD_HASH_VERSION, 1);
  });

  it("detects price, commission, filter, mapping, size, stock, color, image, barcode, and content changes", () => {
    const base = payloadFor(doc);
    const baseHash = miswagPayloadHash(base);

    const priced = plainProduct({ price: 125000 });
    assert.notEqual(miswagPayloadHash(payloadFor(priced)), baseHash);
    assert.equal(payloadFor(priced).price, 125000);

    const commissioned = payloadFor(doc, {
      rules: [{ scope: "all", isActive: true, percentage: 10, targetId: "*" }],
    });
    assert.equal(commissioned.price, 110000);
    assert.notEqual(miswagPayloadHash(commissioned), baseHash);

    const three = payloadFor(doc, { rules: [filterRule(10)] });
    const four = payloadFor(doc, {
      rules: [filterRule(10), filterRule(15, { subCategoryId: "sub-1" })],
    });
    const five = payloadFor(doc, {
      rules: [
        filterRule(10),
        filterRule(15, { subCategoryId: "sub-1" }),
        filterRule(25, { subCategoryId: "sub-1", collectionId: "col-1" }),
      ],
    });
    const sameRateMoreSpecific = payloadFor(doc, {
      rules: [filterRule(10), filterRule(10, { subCategoryId: "sub-1", collectionId: "col-1" })],
    });
    assert.equal(three.price, 110000);
    assert.equal(four.price, 115000);
    assert.equal(five.price, 125000);
    assert.notEqual(miswagPayloadHash(three), baseHash);
    assert.notEqual(miswagPayloadHash(four), miswagPayloadHash(three));
    assert.notEqual(miswagPayloadHash(five), miswagPayloadHash(four));
    assert.equal(miswagPayloadHash(sameRateMoreSpecific), miswagPayloadHash(three));

    const mapped = payloadFor(doc, { categoryId: "L4-800" });
    assert.equal(mapped.category_id, "L4-800");
    assert.notEqual(miswagPayloadHash(mapped), baseHash);

    const large = payloadFor(doc, { isLarge: true });
    assert.equal(large.is_large, true);
    assert.equal(base.is_large, false);
    assert.notEqual(miswagPayloadHash(large), baseHash);

    const stockDoc = plainProduct();
    stockDoc.variants[0].sizes[0].stockQuantity = 8;
    const stock = payloadFor(stockDoc);
    assert.equal(stock.variations[0].sizes[0].quantity, 8);
    assert.notEqual(miswagPayloadHash(stock), baseHash);

    const colorDoc = plainProduct();
    colorDoc.variants[0].color = { name: { en: "White" }, hex: "#FFFFFF" };
    assert.notEqual(miswagPayloadHash(payloadFor(colorDoc)), baseHash);

    const imageDoc = plainProduct();
    imageDoc.variants[0].images = [{ url: "/media/other.jpg", isMain: true }];
    assert.notEqual(miswagPayloadHash(payloadFor(imageDoc)), baseHash);

    const barcoded = payloadFor(doc, { barcodeAssignments: barcodeMap("hash", "9990001112223") });
    assert.notEqual(miswagPayloadHash(barcoded), baseHash);

    const renamed = plainProduct({
      name: { en: "Changed English Name", ar: "اسم عربي جديد للمنتج", ku: "نوێ" },
      description: { en: "desc", ar: "وصف عربي مختلف تماماً للمنتج", ku: "وەسف" },
    });
    assert.notEqual(miswagPayloadHash(payloadFor(renamed)), baseHash);
    assert.equal(miswagPayloadHash(payloadFor(doc)), baseHash);
  });

  it("keeps external ids, rounding, commission priority, and neighboring sync code untouched", () => {
    assert.equal(miswagItemExternalId({ ibsherId: "abc" }), "bs-abc");
    assert.equal(miswagVariationExternalId({ _id: "variant-7" }), "bs-var-variant-7");
    const payload = payloadFor(doc);
    assert.equal(payload.external_id, "bs-ibs-hash");
    assert.equal(payload.variations[0].external_id, "bs-var-var-hash");
    assert.equal(payload.variations[0].sizes[0].external_id, "bs-size-size-hash");

    assert.equal(applyCommissionRate(7001, 0), 7250);
    assert.equal(applyCommissionRate(100000, 25), 125000);

    const commission = readSource("utils/commission.js");
    assert.match(commission, /filter:\s*6/);
    assert.match(commission, /PLATFORM_PRICE_STEP\s*=\s*250/);
    assert.equal(commission.includes("MiswagProductSyncState"), false);

    const catalog = readSource("utils/partnerCatalog.js");
    assert.match(catalog, /applyCommissionRate/);
    assert.equal(catalog.includes("MiswagProductSyncState"), false);

    const mapping = readSource("services/miswagCategoryMapping.js");
    assert.match(mapping, /export function resolveMappedMiswagCategory/);
    assert.match(mapping, /isLarge/);
    assert.equal(mapping.includes("MiswagProductSyncState"), false);
    assert.equal(mapping.includes("lastPayloadHash"), false);

    const barcodes = readSource("services/miswagTestBarcodes.js");
    assert.equal(barcodes.includes("lastPayloadHash"), false);
    assert.equal(barcodes.includes("MiswagProductSyncState"), false);

    const gini = readSource("utils/platformExcel/gini.js");
    assert.equal(gini.includes("MiswagProductSyncState"), false);

    const admin = readSource("routes/admin.js");
    assert.match(admin, /export function syncFromIbsher/);
    assert.equal(admin.includes("MiswagProductSyncState"), false);

    const syncAll = readSource("services/miswagSyncAll.js");
    assert.equal(syncAll.split("async function sendWithRetry").length - 1, 1);
    assert.match(syncAll, /isLarge: category\.category\.isLarge === true/);
    assert.match(syncAll, /loadMiswagSyncStateMap/);
  });
});

describe("Miswag changed-product sync", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "miswag-changed-sync@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "miswag", name: "Miswag", isActive: true });
    await Commission.create({
      partner: "miswag",
      scope: "all",
      targetId: "*",
      targetName: { en: "All" },
      percentage: 10,
      isActive: true,
    });
    server = await listen(app());
  });

  after(async () => {
    setMiswagFetch(null);
    delete process.env.MISWAG_API_KEY;
    delete process.env.MISWAG_API_SECRET;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    setMiswagFetch(null);
    delete process.env.MISWAG_API_KEY;
    delete process.env.MISWAG_API_SECRET;
    await Promise.all([
      MiswagConnection.deleteMany({}),
      MiswagSyncJob.deleteMany({}),
      MiswagSyncProductResult.deleteMany({}),
      MiswagProductSyncState.deleteMany({}),
      MiswagVariationBarcode.deleteMany({}),
      PlatformVisibilityRule.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({}),
      Product.deleteMany({}),
    ]);
  });

  async function currentHash(ibsherId) {
    const doc = await Product.findOne({ ibsherId });
    const rules = await Commission.find({ partner: "miswag", isActive: { $ne: false } }).lean();
    const { loadMiswagCategoryMappingMap } = await import("./services/miswagCategoryMapping.js");
    const { createBrandResolverCache } = await import("./services/miswagBrandResolve.js");
    const cache = createBrandResolverCache();
    cache.set("philips", { ok: true, brand: { id: 42, name: "Philips" } });
    const result = await evaluateMiswagProductForSync(doc, {
      rules,
      mappingByCollection: await loadMiswagCategoryMappingMap(),
      brandCache: cache,
    });
    assert.equal(result.status, "READY");
    return { result, hash: miswagPayloadHash(result.payload) };
  }

  it("keeps a unique partner + externalId sync-state index and stores no payload", () => {
    const indexes = MiswagProductSyncState.schema.indexes();
    assert.equal(
      indexes.some(([fields, options]) => fields.partner === 1 && fields.externalId === 1 && options?.unique),
      true
    );
    assert.equal(MiswagProductSyncState.schema.path("payload"), undefined);
    assert.equal(MiswagProductSyncState.schema.path("apiKey"), undefined);
    assert.equal(MiswagSyncJob.schema.path("strategy").options.default, "full");
    assert.equal(MiswagSyncProductResult.schema.path("changeType") != null, true);
  });

  it("counts a first run as NEW and sends no item writes from changed preview", async () => {
    await markConnected();
    await Product.create(sampleProduct("first"));
    await mapDefaultCollection();
    const methods = installFetch(() => mockResponse(201, { data: { item_id: "mw" } }));
    resetMiswagSyncStateLookupCount();
    const preview = await runMiswagSyncPreview({ strategy: "changed" });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sentToMiswag, 0);
    assert.equal(preview.strategy, "changed");
    assert.equal(preview.job.newCount, 1);
    assert.equal(preview.job.changedCount, 0);
    assert.equal(preview.job.unchangedCount, 0);
    assert.equal(preview.job.ready, 1);
    assert.equal(methods.includes("POST"), false);
    assert.equal(miswagSyncStateLookupCount(), 1);
  });

  it("sends only new and changed products and leaves blocked products unsent", async () => {
    await markConnected();
    await Product.create(sampleProduct("a"));
    const productB = await Product.create(sampleProduct("b"));
    const productC = await Product.create(sampleProduct("c"));
    await Product.create(
      sampleProduct("d", {
        collectionName: { _id: "col-missing", name: { en: "Unmapped" } },
      })
    );
    await mapDefaultCollection();
    const readyB = await currentHash("ibs-b");
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(productB._id),
      ibsherId: "ibs-b",
      externalId: readyB.result.externalId,
      lastPayloadHash: readyB.hash,
      lastHttpStatus: 201,
      miswagProductId: "mw-b",
      hashVersion: 1,
      lastSyncedAt: new Date(),
    });
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(productC._id),
      ibsherId: "ibs-c",
      externalId: "bs-ibs-c",
      lastPayloadHash: "f".repeat(64),
      lastHttpStatus: 201,
      miswagProductId: "mw-c",
      hashVersion: 1,
      lastSyncedAt: new Date(),
    });

    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: `mw-${posted.length}` } });
    });
    resetMiswagSyncStateLookupCount();
    const preview = await runMiswagSyncPreview({ strategy: "changed" });
    assert.equal(posted.length, 0);
    assert.equal(preview.sentToMiswag, 0);
    assert.equal(preview.job.newCount, 1);
    assert.equal(preview.job.changedCount, 1);
    assert.equal(preview.job.unchangedCount, 1);
    assert.equal(preview.job.skipped, 1);
    assert.equal(preview.job.missingCategory, 1);
    assert.equal(miswagSyncStateLookupCount(), 1);

    const started = await startChanged(preview.job.id);
    const done = await waitJob(started.job.id, ["completed", "failed", "auth_failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.strategy, "changed");
    assert.deepEqual(posted.sort(), ["bs-ibs-a", "bs-ibs-c"]);
    assert.equal(done.success, 2);
    assert.equal(done.unchangedCount, 1);
    assert.equal(done.failed, 0);

    const stateA = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-a" }).lean();
    const stateB = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-b" }).lean();
    const stateC = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-c" }).lean();
    const stateD = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-d" }).lean();
    assert.equal(stateA.hashVersion, 1);
    assert.equal(stateA.lastPayloadHash.length, 64);
    assert.equal(stateB.lastPayloadHash, readyB.hash);
    assert.notEqual(stateC.lastPayloadHash, "f".repeat(64));
    assert.equal(stateD, null);

    const rows = await MiswagSyncProductResult.find({ jobId: done._id }).lean();
    const byExternal = new Map(rows.map((row) => [row.externalId, row]));
    assert.equal(byExternal.get("bs-ibs-a").changeType, "new");
    assert.equal(byExternal.get("bs-ibs-a").status, "SYNCED");
    assert.equal(byExternal.get("bs-ibs-b").changeType, "unchanged");
    assert.equal(byExternal.get("bs-ibs-c").changeType, "changed");
    assert.equal(byExternal.get("bs-ibs-d").status, "SKIPPED");
    assert.equal(byExternal.get("bs-ibs-d").changeType, undefined);
  });

  it("does not store a hash after a failed send and retries the product as changed", async () => {
    await markConnected();
    const product = await Product.create(sampleProduct("fail"));
    await mapDefaultCollection();
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(product._id),
      ibsherId: "ibs-fail",
      externalId: "bs-ibs-fail",
      lastPayloadHash: "e".repeat(64),
      lastHttpStatus: 201,
      miswagProductId: "mw-old",
      hashVersion: 1,
    });
    let posts = 0;
    installFetch(() => {
      posts += 1;
      return mockResponse(400, { message: "bad product" });
    });
    const preview = await completedChangedPreview();
    assert.equal(posts, 0);
    const started = await startChanged(preview.job.id);
    const failed = await waitJob(started.job.id, ["completed", "failed"]);
    assert.equal(failed.status, "completed");
    assert.equal(failed.failed, 1);
    assert.equal(posts, 1);
    const stale = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-fail" }).lean();
    assert.equal(stale.lastPayloadHash, "e".repeat(64));

    const again = await runMiswagSyncPreview({ strategy: "changed" });
    assert.equal(again.job.changedCount, 1);
    assert.equal(again.job.newCount, 0);
    assert.equal(again.sentToMiswag, 0);

    installFetch(() => mockResponse(201, { data: { item_id: "mw-retry" } }));
    const retried = await startChanged(again.job.id);
    const done = await waitJob(retried.job.id, ["completed", "failed"]);
    assert.equal(done.success, 1);
    const saved = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-fail" }).lean();
    assert.notEqual(saved.lastPayloadHash, "e".repeat(64));
    assert.equal(saved.miswagProductId, "mw-retry");
    assert.equal(saved.lastHttpStatus, 201);
  });

  it("still sends every ready product on full sync and records the accepted hash", async () => {
    await markConnected();
    await Product.create(sampleProduct("full-new"));
    const same = await Product.create(sampleProduct("full-same"));
    await mapDefaultCollection();
    const current = await currentHash("ibs-full-same");
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(same._id),
      ibsherId: "ibs-full-same",
      externalId: current.result.externalId,
      lastPayloadHash: current.hash,
      lastHttpStatus: 201,
      hashVersion: 1,
      miswagProductId: "mw-same",
    });
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: "mw-full" } });
    });
    const fullPreview = await runMiswagSyncPreview();
    assert.equal(fullPreview.strategy, "full");
    assert.equal(fullPreview.sentToMiswag, 0);
    assert.equal(fullPreview.job.ready, 2);
    assert.equal(posted.length, 0);

    const started = await startMiswagSyncAll({ confirm: true });
    const done = await waitJob(started.job.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.strategy, "full");
    assert.equal(done.success, 2);
    assert.deepEqual(posted.sort(), ["bs-ibs-full-new", "bs-ibs-full-same"]);
    const state = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-full-same" }).lean();
    assert.equal(state.lastPayloadHash, current.hash);

    posted.length = 0;
    const changedPreview = await completedChangedPreview();
    assert.equal(posted.length, 0);
    const changed = await startChanged(changedPreview.job.id);
    const second = await waitJob(changed.job.id, ["completed", "failed"]);
    assert.equal(second.success, 0);
    assert.equal(second.unchangedCount, 2);
    assert.equal(posted.length, 0);
  });

  it("stores the exact Sync 1 payload hash only after Miswag accepts it", async () => {
    await markConnected();
    const doc = await Product.create(sampleProduct("one"));
    await mapDefaultCollection();
    installFetch(() => mockResponse(400, { message: "nope" }));
    const failed = await sendMiswagTestProduct({
      productId: String(doc._id),
      categoryId: "L4-100",
      brandId: "42",
      confirm: true,
    });
    assert.equal(failed.ok, false);
    assert.equal(await MiswagProductSyncState.countDocuments({}), 0);

    installFetch(() => mockResponse(201, { data: { item_id: "mw-one" } }));
    const sent = await sendMiswagTestProduct({
      productId: String(doc._id),
      categoryId: "L4-100",
      brandId: "42",
      confirm: true,
    });
    assert.equal(sent.ok, true);
    const state = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-one" }).lean();
    assert.equal(state.lastPayloadHash, miswagPayloadHash(sent.preview.payloadPreview));
    assert.equal(state.miswagProductId, "mw-one");
    assert.equal(state.hashVersion, 1);
    assert.equal(state.externalId, "bs-ibs-one");
  });

  it("pauses a changed sync and resumes from the checkpoint without restarting", async () => {
    await markConnected();
    await Product.create(sampleProduct("pause"));
    await mapDefaultCollection();
    let release = () => {};
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    installFetch(
      () =>
        new Promise((resolve) => {
          hold.then(() => resolve(mockResponse(201, { data: { item_id: "mw" } })));
        })
    );
    try {
      const preview = await completedChangedPreview();
      const started = await startChanged(preview.job.id);
      let paused = null;
      for (let i = 0; i < 30; i += 1) {
        try {
          paused = await pauseMiswagSyncAll();
          break;
        } catch {
          await sleep(20);
        }
      }
      assert.equal(paused.job.status, "paused");
      assert.equal(paused.job.strategy, "changed");
      await stopMiswagSyncAll();
    } finally {
      release();
    }
    await sleep(400);
    await Promise.all([
      MiswagSyncJob.deleteMany({}),
      Product.deleteMany({}),
      MiswagProductSyncState.deleteMany({}),
    ]);

    await Product.create(sampleProduct("r1"));
    await Product.create(sampleProduct("r2"));
    const job = await MiswagSyncJob.create({
      partner: "miswag",
      status: "paused",
      mode: "sync",
      strategy: "changed",
      batchSize: 15,
      total: 2,
      processed: 1,
      cursorIbsherId: "ibs-r1",
      startedAt: new Date(),
    });
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: "mw-resume" } });
    });
    const resumed = await resumeMiswagSyncAll();
    assert.equal(resumed.job.strategy, "changed");
    assert.equal(resumed.job.cursorIbsherId, "ibs-r1");
    const done = await waitJob(job._id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.strategy, "changed");
    assert.deepEqual(posted, ["bs-ibs-r2"]);
    assert.equal(done.cursorIbsherId, "ibs-r2");
  });

  it("resumes a changed job after a backend restart from its checkpoint", async () => {
    await markConnected();
    await Product.create(sampleProduct("restart-1"));
    await Product.create(sampleProduct("restart-2"));
    await mapDefaultCollection();
    const job = await MiswagSyncJob.create({
      partner: "miswag",
      status: "running",
      mode: "sync",
      strategy: "changed",
      batchSize: 15,
      total: 2,
      processed: 1,
      success: 0,
      cursorIbsherId: "ibs-restart-1",
      startedAt: new Date(),
    });
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: "mw-restart" } });
    });
    await ensureMiswagSyncRunner();
    const done = await waitJob(job._id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.strategy, "changed");
    assert.deepEqual(posted, ["bs-ibs-restart-2"]);
    assert.ok(done.processed >= 2);
  });

  it("pauses changed sync on 401 and retries 429 and 5xx with the shared sender", async () => {
    await markConnected();
    await Product.create(sampleProduct("auth"));
    await mapDefaultCollection();
    const authPreview = await completedChangedPreview();
    installFetch(() => mockResponse(401, { message: "Unauthorized" }));
    const authStart = await startChanged(authPreview.job.id);
    const paused = await waitJob(authStart.job.id, ["auth_failed", "completed", "failed"], 40, 40);
    assert.equal(paused.status, "auth_failed");
    assert.equal(paused.strategy, "changed");
    assert.equal(await MiswagProductSyncState.countDocuments({ externalId: "bs-ibs-auth" }), 0);

    await markConnected();
    await Product.deleteMany({});
    await MiswagSyncJob.deleteMany({});
    await MiswagProductSyncState.deleteMany({});
    await Product.create(sampleProduct("auth403"));
    await mapDefaultCollection();
    const forbiddenPreview = await completedChangedPreview();
    installFetch(() => mockResponse(403, { message: "Forbidden" }));
    const forbiddenStart = await startChanged(forbiddenPreview.job.id);
    const forbidden = await waitJob(forbiddenStart.job.id, ["auth_failed", "completed", "failed"], 40, 40);
    assert.equal(forbidden.status, "auth_failed");
    assert.equal(forbidden.strategy, "changed");
    assert.equal(await MiswagProductSyncState.countDocuments({ externalId: "bs-ibs-auth403" }), 0);

    await markConnected();
    await Product.deleteMany({});
    await MiswagSyncJob.deleteMany({});
    await Product.create(sampleProduct("retry"));
    await mapDefaultCollection();
    let attempts = 0;
    installFetch(() => {
      attempts += 1;
      if (attempts === 1) return mockResponse(429, { message: "slow" }, { "retry-after": "0" });
      if (attempts === 2) return mockResponse(503, { message: "down" });
      return mockResponse(201, { data: { item_id: "mw-retry-ok" } });
    });
    const retryPreview = await completedChangedPreview();
    const started = await startChanged(retryPreview.job.id);
    const done = await waitJob(started.job.id, ["completed", "failed", "auth_failed"], 40, 100);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 1);
    assert.ok(attempts >= 3);
    const state = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-retry" }).lean();
    assert.equal(state.miswagProductId, "mw-retry-ok");
  });

  it("does not overwrite sync state or delete remote items for blocked and inactive products", async () => {
    await markConnected();
    const blocked = await Product.create(
      sampleProduct("blocked", {
        collectionName: { _id: "col-missing", name: { en: "Unmapped" } },
      })
    );
    const inactive = await Product.create(sampleProduct("inactive"));
    await mapDefaultCollection();
    await PlatformVisibilityRule.create({
      partner: "miswag",
      scope: "product",
      targetId: String(inactive._id),
      isActive: false,
    });
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(blocked._id),
      ibsherId: "ibs-blocked",
      externalId: "bs-ibs-blocked",
      lastPayloadHash: "a".repeat(64),
      lastHttpStatus: 201,
      miswagProductId: "mw-blocked",
      hashVersion: 1,
    });
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(inactive._id),
      ibsherId: "ibs-inactive",
      externalId: "bs-ibs-inactive",
      lastPayloadHash: "b".repeat(64),
      lastHttpStatus: 201,
      miswagProductId: "mw-inactive",
      hashVersion: 1,
    });
    const methods = installFetch(() => mockResponse(201, { data: { item_id: "mw" } }));
    const preview = await completedChangedPreview();
    const started = await startChanged(preview.job.id);
    const done = await waitJob(started.job.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 0);
    assert.equal(done.inactive, 1);
    assert.equal(done.skipped, 1);
    assert.equal(methods.includes("POST"), false);
    assert.equal(methods.includes("DELETE"), false);
    const blockedState = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-blocked" }).lean();
    const inactiveState = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-inactive" }).lean();
    assert.equal(blockedState.lastPayloadHash, "a".repeat(64));
    assert.equal(inactiveState.lastPayloadHash, "b".repeat(64));
    assert.equal(inactiveState.miswagProductId, "mw-inactive");
  });

  it("keeps full preview as the default and refuses a second active strategy", async () => {
    await markConnected();
    await Product.create(sampleProduct("api"));
    await mapDefaultCollection();
    installFetch(() => mockResponse(201, { data: { item_id: "mw" } }));
    const plain = await call("POST", "/api/admin/platforms/miswag/sync-all/preview", { body: {} });
    assert.equal(plain.status, 200);
    assert.equal(plain.json.strategy, "full");
    assert.equal(plain.json.sentToMiswag, 0);
    assert.equal(plain.json.job.ready >= 1, true);
    const changed = await call("POST", "/api/admin/platforms/miswag/sync-all/preview", {
      body: { strategy: "changed" },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.json.strategy, "changed");
    assert.equal(changed.json.sentToMiswag, 0);

    await MiswagSyncJob.collection.insertOne({
      partner: "miswag",
      status: "completed",
      mode: "sync",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const legacy = await getLatestMiswagSyncJob();
    assert.equal(legacy.job.strategy, "full");

    await MiswagSyncJob.deleteMany({});
    let release = () => {};
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    installFetch(
      () =>
        new Promise((resolve) => {
          hold.then(() => resolve(mockResponse(201, { data: { item_id: "mw" } })));
        })
    );
    try {
      const first = await startMiswagSyncAll({ confirm: true, strategy: "full" });
      const second = await startMiswagSyncAll({ confirm: true, strategy: "changed" });
      assert.equal(second.job.id, first.job.id);
      assert.equal(second.job.strategy, "full");
      assert.equal(await MiswagSyncJob.countDocuments({ status: "running" }), 1);
      await stopMiswagSyncAll();
    } finally {
      release();
    }
    await sleep(400);
    await MiswagSyncJob.deleteMany({});
    await MiswagSyncJob.create({
      partner: "miswag",
      status: "paused",
      mode: "sync",
      strategy: "full",
      batchSize: 15,
      total: 1,
      cursorIbsherId: "",
    });
    await assert.rejects(
      () => startMiswagSyncAll({ confirm: true, strategy: "changed" }),
      (err) => err?.code === "sync_active" && err.status === 409
    );
    assert.equal(await MiswagSyncJob.countDocuments({ status: "running" }), 0);
  });

  const PREVIEW_REQUIRED = "Run and complete Changed Preview before starting Changed Sync.";

  async function guardProduct(id = "guard") {
    await markConnected();
    const product = await Product.create(sampleProduct(id));
    await mapDefaultCollection();
    const externalId = `bs-ibs-${id}`;
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(product._id),
      ibsherId: `ibs-${id}`,
      externalId,
      lastPayloadHash: "c".repeat(64),
      lastHttpStatus: 201,
      miswagProductId: "mw-guard",
      hashVersion: 1,
    });
    return { product, externalId };
  }

  async function rejectChangedStart(previewJobId, { sendId = true, externalId = "bs-ibs-guard" } = {}) {
    const posts = [];
    installFetch((_url, options) => {
      posts.push(postedBody(options));
      return mockResponse(201, { data: { item_id: "should-not-send" } });
    });
    const jobsBefore = await MiswagSyncJob.countDocuments();
    const syncBefore = await MiswagSyncJob.countDocuments({ mode: "sync" });
    const hashBefore = await MiswagProductSyncState.findOne({ externalId }).lean();
    const body = { confirm: true, strategy: "changed" };
    if (sendId) body.previewJobId = previewJobId;
    const response = await call("POST", "/api/admin/platforms/miswag/sync-all/start", { body });
    assert.equal(response.status, 409);
    assert.equal(response.json.error, "changed_preview_required");
    assert.equal(response.json.code, "changed_preview_required");
    assert.equal(response.json.message, PREVIEW_REQUIRED);
    assert.equal(response.json.job, undefined);
    assert.equal(response.json.endpoint, undefined);
    assert.equal(response.json.stack, undefined);
    assert.equal(JSON.stringify(response.json).includes(String(previewJobId || "missing-id")), false);
    assert.equal(await MiswagSyncJob.countDocuments(), jobsBefore);
    assert.equal(await MiswagSyncJob.countDocuments({ mode: "sync" }), syncBefore);
    assert.equal(posts.length, 0);
    const hashAfter = await MiswagProductSyncState.findOne({ externalId }).lean();
    assert.equal(hashAfter.lastPayloadHash, hashBefore.lastPayloadHash);
    assert.equal(hashAfter.miswagProductId, hashBefore.miswagProductId);
    assert.equal(hashAfter.lastHttpStatus, hashBefore.lastHttpStatus);
    return response;
  }

  it("rejects changed sync without previewJobId and creates nothing", async () => {
    const { externalId } = await guardProduct();
    await assert.rejects(
      () => startMiswagSyncAll({ confirm: true, strategy: "changed" }),
      (err) => err?.code === "changed_preview_required" && err.status === 409 && err.message === PREVIEW_REQUIRED
    );
    assert.equal(await MiswagSyncJob.countDocuments({ mode: "sync" }), 0);
    assert.equal(
      (await MiswagProductSyncState.findOne({ externalId }).lean()).lastPayloadHash,
      "c".repeat(64)
    );
    await rejectChangedStart(undefined, { sendId: false, externalId });
    await rejectChangedStart("", { externalId });
  });

  it("rejects a missing or unknown changed preview id", async () => {
    const { externalId } = await guardProduct("missing");
    await rejectChangedStart("not-a-preview-id", { externalId });
    await rejectChangedStart(new mongoose.Types.ObjectId().toString(), { externalId });
  });

  it("rejects a full preview and a sync job used as previewJobId", async () => {
    const { externalId } = await guardProduct("full-id");
    const fullPreview = await runMiswagSyncPreview({ strategy: "full" });
    assert.equal(fullPreview.job.strategy, "full");
    assert.equal(fullPreview.job.mode, "preview");
    assert.ok(fullPreview.job.finishedAt);
    await rejectChangedStart(fullPreview.job.id, { externalId });

    const syncJob = await MiswagSyncJob.create({
      partner: "miswag",
      status: "completed",
      mode: "sync",
      strategy: "changed",
      finishedAt: new Date(),
      startedAt: new Date(),
    });
    await rejectChangedStart(String(syncJob._id), { externalId });

    const otherPartner = await MiswagSyncJob.create({
      partner: "other",
      status: "preview",
      mode: "preview",
      strategy: "changed",
      finishedAt: new Date(),
      startedAt: new Date(),
    });
    const response = await rejectChangedStart(String(otherPartner._id), { externalId });
    assert.equal(JSON.stringify(response.json).includes("other"), false);
  });

  it("rejects a running or unfinished changed preview", async () => {
    const { externalId } = await guardProduct("running");
    const running = await MiswagSyncJob.create({
      partner: "miswag",
      status: "running",
      mode: "preview",
      strategy: "changed",
      startedAt: new Date(),
    });
    await rejectChangedStart(String(running._id), { externalId });

    const unfinished = await MiswagSyncJob.create({
      partner: "miswag",
      status: "preview",
      mode: "preview",
      strategy: "changed",
      startedAt: new Date(),
      finishedAt: null,
    });
    await rejectChangedStart(String(unfinished._id), { externalId });
    assert.equal(await MiswagSyncJob.countDocuments({ mode: "sync" }), 0);
  });

  it("rejects a failed changed preview", async () => {
    const { externalId } = await guardProduct("failed-preview");
    const failed = await MiswagSyncJob.create({
      partner: "miswag",
      status: "failed",
      mode: "preview",
      strategy: "changed",
      startedAt: new Date(),
      finishedAt: new Date(),
      lastError: "preview failed",
    });
    const response = await rejectChangedStart(String(failed._id), { externalId });
    assert.equal(JSON.stringify(response.json).includes("preview failed"), false);
  });

  it("rejects a stopped or cancelled changed preview", async () => {
    const { externalId } = await guardProduct("stopped-preview");
    const stopped = await MiswagSyncJob.create({
      partner: "miswag",
      status: "stopped",
      mode: "preview",
      strategy: "changed",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await rejectChangedStart(String(stopped._id), { externalId });

    const cancelled = await MiswagSyncJob.collection.insertOne({
      partner: "miswag",
      status: "cancelled",
      mode: "preview",
      strategy: "changed",
      startedAt: new Date(),
      finishedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await rejectChangedStart(String(cancelled.insertedId), { externalId });
  });

  it("accepts a successfully completed changed preview and still sends the current payload", async () => {
    await markConnected();
    await Product.create(sampleProduct("accepted"));
    await mapDefaultCollection();
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: "mw-accepted" } });
    });
    const preview = await completedChangedPreview();
    assert.equal(posted.length, 0);
    assert.equal(await MiswagProductSyncState.countDocuments({ externalId: "bs-ibs-accepted" }), 0);
    const response = await call("POST", "/api/admin/platforms/miswag/sync-all/start", {
      body: { confirm: true, strategy: "changed", previewJobId: preview.job.id },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.job.mode, "sync");
    assert.equal(response.json.job.strategy, "changed");
    assert.notEqual(response.json.job.id, preview.job.id);
    const done = await waitJob(response.json.job.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 1);
    assert.equal(done.newCount, 1);
    assert.deepEqual(posted, ["bs-ibs-accepted"]);
    const previewJob = await MiswagSyncJob.findById(preview.job.id).lean();
    assert.equal(previewJob.mode, "preview");
    assert.equal(previewJob.status, "preview");
    const state = await MiswagProductSyncState.findOne({ externalId: "bs-ibs-accepted" }).lean();
    assert.equal(state.lastHttpStatus, 201);
    assert.equal(state.lastPayloadHash.length, 64);
  });

  it("recalculates the current payload after the authorizing changed preview", async () => {
    await markConnected();
    const product = await Product.create(sampleProduct("recalc"));
    await mapDefaultCollection();
    const before = await currentHash("ibs-recalc");
    await MiswagProductSyncState.create({
      partner: "miswag",
      productId: String(product._id),
      ibsherId: "ibs-recalc",
      externalId: before.result.externalId,
      lastPayloadHash: before.hash,
      lastHttpStatus: 201,
      miswagProductId: "mw-old",
      hashVersion: 1,
    });
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedBody(options));
      return mockResponse(201, { data: { item_id: "mw-now" } });
    });
    const preview = await completedChangedPreview();
    assert.equal(posted.length, 0);
    assert.equal(preview.job.unchangedCount, 1);
    assert.equal(preview.sentToMiswag, 0);
    const afterPreview = await MiswagProductSyncState.findOne({ externalId: before.result.externalId }).lean();
    assert.equal(afterPreview.lastPayloadHash, before.hash);

    await Product.updateOne({ _id: product._id }, { $set: { price: 180000 } });
    const started = await startChanged(preview.job.id);
    const done = await waitJob(started.job.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 1);
    assert.equal(done.changedCount, 1);
    assert.equal(done.unchangedCount, 0);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].external_id, before.result.externalId);
    assert.notEqual(posted[0].price, before.result.payload.price);
    assert.equal(posted[0].price, applyCommissionRate(180000, 10));
    const row = await MiswagSyncProductResult.findOne({
      jobId: done._id,
      externalId: before.result.externalId,
    }).lean();
    assert.equal(row.changeType, "changed");
    assert.equal(row.status, "SYNCED");
    const saved = await MiswagProductSyncState.findOne({ externalId: before.result.externalId }).lean();
    assert.equal(saved.lastPayloadHash, miswagPayloadHash(posted[0]));
    assert.notEqual(saved.lastPayloadHash, before.hash);
    assert.equal(saved.miswagProductId, "mw-now");
  });

  it("starts full sync without a changed preview", async () => {
    await markConnected();
    await Product.create(sampleProduct("full-guard"));
    await mapDefaultCollection();
    const posted = [];
    installFetch((_url, options) => {
      posted.push(postedId(options));
      return mockResponse(201, { data: { item_id: "mw-full-guard" } });
    });
    assert.equal(await MiswagSyncJob.countDocuments({ strategy: "changed", mode: "preview" }), 0);
    const response = await call("POST", "/api/admin/platforms/miswag/sync-all/start", {
      body: { confirm: true, strategy: "full" },
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.job.strategy, "full");
    assert.equal(response.json.job.mode, "sync");
    assert.equal(response.json.error, undefined);
    const done = await waitJob(response.json.job.id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 1);
    assert.deepEqual(posted, ["bs-ibs-full-guard"]);
  });

  it("resumes an existing changed sync without asking for preview again", async () => {
    await markConnected();
    await Product.create(sampleProduct("resume-start"));
    await mapDefaultCollection();
    const paused = await MiswagSyncJob.create({
      partner: "miswag",
      status: "paused",
      mode: "sync",
      strategy: "changed",
      batchSize: 15,
      total: 1,
      cursorIbsherId: "",
      startedAt: new Date(),
    });
    installFetch(() => mockResponse(201, { data: { item_id: "mw-resume-start" } }));
    assert.equal(await MiswagSyncJob.countDocuments({ mode: "preview" }), 0);
    const viaStart = await startMiswagSyncAll({ confirm: true, strategy: "changed" });
    assert.equal(viaStart.job.id, String(paused._id));
    assert.equal(viaStart.job.status, "running");
    const done = await waitJob(paused._id, ["completed", "failed"]);
    assert.equal(done.status, "completed");
    assert.equal(done.success, 1);
    assert.equal(await MiswagSyncJob.countDocuments({ mode: "sync", strategy: "changed" }), 1);
  });

  it("pauses, resumes, and stops a changed sync without a preview id", async () => {
    await markConnected();
    await Product.create(sampleProduct("controls"));
    await mapDefaultCollection();
    let release = () => {};
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    installFetch(
      () =>
        new Promise((resolve) => {
          hold.then(() => resolve(mockResponse(201, { data: { item_id: "mw-controls" } })));
        })
    );
    const job = await MiswagSyncJob.create({
      partner: "miswag",
      status: "paused",
      mode: "sync",
      strategy: "changed",
      batchSize: 15,
      total: 1,
      cursorIbsherId: "",
      startedAt: new Date(),
    });
    try {
      const resumed = await resumeMiswagSyncAll();
      assert.equal(resumed.job.id, String(job._id));
      assert.equal(resumed.job.status, "running");
      assert.equal(resumed.job.strategy, "changed");
      let paused = null;
      for (let i = 0; i < 30; i += 1) {
        try {
          paused = await pauseMiswagSyncAll();
          break;
        } catch {
          await sleep(20);
        }
      }
      assert.equal(paused.job.status, "paused");
      const stopped = await stopMiswagSyncAll();
      assert.equal(stopped.job.status, "stopped");
      assert.equal(stopped.job.strategy, "changed");
      assert.equal(await MiswagProductSyncState.countDocuments({ externalId: "bs-ibs-controls" }), 0);
    } finally {
      release();
    }
    await sleep(200);
  });
});
