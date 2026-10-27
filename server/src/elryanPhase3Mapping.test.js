import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanCategoryCatalogSnapshot } from "./models/ElryanCategoryCatalogSnapshot.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  __resetElryanCatalogJobsForTests,
  startElryanCategoryCatalogSync,
} from "./services/elryanCategoryCatalogSync.js";
import { elryanProductWritesEnabled } from "./utils/elryanConstants.js";
import {
  categoryFingerprint,
  extractElryanListMeta,
  normalizeCategoryRecord,
} from "./utils/elryanPagination.js";
import {
  acnePatchesNeedsReviewExample,
  scoreElryanCategoryCandidate,
  suggestElryanCategoriesForCollection,
} from "./utils/elryanMappingSuggest.js";
import { encryptApiKey } from "./utils/partnerAuth.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-phase3-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-phase3-test-key-not-for-browser-88";

let memory;
let server;
let token;

function app() {
  const instance = express();
  instance.use(express.json({ limit: "1mb" }));
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
  return { status: response.status, json, raw: JSON.stringify(json) };
}

function mockResponse(status, body = {}, headers = {}) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  const headerMap = new Map(
    Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [
      String(k).toLowerCase(),
      String(v),
    ])
  );
  return {
    status,
    headers: {
      get(name) {
        return headerMap.get(String(name).toLowerCase()) || null;
      },
    },
    async text() {
      return text;
    },
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Elryan Phase 3 pagination helpers", () => {
  it("extracts OpenAPI meta.page/limit/total", () => {
    const meta = extractElryanListMeta({
      success: true,
      data: [],
      meta: { page: 1, limit: 50, total: 120, timestamp: "2026-01-01T00:00:00.000Z" },
    });
    assert.equal(meta.reliable, true);
    assert.equal(meta.total, 120);
    assert.equal(meta.limit, 50);
  });

  it("marks incomplete meta as unreliable", () => {
    const meta = extractElryanListMeta({ data: [], meta: { timestamp: "x" } });
    assert.equal(meta.reliable, false);
    assert.equal(meta.reason, "meta_incomplete");
  });

  it("deduplicates by category id fingerprint", () => {
    const a = categoryFingerprint([{ id: 1 }, { id: 2 }]);
    const b = categoryFingerprint([{ id: 1 }, { id: 2 }]);
    assert.equal(a, b);
    assert.equal(normalizeCategoryRecord({ id: 10, name: "A", isParent: false }).id, 10);
  });
});

describe("Elryan Phase 3 smart matching", () => {
  it("exact leaf match with hierarchy context → HIGH", () => {
    const scored = scoreElryanCategoryCandidate(
      {
        brownCollectionName: { en: "Acne Patches" },
        brownSubCategoryName: { en: "Skin Care" },
        brownCategoryName: { en: "Beauty & Personal Care" },
      },
      {
        id: 1,
        name: "Acne Patches",
        hierarchy: "Beauty & Personal Care : Skin Care : Acne Patches",
        isParent: false,
        attributeSetId: 9,
      }
    );
    assert.equal(scored.confidence, "HIGH");
  });

  it("Acne Patches vs Blackhead & Acne Removers → NEEDS_REVIEW", () => {
    const scored = acnePatchesNeedsReviewExample();
    assert.equal(scored.confidence, "NEEDS_REVIEW");
    assert.match(scored.reasons.join(" "), /review/i);
  });

  it("no similar categories → NO_MATCH / empty candidates", () => {
    const result = suggestElryanCategoriesForCollection(
      {
        brownCollectionName: { en: "Quantum Widgets" },
        brownSubCategoryName: { en: "Lab Gear" },
        brownCategoryName: { en: "Science" },
      },
      [{ id: 2, name: "Sofas", hierarchy: "Home : Furniture : Sofas", isParent: false }]
    );
    assert.ok(
      result.overallConfidence === "NO_MATCH" ||
        result.candidates.every((c) => c.score < 40)
    );
  });

  it("prefers leaf over parent when scores are close", () => {
    const result = suggestElryanCategoriesForCollection(
      {
        brownCollectionName: { en: "Smartphones" },
        brownSubCategoryName: { en: "Mobiles" },
        brownCategoryName: { en: "Electronics" },
      },
      [
        {
          id: 1,
          name: "Mobiles",
          hierarchy: "Electronics : Mobiles",
          isParent: true,
        },
        {
          id: 2,
          name: "Smartphones",
          hierarchy: "Electronics : Mobiles : Smartphones",
          isParent: false,
          attributeSetId: 3,
        },
      ]
    );
    assert.equal(result.candidates[0].categoryId, 2);
    assert.equal(result.candidates[0].leafPreferred, true);
  });
});

describe("Elryan Phase 3 catalog sync + mapping preview (mocked)", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-phase3"));
    const user = await User.create({
      email: "elryan-phase3@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Elryan Phase3",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan" });
    await Partner.create({ slug: "miswag", name: "Miswag" });
    await Partner.create({ slug: "gini", name: "Gini" });
    server = await listen(app());
  });

  after(async () => {
    setElryanFetch(null);
    __resetElryanCatalogJobsForTests();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setElryanFetch(null);
    __resetElryanCatalogJobsForTests();
    await ElryanConnection.deleteMany({});
    await ElryanCategoryCatalogSnapshot.deleteMany({});
    await PlatformTaxonomyConfig.deleteMany({});
    await Product.deleteMany({});
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
    await Product.create({
      ibsherId: "ibs-p3-1",
      itemCode: "P3-SKU-1",
      name: { en: "Hydrocolloid Acne Patch Pack", ar: "لصقات" },
      description: { en: "Acne patch for skin care", ar: "وصف" },
      price: 5000,
      brand: { _id: "b1", name: { en: "Acme" } },
      category: { _id: "cat-beauty", name: { en: "Beauty & Personal Care" } },
      subCategory: { _id: "sub-skin", name: { en: "Skin Care" } },
      collectionName: { _id: "col-acne", name: { en: "Acne Patches" } },
      variants: [
        {
          color: { en: "Clear" },
          images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 2 }],
        },
      ],
      isActive: true,
    });
  });

  it("list categories returns pagination meta", async () => {
    setElryanFetch(async (url) => {
      assert.match(String(url), /page=1/);
      assert.match(String(url), /limit=50/);
      return mockResponse(200, {
        success: true,
        data: [{ id: 1, name: "Root", isParent: true, hierarchy: "Root", level: 1 }],
        meta: { page: 1, limit: 50, total: 1, timestamp: "t" },
      });
    });
    const res = await call("GET", "/api/admin/platforms/elryan/categories?page=1&limit=50");
    assert.equal(res.status, 200);
    assert.equal(res.json.meta.reliable, true);
    assert.equal(res.json.total, 1);
    assert.equal(res.json.categories[0].id, 1);
  });

  it("search is forwarded to Elryan", async () => {
    let hit = "";
    setElryanFetch(async (url) => {
      hit = String(url);
      return mockResponse(200, {
        data: [],
        meta: { page: 1, limit: 50, total: 0, timestamp: "t" },
      });
    });
    await call("GET", "/api/admin/platforms/elryan/categories?search=Door&page=1&limit=50");
    assert.match(hit, /search=Door/);
  });

  it("full catalog sync paginates, dedupes, and stops on repeated page", async () => {
    let pageHits = 0;
    const pageOne = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `Cat${i + 1}`,
      isParent: false,
      hierarchy: `Root : Cat${i + 1}`,
    }));
    setElryanFetch(async (url) => {
      const target = String(url);
      assert.equal(target.includes("staging-marketplace-api.elryan.com"), true);
      assert.equal(target.includes("marketplace-api.elryan.com/api/v1") && !target.includes("staging"), false);
      if (!target.includes("/v1/categories")) return mockResponse(200, {});
      pageHits += 1;
      const page = Number(new URL(target).searchParams.get("page") || "1");
      // total 100 with limit 50 ⇒ two expected pages; page 2 repeats page 1 ids.
      return mockResponse(200, {
        data: pageOne,
        meta: { page, limit: 50, total: 100, timestamp: "t" },
      });
    });

    const started = await call("POST", "/api/admin/platforms/elryan/category-catalog/sync", {
      body: { confirm: true },
    });
    assert.equal(started.status, 200);
    // Mocked pages can finish before the HTTP response is read.
    assert.ok(
      started.json.running === true ||
        ["complete", "incomplete", "failed", "cancelled"].includes(started.json.status)
    );

    for (let i = 0; i < 60; i += 1) {
      await wait(40);
      const status = await call("GET", "/api/admin/platforms/elryan/category-catalog/status");
      if (!status.json.running) break;
    }
    const done = await call("GET", "/api/admin/platforms/elryan/category-catalog/status");
    assert.ok(["complete", "incomplete", "failed"].includes(done.json.status));
    assert.ok(pageHits >= 2, `expected >=2 page hits, got ${pageHits}`);
    assert.ok(done.json.uniqueCount >= 2);
    assert.ok((done.json.warnings || []).some((w) => /repeated|already seen/i.test(w)));
  });

  it("incomplete meta terminates without claiming full coverage", async () => {
    setElryanFetch(async () =>
      mockResponse(200, {
        data: [{ id: 9, name: "X", hierarchy: "X", isParent: false }],
        meta: { timestamp: "t" },
      })
    );
    await startElryanCategoryCatalogSync({ confirm: true });
    for (let i = 0; i < 40; i += 1) {
      await wait(40);
      const snap = await ElryanCategoryCatalogSnapshot.findOne({ environment: "staging" }).lean();
      if (snap && snap.status !== "running") {
        assert.equal(snap.coverage, "unreliable_meta");
        assert.ok(snap.warnings.some((w) => /meta/i.test(w)));
        return;
      }
    }
    assert.fail("sync did not finish");
  });

  it("requires confirm:true and preserves existing mappings", async () => {
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "col-acne",
      values: {
        categoryId: "111",
        categoryName: "Saved Leaf",
        categoryHierarchy: "Home : Saved Leaf",
      },
    });
    const denied = await call("POST", "/api/admin/platforms/elryan/category-catalog/sync", {
      body: {},
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, "confirm_required");

    const existing = await PlatformTaxonomyConfig.findOne({
      partner: "elryan",
      brownCollectionId: "col-acne",
    }).lean();
    assert.equal(existing.values.categoryId, "111");
  });

  it("mapping preview is preview-only and does not save", async () => {
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 2,
      reportedTotal: 2,
      categories: [
        {
          id: 50,
          name: "Acne Patches",
          hierarchy: "Beauty & Personal Care : Skin Care : Acne Patches",
          isParent: false,
          level: 3,
          attributeSetId: 7,
        },
        {
          id: 51,
          name: "Blackhead & Acne Removers",
          hierarchy:
            "Beauty & Fragrance : Skin Care : Tools & Accessories : Blackhead & Acne Removers",
          isParent: false,
          level: 4,
        },
      ],
    });

    const before = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    const preview = await call("GET", "/api/admin/platforms/elryan/mapping-preview?limit=20");
    assert.equal(preview.status, 200);
    assert.equal(preview.json.mappingPersistence, "explicit_save_only");
    assert.equal(preview.json.writesDisabled, true);
    assert.ok(preview.json.rows.length >= 1);
    const row = preview.json.rows.find((r) => r.brownCollectionId === "col-acne");
    assert.ok(row);
    assert.equal(row.previewOnly, true);
    assert.equal(row.autoSave, false);
    const after = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    assert.equal(after, before);
  });

  it("attribute compatibility surfaces set fields without inventing ids", async () => {
    setElryanFetch(async (url) => {
      const target = String(url);
      if (target.includes("/attributes")) {
        return mockResponse(200, {
          data: [{ attributeId: 1, key: "brand", name: "Brand", source: "direct" }],
        });
      }
      if (target.includes("/attribute-sets/category/")) {
        return mockResponse(200, {
          data: {
            id: "as-1",
            name: "Beauty set",
            productNameFormat: "{brand} {name}",
            attributes: [
              { id: "a1", code: "brand", name: "Brand", mandatory: true, input: "select", values: [] },
              { id: "a2", code: "color", name: "Colour", mandatory: true, input: "select", values: [] },
            ],
          },
        });
      }
      return mockResponse(200, { data: [] });
    });
    const res = await call(
      "GET",
      "/api/admin/platforms/elryan/categories/50/attribute-compatibility"
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.attributeSetId, "as-1");
    assert.equal(res.json.hints.brandLikelyRequired, true);
    assert.equal(res.json.hints.colourLikelyRequired, true);
    assert.equal(res.json.previewOnly, true);
  });

  it("product write gates remain disabled and no write methods are issued", async () => {
    assert.equal(elryanProductWritesEnabled(), false);
    let sawWrite = false;
    setElryanFetch(async (_url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") sawWrite = true;
      return mockResponse(200, { data: [], meta: { page: 1, limit: 50, total: 0, timestamp: "t" } });
    });
    await call("GET", "/api/admin/platforms/elryan/categories?page=1&limit=50");
    assert.equal(sawWrite, false);
  });

  it("does not alter Miswag or GINI taxonomy configs during Elryan preview", async () => {
    await PlatformTaxonomyConfig.create([
      { partner: "miswag", brownCollectionId: "col-acne", values: { categoryId: "L3-keep" } },
      {
        partner: "gini",
        brownCollectionId: "col-acne",
        values: { categoryId: "g1", categoryName: "G", subcategoryId: "s1", subcategoryName: "S" },
      },
    ]);
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      categories: [{ id: 1, name: "X", hierarchy: "X", isParent: false }],
      uniqueCount: 1,
    });
    await call("GET", "/api/admin/platforms/elryan/mapping-preview");
    const miswag = await PlatformTaxonomyConfig.findOne({ partner: "miswag" }).lean();
    const gini = await PlatformTaxonomyConfig.findOne({ partner: "gini" }).lean();
    assert.equal(miswag.values.categoryId, "L3-keep");
    assert.equal(gini.values.categoryId, "g1");
  });
});
