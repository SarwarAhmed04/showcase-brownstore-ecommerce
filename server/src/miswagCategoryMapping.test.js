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
import { BrownTaxonomyKnownNode } from "./models/BrownTaxonomyKnownNode.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "./models/PlatformTaxonomyNotice.js";
import { Product } from "./models/Product.js";
import { TaxonomyBaseline } from "./models/TaxonomyBaseline.js";
import { User } from "./models/User.js";
import {
  listMiswagCategoryMappings,
  loadMiswagCategoryMappingMap,
  saveMiswagCategoryMapping,
} from "./services/miswagCategoryMapping.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import { evaluateMiswagProductForSync, runMiswagSyncPreview } from "./services/miswagSyncAll.js";
import { createBrandResolverCache, normalizeBrandKey } from "./services/miswagBrandResolve.js";
import { syncBrownTaxonomyNotices } from "./utils/taxonomyNotices.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-mapping-test-secret";
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

function product(id, collectionId = "col-1") {
  return {
    ibsherId: `ibs-${id}`,
    itemCode: `SKU-${id}`,
    name: { en: "Food Processor Deluxe", ar: "محضرة طعام فاخرة", ku: "ئامێر" },
    description: { en: "desc", ar: "وصف عربي كافٍ للمنتج التجريبي", ku: "وەسف" },
    price: 7000,
    isActive: true,
    brand: { _id: "brand-1", name: { en: "Philips" } },
    category: { _id: "cat-1", name: { en: "Home Appliances" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen Appliances" } },
    collectionName: { _id: collectionId, name: { en: "Food Processors" } },
    variants: [
      {
        _id: `var-${id}`,
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/sample.jpg", isMain: true }],
        sizes: [{ _id: `size-${id}`, size: "One Size", stockQuantity: 3 }],
      },
    ],
  };
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_mapping";
  process.env.MISWAG_API_SECRET = "sk_prd_mapping_secret";
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

describe("Miswag Mapping Categories", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("miswag-mapping"));
    const user = await User.create({
      email: "miswag-mapping@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "miswag", name: "Miswag", isActive: true });
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
    ]);
  });

  it("saves a Collection → Miswag category mapping", async () => {
    await Product.create(product("save-1"));
    const saved = await saveMiswagCategoryMapping("col-1", {
      categoryId: "L4-100",
      categoryName: "Food Processors",
      categoryPath: "Home > Kitchen > Food Processors",
      categoryLevel: "L4",
    });
    assert.equal(saved.mapped, true);
    assert.equal(saved.miswag.categoryId, "L4-100");
    const row = await PlatformTaxonomyConfig.findOne({
      partner: "miswag",
      brownCollectionId: "col-1",
    }).lean();
    assert.equal(row.values.categoryId, "L4-100");
  });

  it("updates an existing mapping", async () => {
    await Product.create(product("upd-1"));
    await saveMiswagCategoryMapping("col-1", { categoryId: "L4-100", categoryName: "Old" });
    const updated = await saveMiswagCategoryMapping("col-1", {
      categoryId: "L3-55",
      categoryName: "New Leaf",
      categoryPath: "Path > New Leaf",
      categoryLevel: "L3",
    });
    assert.equal(updated.miswag.categoryId, "L3-55");
    assert.equal(updated.miswag.categoryName, "New Leaf");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "miswag" }), 1);
  });

  it("mapping persists in MongoDB across reloads", async () => {
    await Product.create(product("persist-1"));
    await saveMiswagCategoryMapping("col-1", {
      categoryId: "L4-200",
      categoryName: "Toasters",
    });
    const map = await loadMiswagCategoryMappingMap();
    assert.equal(map.get("col-1")?.categoryId, "L4-200");
    const listed = await listMiswagCategoryMappings({ status: "mapped" });
    assert.equal(listed.counts.mapped, 1);
    assert.equal(listed.rows[0].miswag.categoryId, "L4-200");
  });

  it("rejects invalid category ids", async () => {
    await Product.create(product("bad-1"));
    await assert.rejects(
      () => saveMiswagCategoryMapping("col-1", { categoryId: "L2-1" }),
      /L3|L4/i
    );
    await assert.rejects(
      () => saveMiswagCategoryMapping("col-1", { categoryId: "not-a-category" }),
      /L3|L4/i
    );
  });

  it("HTTP save + list endpoints work", async () => {
    await Product.create(product("http-1"));
    const put = await call("PUT", "/api/admin/platforms/miswag/mapping-categories/col-1", {
      body: {
        categoryId: "L4-100",
        categoryName: "Food Processors",
        categoryPath: "Home > Kitchen > Food Processors",
        categoryLevel: "L4",
      },
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.mapped, true);
    const get = await call("GET", "/api/admin/platforms/miswag/mapping-categories?status=mapped");
    assert.equal(get.status, 200);
    assert.equal(get.json.counts.mapped, 1);
    assert.equal(get.json.rows[0].path.includes("→"), true);
  });

  it("Sync All uses the saved mapping category id", async () => {
    const doc = await Product.create(product("sync-1"));
    await saveMiswagCategoryMapping("col-1", { categoryId: "L4-777", categoryName: "Mapped" });
    const cache = createBrandResolverCache();
    cache.set(normalizeBrandKey("Philips"), { ok: true, brand: { id: 42, name: "Philips" } });
    const result = await evaluateMiswagProductForSync(doc, {
      brandCache: cache,
    });
    assert.equal(result.status, "READY");
    assert.equal(result.categoryId, "L4-777");
  });

  it("unmapped Collection is skipped with Miswag category mapping missing", async () => {
    await markConnected();
    await Product.create(product("skip-1"));
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      return mockResponse(404, {});
    });
    const preview = await runMiswagSyncPreview();
    assert.equal(preview.job.ready, 0);
    assert.equal(preview.job.missingCategory, 1);
    assert.equal(preview.job.blockedSamples[0].reason, "Miswag category mapping missing");
  });

  it("current baseline Collections do not create historical alerts", async () => {
    await Product.create(product("base-1", "col-base"));
    const first = await syncBrownTaxonomyNotices();
    assert.equal(first.baseline, true);
    assert.equal(first.created, 0);
    assert.equal(
      await PlatformTaxonomyNotice.countDocuments({ partner: "miswag", scope: "collection" }),
      0
    );
    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.counts.total, 1);
    assert.equal(listed.counts.missing, 1);
    assert.equal(listed.counts.newCollectionAlerts, 0);
  });

  it("new Collection creates one Miswag notice and restart does not duplicate", async () => {
    await Product.create(product("base-2", "col-old"));
    await syncBrownTaxonomyNotices();
    await Product.create(product("new-1", "col-new"));
    const created = await syncBrownTaxonomyNotices();
    assert.ok(created.created >= 1);
    const open = await PlatformTaxonomyNotice.find({
      partner: "miswag",
      scope: "collection",
      targetId: "col-new",
      status: "open",
    }).lean();
    assert.equal(open.length, 1);
    assert.match(open[0].path, /→/);
    assert.ok(open[0].firstSeenAt);

    await syncBrownTaxonomyNotices();
    assert.equal(
      await PlatformTaxonomyNotice.countDocuments({
        partner: "miswag",
        scope: "collection",
        targetId: "col-new",
      }),
      1
    );

    const listed = await listMiswagCategoryMappings();
    assert.equal(listed.counts.newCollectionAlerts, 1);
    assert.equal(listed.notices[0].message, "New BrownStore collection needs Miswag category mapping");
  });

  it("saving a mapping resolves the new Collection notice", async () => {
    await Product.create(product("base-3", "col-old"));
    await syncBrownTaxonomyNotices();
    await Product.create(product("new-2", "col-new"));
    await syncBrownTaxonomyNotices();
    assert.equal(
      await PlatformTaxonomyNotice.countDocuments({
        partner: "miswag",
        scope: "collection",
        targetId: "col-new",
        status: "open",
      }),
      1
    );

    const saved = await saveMiswagCategoryMapping("col-new", {
      categoryId: "L4-100",
      categoryName: "Food Processors",
    });
    assert.equal(saved.noticeCount, 0);
    assert.equal(
      await PlatformTaxonomyNotice.countDocuments({
        partner: "miswag",
        scope: "collection",
        targetId: "col-new",
        status: "resolved",
      }),
      1
    );
  });

  it("does not restore the old PlatformCategoryMapping architecture", () => {
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "services/platformCategoryMapping.js")), false);
    assert.equal(
      fs.existsSync(path.join(__dirname, "../client/src/components/admin/MiswagCategoryMapping.jsx")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(__dirname, "services/miswagCategoryMapping.js")),
      true
    );
  });
});
