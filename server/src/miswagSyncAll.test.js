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
import { MiswagSyncJob } from "./models/MiswagSyncJob.js";
import { MiswagSyncProductResult } from "./models/MiswagSyncProductResult.js";
import { MiswagVariationBarcode } from "./models/MiswagVariationBarcode.js";
import { Partner } from "./models/Partner.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import { normalizeBrandKey, createBrandResolverCache } from "./services/miswagBrandResolve.js";
import {
  buildCategoryIndexes,
  resolveMiswagCategoryForProduct,
} from "./services/miswagCategoryResolve.js";
import {
  MISWAG_SYNC_BATCH_SIZE,
  evaluateMiswagProductForSync,
  ensureMiswagSyncRunner,
  pauseMiswagSyncAll,
  resumeMiswagSyncAll,
  runMiswagSyncPreview,
  startMiswagSyncAll,
  stopMiswagSyncAll,
} from "./services/miswagSyncAll.js";
import { buildMiswagProductPayload, miswagItemExternalId } from "./services/miswagTestProduct.js";
import { ensureProductVariationBarcodes } from "./services/miswagTestBarcodes.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-sync-all-test-secret";
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

function sampleProduct(id, overrides = {}) {
  return {
    ibsherId: `ibs-${id}`,
    itemCode: `SKU-${id}`,
    name: { en: "Food Processor Deluxe", ar: "محضرة طعام فاخرة", ku: "ئامێر" },
    description: { en: "desc", ar: "وصف عربي كافٍ للمنتج التجريبي", ku: "وەسف" },
    price: 7000,
    discountPrice: 0,
    isActive: true,
    keyword: ["processor", "kitchen"],
    brand: { _id: "brand-1", name: { en: "Philips" } },
    category: { _id: "cat-1", name: { en: "Home Appliances" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen Appliances" } },
    collectionName: { _id: "col-1", name: { en: "Food Processors" } },
    variants: [
      {
        _id: `var-${id}`,
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/sample.jpg", isMain: true }],
        sizes: [{ _id: `size-${id}`, size: "One Size", stockQuantity: 3 }],
      },
    ],
    ...overrides,
  };
}

const leafCategories = [
  {
    id: "L4-100",
    level: "L4",
    name: "Food Processors",
    nameEn: "Food Processors",
    nameAr: "محضرات",
    alias: "food-processors",
    path: "Home > Kitchen > Food Processors",
    active: true,
  },
  {
    id: "L4-200",
    level: "L4",
    name: "Toasters",
    nameEn: "Toasters",
    nameAr: "محامص",
    alias: "toasters",
    path: "Home > Kitchen > Toasters",
    active: true,
  },
];

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_sync_all";
  process.env.MISWAG_API_SECRET = "sk_prd_sync_all_secret";
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

describe("Miswag Sync All Products", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "miswag-sync-all@brownstore.test",
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
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setMiswagFetch(null);
    delete process.env.MISWAG_API_KEY;
    delete process.env.MISWAG_API_SECRET;
    await Promise.all([
      MiswagConnection.deleteMany({}),
      MiswagSyncJob.deleteMany({}),
      MiswagSyncProductResult.deleteMany({}),
      MiswagVariationBarcode.deleteMany({}),
      PlatformVisibilityRule.deleteMany({}),
      Product.deleteMany({}),
    ]);
  });

  it("uses prior client batch size 15", () => {
    assert.equal(MISWAG_SYNC_BATCH_SIZE, 15);
  });

  it("dry run sends zero Miswag product creates", async () => {
    await markConnected();
    await Product.create(sampleProduct("dry-1"));
    let createCalls = 0;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
      }
      if (method === "POST" && String(url).includes("/v1/items/bulk-create")) {
        createCalls += 1;
        return mockResponse(201, { data: { item_id: "should-not-happen" } });
      }
      return mockResponse(404, {});
    });

    const preview = await runMiswagSyncPreview();
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sentToMiswag, 0);
    assert.equal(createCalls, 0);
    assert.equal(preview.job.ready >= 1, true);
  });

  it("keeps stable external_id and shared rounded price", async () => {
    const doc = await Product.create(sampleProduct("price-1"));
    const rules = await Commission.find({ partner: "miswag" }).lean();
    const pricing = partnerPricePreview(doc, rules);
    assert.equal(pricing.storePrice, 7000);
    assert.equal(pricing.rate, 10);
    assert.equal(pricing.price, 7750);
    assert.equal(miswagItemExternalId(doc), "bs-ibs-price-1");
    const built = buildMiswagProductPayload(doc, {
      rules,
      categoryId: "L4-100",
      brandId: "42",
      barcodeAssignments: await ensureProductVariationBarcodes(doc),
    });
    assert.equal(built.payload.external_id, "bs-ibs-price-1");
    assert.equal(built.payload.price, 7750);
    const after = await Product.findById(doc._id).lean();
    assert.equal(after.price, 7000);
  });

  it("excludes inactive products", async () => {
    const doc = await Product.create(sampleProduct("off-1"));
    await PlatformVisibilityRule.create({
      partner: "miswag",
      scope: "product",
      targetId: String(doc._id),
      isActive: false,
    });
    const indexes = buildCategoryIndexes(leafCategories);
    const cache = createBrandResolverCache();
    cache.set(normalizeBrandKey("Philips"), { ok: true, brand: { id: 42, name: "Philips" } });
    const { loadEligibilityContext } = await import("./utils/platformTaxonomy.js");
    const result = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      eligibility: await loadEligibilityContext("miswag"),
      categoryIndexes: indexes,
      brandCache: cache,
    });
    assert.equal(result.status, "INACTIVE");
  });

  it("category exact match works and ambiguous is skipped", () => {
    const indexes = buildCategoryIndexes([
      ...leafCategories,
      {
        id: "L4-101",
        level: "L4",
        nameEn: "Food Processors",
        nameAr: "",
        alias: "",
        path: "Other > Food Processors",
        active: true,
      },
    ]);
    const exact = resolveMiswagCategoryForProduct(
      { collectionName: { name: { en: "Toasters" } } },
      indexes
    );
    assert.equal(exact.ok, true);
    assert.equal(exact.category.id, "L4-200");

    const ambiguous = resolveMiswagCategoryForProduct(
      { collectionName: { name: { en: "Food Processors" } } },
      indexes
    );
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.reason, /could not be resolved safely/i);
  });

  it("brand exact match works and unresolved brand is skipped", async () => {
    const doc = await Product.create(sampleProduct("brand-1"));
    const indexes = buildCategoryIndexes(leafCategories);
    const cache = createBrandResolverCache();
    cache.set(normalizeBrandKey("Philips"), { ok: true, brand: { id: 42, name: "Philips" } });
    const ok = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      categoryIndexes: indexes,
      brandCache: cache,
    });
    assert.equal(ok.status, "READY");

    const missing = await Product.create(
      sampleProduct("brand-2", { brand: { _id: "b2", name: { en: "UnknownBrandXYZ" } } })
    );
    const cache2 = createBrandResolverCache();
    cache2.set(normalizeBrandKey("UnknownBrandXYZ"), {
      ok: false,
      reason: "Miswag brand could not be resolved safely",
      code: "brand_unresolved",
    });
    const bad = await evaluateMiswagProductForSync(missing, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      categoryIndexes: indexes,
      brandCache: cache2,
    });
    assert.equal(bad.status, "SKIPPED");
    assert.match(bad.reason, /brand could not be resolved safely/i);
  });

  it("missing image is blocked", async () => {
    const doc = await Product.create(
      sampleProduct("img-1", {
        variants: [
          {
            _id: "var-img",
            color: { name: { en: "Black" }, hex: "#000000" },
            images: [],
            sizes: [{ _id: "size-img", size: "One", stockQuantity: 1 }],
          },
        ],
      })
    );
    const indexes = buildCategoryIndexes(leafCategories);
    const cache = createBrandResolverCache();
    cache.set(normalizeBrandKey("Philips"), { ok: true, brand: { id: 42, name: "Philips" } });
    const result = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      categoryIndexes: indexes,
      brandCache: cache,
    });
    assert.equal(result.status, "SKIPPED");
    assert.match(result.reason, /image/i);
  });

  it("barcode generation remains stable across evaluate calls", async () => {
    const doc = await Product.create(sampleProduct("bc-1"));
    const first = await ensureProductVariationBarcodes(doc);
    const second = await ensureProductVariationBarcodes(doc);
    const key = [...first.keys()][0];
    assert.equal(first.get(key).barcode, second.get(key).barcode);
  });

  it("batch processing + 400 continues + 401 pauses + resume from checkpoint", async () => {
    await markConnected();
    await Product.create(sampleProduct("a"));
    await Product.create(sampleProduct("b"));
    await Product.create(sampleProduct("c"));

    let createCalls = 0;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
      }
      if (method === "POST" && String(url).includes("/v1/items/bulk-create")) {
        createCalls += 1;
        if (createCalls === 1) return mockResponse(400, { message: "bad product", errors: ["invalid"] });
        if (createCalls === 2) return mockResponse(401, { message: "Unauthorized" });
        return mockResponse(201, { data: { item_id: `mw-${createCalls}` } });
      }
      return mockResponse(404, {});
    });

    const started = await startMiswagSyncAll({ confirm: true });
    assert.equal(started.job.status, "running");

    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const job = await MiswagSyncJob.findById(started.job.id);
      if (job.status === "auth_failed") break;
    }

    const paused = await MiswagSyncJob.findById(started.job.id);
    assert.equal(paused.status, "auth_failed");
    assert.equal(paused.failed >= 1, true);
    assert.equal(paused.cursorIbsherId.length > 0, true);
    const cursorAfterAuth = paused.cursorIbsherId;

    // Fix auth responses and resume — should continue after checkpoint.
    createCalls = 0;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
      }
      if (method === "POST") return mockResponse(201, { data: { item_id: "mw-resume" } });
      return mockResponse(404, {});
    });
    await testMiswagConnection();

    const resumed = await resumeMiswagSyncAll();
    assert.equal(resumed.job.status, "running");

    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const job = await MiswagSyncJob.findById(started.job.id);
      if (job.status === "completed") break;
    }
    const done = await MiswagSyncJob.findById(started.job.id);
    assert.ok(["completed", "running", "paused"].includes(done.status));
    assert.ok(done.cursorIbsherId >= cursorAfterAuth || done.status === "completed");
  });

  it("429 and 5xx retry then succeed without stopping the job", async () => {
    await markConnected();
    await Product.create(sampleProduct("retry-1"));
    let attempts = 0;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
      }
      if (method === "POST") {
        attempts += 1;
        if (attempts === 1) return mockResponse(429, { message: "slow" }, { "retry-after": "0" });
        if (attempts === 2) return mockResponse(500, { message: "boom" });
        return mockResponse(201, { data: { item_id: "mw-ok" } });
      }
      return mockResponse(404, {});
    });

    // Patch sleep indirectly by using retry-after 0; still may wait briefly on 500 backoff.
    const started = await startMiswagSyncAll({ confirm: true });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const job = await MiswagSyncJob.findById(started.job.id);
      if (job.status === "completed") break;
    }
    const job = await MiswagSyncJob.findById(started.job.id);
    assert.equal(job.success >= 1, true);
    assert.ok(attempts >= 3);
  });

  it("backend restart can resume a running job from checkpoint", async () => {
    await markConnected();
    await Product.create(sampleProduct("restart-1"));
    await Product.create(sampleProduct("restart-2"));
    const total = 2;
    const job = await MiswagSyncJob.create({
      partner: "miswag",
      status: "running",
      mode: "sync",
      batchSize: 15,
      total,
      processed: 1,
      success: 1,
      cursorIbsherId: "ibs-restart-1",
      startedAt: new Date(),
    });

    let createCalls = 0;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips" }] } });
      }
      if (method === "POST") {
        createCalls += 1;
        return mockResponse(201, { data: { item_id: "mw-restart" } });
      }
      return mockResponse(404, {});
    });

    await ensureMiswagSyncRunner();
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const fresh = await MiswagSyncJob.findById(job._id);
      if (fresh.status === "completed") break;
    }
    const done = await MiswagSyncJob.findById(job._id);
    assert.equal(done.status, "completed");
    assert.equal(createCalls, 1);
    assert.ok(done.processed >= 2);
  });

  it("pause and stop work", async () => {
    await markConnected();
    await Product.insertMany([sampleProduct("p1"), sampleProduct("p2"), sampleProduct("p3")]);
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(200, { data: { content: leafCategories, paging: {} } });
      }
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips" }] } });
      }
      if (method === "POST") {
        await new Promise((r) => setTimeout(r, 80));
        return mockResponse(201, { data: { item_id: "x" } });
      }
      return mockResponse(404, {});
    });
    const started = await startMiswagSyncAll({ confirm: true });
    await new Promise((r) => setTimeout(r, 30));
    const paused = await pauseMiswagSyncAll();
    assert.equal(paused.job.status, "paused");
    const stopped = await stopMiswagSyncAll();
    assert.equal(stopped.job.status, "stopped");
  });

  it("does not restore Category Mapping or Customized Price architecture", () => {
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "services/platformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "services/miswagBarcodes.js")), false);
    const admin = fs.readFileSync(path.join(__dirname, "routes/admin.js"), "utf8");
    assert.equal(admin.includes("Per-product platform prices have been removed"), true);
  });

  it("IBSHER sync export remains intact", async () => {
    const admin = await import("./routes/admin.js");
    assert.equal(typeof admin.syncFromIbsher, "function");
  });

  it("preview API requires connection", async () => {
    const res = await call("POST", "/api/admin/platforms/miswag/sync-all/preview", { body: {} });
    assert.equal(res.status, 403);
  });

  it("preview Miswag 401 is not reported as session Unauthorized and clears Connected", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/categories/flat")) {
        return mockResponse(401, { message: "Unauthorized" });
      }
      return mockResponse(404, {});
    });
    const res = await call("POST", "/api/admin/platforms/miswag/sync-all/preview", { body: {} });
    assert.equal(res.status, 502);
    assert.notEqual(res.json.message, "Unauthorized");
    assert.match(res.json.message, /Authentication failed/i);
    assert.equal(res.json.miswagHttpStatus, 401);
    assert.equal(res.json.endpoint, "/v1/categories/flat");
    assert.equal(res.json.method, "GET");
    assert.equal(res.json.code, "auth_failed");
    const conn = await MiswagConnection.findOne({ singletonKey: "default" }).lean();
    assert.equal(conn.lastStatus, "auth_failed");
    assert.equal(conn.lastAuthOk, false);
  });
});
