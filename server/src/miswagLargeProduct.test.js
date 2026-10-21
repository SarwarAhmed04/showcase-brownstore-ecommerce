import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter, syncFromIbsher } from "./routes/admin.js";
import { BrownTaxonomyKnownNode } from "./models/BrownTaxonomyKnownNode.js";
import { Commission } from "./models/Commission.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { MiswagSyncJob } from "./models/MiswagSyncJob.js";
import { MiswagSyncProductResult } from "./models/MiswagSyncProductResult.js";
import { MiswagVariationBarcode } from "./models/MiswagVariationBarcode.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "./models/PlatformTaxonomyNotice.js";
import { Product } from "./models/Product.js";
import { TaxonomyBaseline } from "./models/TaxonomyBaseline.js";
import { User } from "./models/User.js";
import { applyCommissionRate } from "./utils/commission.js";
import { GINI_HEADERS } from "./utils/platformExcel/gini.js";
import { evaluatePlatformEligibility } from "./utils/platformEligibility.js";
import { loadEligibilityContext } from "./utils/platformTaxonomy.js";
import { miswagIsLargeFlag } from "./utils/platformTaxonomyFields.js";
import { createBrandResolverCache, normalizeBrandKey } from "./services/miswagBrandResolve.js";
import {
  listMiswagCategoryMappings,
  loadMiswagCategoryMappingMap,
  saveMiswagCategoryMapping,
} from "./services/miswagCategoryMapping.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import { evaluateMiswagProductForSync, startMiswagSyncAll } from "./services/miswagSyncAll.js";
import {
  buildMiswagProductPayload,
  buildMiswagTestPayload,
  previewMiswagTestProduct,
  sendMiswagTestProduct,
} from "./services/miswagTestProduct.js";
import { syncBrownTaxonomyNotices } from "./utils/taxonomyNotices.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-large-product-test-secret";
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

function sampleProduct(id, collectionId = "col-1", collectionName = "Refrigerators", overrides = {}) {
  const { barcode, ...rest } = overrides;
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
    category: { _id: "cat-home", name: { en: "Home Appliances" } },
    subCategory: { _id: "sub-kitchen", name: { en: "Kitchen Appliances" } },
    collectionName: { _id: collectionId, name: { en: collectionName } },
    variants: [
      {
        _id: `var-${id}`,
        barcode: barcode || `6291041500${String(id).replace(/\D/g, "").padStart(3, "0").slice(-3)}`,
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/sample.jpg", isMain: true }],
        sizes: [{ _id: `size-${id}`, size: "One Size", stockQuantity: 3 }],
      },
    ],
    ...rest,
  };
}

function brandCache() {
  const cache = createBrandResolverCache();
  cache.set(normalizeBrandKey("Philips"), { ok: true, brand: { id: 42, name: "Philips" } });
  return cache;
}

function assertJsonBoolean(payload, expected) {
  assert.equal(typeof payload.is_large, "boolean");
  assert.equal(payload.is_large, expected);
  const json = JSON.stringify(payload);
  assert.match(json, new RegExp(`"is_large":${expected}`));
  assert.equal(json.includes('"is_large":"true"'), false);
  assert.equal(json.includes('"is_large":"false"'), false);
  assert.equal(json.includes('"is_large":1'), false);
  assert.equal(json.includes('"is_large":0'), false);
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_large";
  process.env.MISWAG_API_SECRET = "sk_prd_large_secret";
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

async function stored(collectionId) {
  return PlatformTaxonomyConfig.findOne({ partner: "miswag", brownCollectionId: collectionId }).lean();
}

describe("Miswag Large Product", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("miswag-large"));
    const user = await User.create({
      email: "miswag-large@brownstore.test",
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
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setMiswagFetch(null);
    await Promise.all([
      Product.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({}),
      PlatformTaxonomyNotice.deleteMany({}),
      BrownTaxonomyKnownNode.deleteMany({}),
      TaxonomyBaseline.deleteMany({}),
      MiswagConnection.deleteMany({}),
      MiswagVariationBarcode.deleteMany({}),
      MiswagSyncJob.deleteMany({}),
      MiswagSyncProductResult.deleteMany({}),
    ]);
  });

  it("new and unconfigured collections default to isLarge false", async () => {
    await Product.create(sampleProduct("new", "col-new", "Refrigerators"));
    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.rows[0].mapped, false);
    assert.equal(listed.rows[0].status, "missing");
    assert.equal(listed.rows[0].isLarge, false);
    assert.equal(listed.rows[0].miswag, null);
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "miswag" }), 0);
    assert.equal((await loadMiswagCategoryMappingMap()).has("col-new"), false);
    await assert.rejects(
      () => saveMiswagCategoryMapping("col-new", { isLarge: true }),
      /L3|L4/
    );
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "miswag" }), 0);
    const again = await listMiswagCategoryMappings();
    assert.equal(again.rows[0].mapped, false);
    assert.equal(again.rows[0].isLarge, false);
  });

  it("saving the toggle ON persists true and OFF persists false", async () => {
    await Product.create(sampleProduct("toggle", "col-1", "Refrigerators"));
    const on = await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-430",
      categoryName: "Refrigerators",
      isLarge: true,
    });
    assert.equal(on.mapped, true);
    assert.equal(on.isLarge, true);
    assert.equal(on.miswag.categoryId, "L3-430");
    assert.equal(on.miswag.isLarge, true);
    let row = await stored("col-1");
    assert.equal(row.values.isLarge, true);
    assert.equal(typeof row.values.isLarge, "boolean");

    const off = await saveMiswagCategoryMapping("col-1", { isLarge: false });
    assert.equal(off.isLarge, false);
    assert.equal(off.miswag.categoryId, "L3-430");
    row = await stored("col-1");
    assert.equal(row.values.isLarge, false);
    assert.equal(typeof row.values.isLarge, "boolean");
    assert.equal(row.values.categoryId, "L3-430");
  });

  it("reload returns the saved Large Product value", async () => {
    await Product.create(sampleProduct("reload", "col-1", "Refrigerators"));
    const put = await call("PUT", "/api/admin/platforms/miswag/mapping-categories/col-1", {
      body: { categoryId: "L3-430", categoryName: "Refrigerators", isLarge: true },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.isLarge, true);

    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.rows[0].isLarge, true);
    assert.equal(listed.rows[0].miswag.isLarge, true);
    const map = await loadMiswagCategoryMappingMap();
    assert.equal(map.get("col-1").isLarge, true);

    const get = await call("GET", "/api/admin/platforms/miswag/mapping-categories");
    assert.equal(get.status, 200);
    assert.equal(get.json.rows[0].isLarge, true);
    assert.equal(get.json.rows[0].miswag.categoryId, "L3-430");
    const reloaded = await stored("col-1");
    assert.equal(reloaded.values.isLarge, true);
    assert.equal(typeof reloaded.values.isLarge, "boolean");
  });

  it("existing mappings without isLarge resolve false", async () => {
    await Product.create(sampleProduct("legacy", "col-1", "Car Phone Holders"));
    await PlatformTaxonomyConfig.create({
      partner: "miswag",
      brownCollectionId: "col-1",
      values: {
        categoryId: "L3-346",
        categoryName: "Car Phone Holders",
        categoryLevel: "L3",
      },
    });
    const listed = await listMiswagCategoryMappings({ status: "mapped" });
    assert.equal(listed.counts.mapped, 1);
    assert.equal(listed.rows[0].mapped, true);
    assert.equal(listed.rows[0].isLarge, false);
    assert.equal(listed.rows[0].miswag.categoryId, "L3-346");
    assert.equal(listed.rows[0].miswag.isLarge, false);
    assert.equal((await loadMiswagCategoryMappingMap()).get("col-1").isLarge, false);
    assert.equal(miswagIsLargeFlag(undefined), false);
    assert.equal(miswagIsLargeFlag(null), false);
  });

  it("updating categoryId does not reset isLarge", async () => {
    await Product.create(sampleProduct("keep-large", "col-1", "Refrigerators"));
    await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-346",
      categoryName: "Refrigerators",
      categoryPath: "Home > Refrigerators",
      isLarge: true,
    });
    const updated = await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-500",
      categoryName: "Refrigerators",
    });
    assert.equal(updated.miswag.categoryId, "L3-500");
    assert.equal(updated.isLarge, true);
    const row = await stored("col-1");
    assert.equal(row.values.categoryId, "L3-500");
    assert.equal(row.values.isLarge, true);
    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.rows[0].miswag.categoryId, "L3-500");
    assert.equal(listed.rows[0].isLarge, true);
  });

  it("updating isLarge does not reset categoryId", async () => {
    await Product.create(sampleProduct("keep-cat", "col-1", "Refrigerators"));
    await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-346",
      categoryName: "Refrigerators",
      categoryPath: "Home > Refrigerators",
      categoryLevel: "L3",
      isLarge: true,
    });
    const updated = await saveMiswagCategoryMapping("col-1", { isLarge: false });
    assert.equal(updated.isLarge, false);
    assert.equal(updated.miswag.categoryId, "L3-346");
    assert.equal(updated.miswag.categoryName, "Refrigerators");
    assert.equal(updated.miswag.categoryPath, "Home > Refrigerators");
    const row = await stored("col-1");
    assert.equal(row.values.categoryId, "L3-346");
    assert.equal(row.values.categoryName, "Refrigerators");
    assert.equal(row.values.isLarge, false);
    assert.equal(typeof row.values.isLarge, "boolean");
  });

  it("string isLarge input is stored as a real boolean and does not clear categoryId", async () => {
    await Product.create(sampleProduct("coerce", "col-1", "Refrigerators"));
    await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-430",
      categoryName: "Refrigerators",
      isLarge: false,
    });
    const updated = await saveMiswagCategoryMapping("col-1", { isLarge: "true" });
    assert.equal(updated.isLarge, true);
    assert.equal(updated.miswag.categoryId, "L3-430");
    const row = await stored("col-1");
    assert.equal(row.values.isLarge, true);
    assert.equal(typeof row.values.isLarge, "boolean");
  });

  it("Sync 1 sends is_large true for an ON collection and false for an OFF collection", async () => {
    await markConnected();
    const onProduct = await Product.create(sampleProduct("on", "col-large", "Refrigerators", { barcode: "6291041500213" }));
    const offProduct = await Product.create(
      sampleProduct("off", "col-small", "Car Phone Holders", { barcode: "6291041500220" })
    );
    await saveMiswagCategoryMapping("col-large", { categoryId: "L3-430", categoryName: "Refrigerators", isLarge: true });
    await saveMiswagCategoryMapping("col-small", { categoryId: "L3-346", categoryName: "Holders", isLarge: false });

    const sent = [];
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "POST" && String(url).includes("/v1/items/bulk-create")) {
        sent.push(JSON.parse(options.body));
        return mockResponse(201, { data: { item_id: `mw-${sent.length}` } });
      }
      return mockResponse(404, {});
    });

    const onPreview = await previewMiswagTestProduct({
      productId: String(onProduct._id),
      categoryId: "L4-999",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(onPreview.largeProduct, "Yes");
    assert.equal(onPreview.isLarge, true);
    assert.equal(onPreview.canSend, true);
    assertJsonBoolean(onPreview.payloadPreview, true);

    const onSent = await sendMiswagTestProduct({
      productId: String(onProduct._id),
      categoryId: "L4-999",
      brandId: "42",
      confirm: true,
    });
    assert.equal(onSent.ok, true);

    const offPreview = await previewMiswagTestProduct({
      productId: String(offProduct._id),
      categoryId: "L3-346",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(offPreview.largeProduct, "No");
    assert.equal(offPreview.isLarge, false);
    assert.equal(offPreview.canSend, true);
    assert.equal(offPreview.eligibility.eligible, true);
    assertJsonBoolean(offPreview.payloadPreview, false);

    const offSent = await sendMiswagTestProduct({
      productId: String(offProduct._id),
      categoryId: "L3-346",
      brandId: "42",
      confirm: true,
    });
    assert.equal(offSent.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].category_id, "L4-999");
    assertJsonBoolean(sent[0], true);
    assert.equal(sent[1].category_id, "L3-346");
    assertJsonBoolean(sent[1], false);
    assert.equal(sent[0].variations[0].barcode, "6291041500213");
    assert.equal(sent[1].variations[0].barcode, "6291041500220");
  });

  it("Sync All sends the correct boolean per collection through the shared builder", async () => {
    assert.equal(buildMiswagProductPayload, buildMiswagTestPayload);
    const builder = fs.readFileSync(path.join(__dirname, "services/miswagTestProduct.js"), "utf8");
    const syncAll = fs.readFileSync(path.join(__dirname, "services/miswagSyncAll.js"), "utf8");
    assert.equal((builder.match(/is_large:/g) || []).length, 1);
    assert.equal((syncAll.match(/is_large:/g) || []).length, 0);
    assert.equal(syncAll.includes("buildMiswagTestPayload"), true);

    await markConnected();
    const large = await Product.create(sampleProduct("fridge", "col-fridge", "Refrigerators", { barcode: "6291041500313" }));
    const small = await Product.create(sampleProduct("holder", "col-holder", "Car Phone Holders", { barcode: "6291041500320" }));
    await saveMiswagCategoryMapping("col-fridge", { categoryId: "L3-430", categoryName: "Refrigerators", isLarge: true });
    await saveMiswagCategoryMapping("col-holder", { categoryId: "L3-346", categoryName: "Holders", isLarge: false });

    const rules = await Commission.find({ partner: "miswag" }).lean();
    const cache = brandCache();
    const largeResult = await evaluateMiswagProductForSync(large, { rules, brandCache: cache });
    const smallResult = await evaluateMiswagProductForSync(small, { rules, brandCache: brandCache() });
    assert.equal(largeResult.status, "READY");
    assert.equal(smallResult.status, "READY");
    assert.equal(largeResult.categoryId, "L3-430");
    assert.equal(smallResult.categoryId, "L3-346");
    assertJsonBoolean(largeResult.payload, true);
    assertJsonBoolean(smallResult.payload, false);
    assert.equal(largeResult.payload.price, 7750);
    assert.equal(smallResult.payload.price, 7750);
    assert.equal(largeResult.payload.variations[0].barcode, "6291041500313");
    assert.equal(smallResult.payload.variations[0].barcode, "6291041500320");

    const sent = [];
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (String(url).includes("/v1/brands/search")) {
        return mockResponse(200, { data: { content: [{ id: 42, name: "Philips", alias: "philips" }] } });
      }
      if (method === "POST" && String(url).includes("/v1/items/bulk-create")) {
        sent.push(JSON.parse(options.body));
        return mockResponse(201, { data: { item_id: `mw-${sent.length}` } });
      }
      return mockResponse(404, {});
    });

    const started = await startMiswagSyncAll({ confirm: true });
    let job = null;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      job = await MiswagSyncJob.findById(started.job.id);
      if (job?.status === "completed") break;
    }
    assert.equal(job.status, "completed");
    assert.equal(job.success, 2);
    assert.equal(sent.length, 2);
    const byId = new Map(sent.map((body) => [body.external_id, body]));
    assertJsonBoolean(byId.get("bs-ibs-fridge"), true);
    assert.equal(byId.get("bs-ibs-fridge").category_id, "L3-430");
    assertJsonBoolean(byId.get("bs-ibs-holder"), false);
    assert.equal(byId.get("bs-ibs-holder").category_id, "L3-346");
  });

  it("Large Product OFF does not block eligibility, and missing category mapping still blocks", async () => {
    const doc = await Product.create(sampleProduct("elig", "col-1", "Car Phone Holders", { barcode: "6291041500413" }));
    await saveMiswagCategoryMapping("col-1", { categoryId: "L3-346", isLarge: false });
    const eligibility = evaluatePlatformEligibility(doc, await loadEligibilityContext("miswag"));
    assert.equal(eligibility.eligible, true);
    const ready = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      eligibility: await loadEligibilityContext("miswag"),
      brandCache: brandCache(),
    });
    assert.equal(ready.status, "READY");
    assertJsonBoolean(ready.payload, false);

    await markConnected();
    const preview = await previewMiswagTestProduct({
      productId: String(doc._id),
      categoryId: "L3-346",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(preview.canSend, true);
    assert.equal(preview.largeProduct, "No");
    assert.equal(preview.eligibility.eligible, true);
    assert.equal(preview.blockReasons.some((reason) => /large/i.test(String(reason))), false);

    await PlatformTaxonomyConfig.deleteMany({ partner: "miswag" });
    const skipped = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      brandCache: brandCache(),
    });
    assert.equal(skipped.status, "SKIPPED");
    assert.equal(skipped.code, "category_mapping_missing");
    assert.equal(skipped.reason, "Miswag category mapping missing");

    await PlatformTaxonomyConfig.create({
      partner: "miswag",
      brownCollectionId: "col-1",
      values: { isLarge: true },
    });
    const stillBlocked = await evaluateMiswagProductForSync(doc, {
      rules: await Commission.find({ partner: "miswag" }).lean(),
      brandCache: brandCache(),
    });
    assert.equal(stillBlocked.code, "category_mapping_missing");
    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.rows[0].mapped, false);
    assert.equal(listed.counts.missing, 1);
  });

  it("a new collection still notifies about missing category mapping and defaults isLarge false", async () => {
    await Product.create(sampleProduct("base", "col-old", "Toasters"));
    const first = await syncBrownTaxonomyNotices();
    assert.equal(first.baseline, true);
    assert.equal(first.created, 0);
    await Product.create(sampleProduct("fresh", "col-fresh", "Refrigerators"));
    await syncBrownTaxonomyNotices();
    const open = await PlatformTaxonomyNotice.find({
      partner: "miswag",
      scope: "collection",
      targetId: "col-fresh",
      status: "open",
    }).lean();
    assert.equal(open.length, 1);
    const listed = await listMiswagCategoryMappings();
    const fresh = listed.rows.find((row) => row.id === "col-fresh");
    assert.equal(fresh.mapped, false);
    assert.equal(fresh.isLarge, false);
    assert.equal(listed.notices.length, 1);
    assert.equal(listed.notices[0].message, "New BrownStore collection needs Miswag category mapping");
    assert.equal(/large product/i.test(listed.notices[0].message), false);
    await syncBrownTaxonomyNotices();
    assert.equal(
      await PlatformTaxonomyNotice.countDocuments({
        partner: "miswag",
        scope: "collection",
        targetId: "col-fresh",
      }),
      1
    );
  });

  it("keeps Gini, IBSHER, commission rounding, and barcodes unchanged", async () => {
    const gini = fs.readFileSync(path.join(__dirname, "utils/platformExcel/gini.js"), "utf8");
    const ibsher = fs.readFileSync(path.join(__dirname, "services/ibsher.js"), "utf8");
    const commission = fs.readFileSync(path.join(__dirname, "utils/commission.js"), "utf8");
    const barcodes = fs.readFileSync(path.join(__dirname, "services/miswagTestBarcodes.js"), "utf8");
    assert.equal(gini.includes("isLarge"), false);
    assert.equal(gini.includes("is_large"), false);
    assert.equal(GINI_HEADERS.some((header) => /is_large|isLarge|Large Product/i.test(header)), false);
    assert.equal(ibsher.includes("isLarge"), false);
    assert.equal(ibsher.includes("is_large"), false);
    assert.equal(typeof syncFromIbsher, "function");
    assert.equal(commission.includes("isLarge"), false);
    assert.equal(commission.includes("is_large"), false);
    assert.equal(barcodes.includes("isLarge"), false);
    assert.equal(barcodes.includes("is_large"), false);
    assert.equal(applyCommissionRate(7000, 10), 7750);

    const doc = await Product.create(sampleProduct("price", "col-1", "Refrigerators", { barcode: "6291041500213" }));
    const rules = await Commission.find({ partner: "miswag" }).lean();
    const on = buildMiswagProductPayload(doc, {
      rules,
      categoryId: "L3-430",
      brandId: "42",
      isLarge: true,
    });
    const off = buildMiswagProductPayload(doc, {
      rules,
      categoryId: "L3-346",
      brandId: "42",
      isLarge: false,
    });
    assert.equal(on.payload.price, 7750);
    assert.equal(off.payload.price, 7750);
    assert.equal(on.payload.currency, "IQD");
    assertJsonBoolean(on.payload, true);
    assertJsonBoolean(off.payload, false);
    assert.equal(on.payload.variations[0].barcode, "6291041500213");
    assert.equal(off.payload.variations[0].barcode, "6291041500213");
    const after = await Product.findById(doc._id).lean();
    assert.equal(after.price, 7000);
  });

  it("does not restore the old category-mapping architecture", () => {
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "services/platformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategory.js")), false);
    const mapping = fs.readFileSync(path.join(__dirname, "services/miswagCategoryMapping.js"), "utf8");
    assert.equal(mapping.includes("PlatformCategoryMapping"), false);
    assert.equal(mapping.includes("PlatformTaxonomyConfig"), true);
    const ui = fs.readFileSync(
      path.join(__dirname, "../../client/src/components/admin/platform/MiswagMappingCategories.jsx"),
      "utf8"
    );
    assert.equal(ui.includes("Large Product"), true);
    assert.equal(ui.includes('on ? "ON" : "OFF"'), true);
    const i18n = fs.readFileSync(path.join(__dirname, "../../client/src/i18n.js"), "utf8");
    assert.equal(i18n.includes('miswagLargeProduct: "Large Product"'), true);
  });
});
