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
import { elryanProductWritesEnabled } from "./utils/elryanConstants.js";
import {
  elryanMappingIsComplete,
  elryanValuesForEnvironment,
  mergeElryanEnvironmentMapping,
} from "./utils/elryanTaxonomyMapping.js";
import { encryptApiKey } from "./utils/partnerAuth.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-phase31-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-phase31-test-key-not-for-browser-99";

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

const STAGING_CATALOG = [
  {
    id: 100,
    name: "Acne Patches",
    hierarchy: "Beauty & Personal Care : Skin Care : Acne Patches",
    isParent: false,
    level: 3,
    attributeSetId: 7,
    parentId: 10,
  },
  {
    id: 10,
    name: "Skin Care",
    hierarchy: "Beauty & Personal Care : Skin Care",
    isParent: true,
    level: 2,
    attributeSetId: null,
    parentId: 1,
  },
  {
    id: 200,
    name: "Door Locks",
    hierarchy: "Home : Hardware : Door Locks",
    isParent: false,
    level: 3,
    attributeSetId: 9,
  },
  {
    id: 201,
    name: "أقفال الأبواب",
    hierarchy: "المنزل : الأدوات : أقفال الأبواب",
    isParent: false,
    level: 3,
    attributeSetId: 9,
  },
];

describe("Elryan taxonomy env helpers", () => {
  it("never treats untagged flat staging fields as production", () => {
    const values = {
      categoryId: "100",
      categoryName: "Acne Patches",
      categoryHierarchy: "Beauty : Acne Patches",
      attributeSetId: "7",
    };
    assert.equal(elryanMappingIsComplete(values, "staging"), true);
    assert.equal(elryanMappingIsComplete(values, "production"), false);
    assert.equal(elryanValuesForEnvironment(values, "production").categoryId, "");
  });

  it("keeps staging and production environments isolated under values.environments", () => {
    const first = mergeElryanEnvironmentMapping({}, "staging", {
      categoryId: "100",
      categoryName: "Acne",
      categoryHierarchy: "H",
      attributeSetId: "7",
    });
    const both = mergeElryanEnvironmentMapping(first, "production", {
      categoryId: "900",
      categoryName: "Prod Leaf",
      categoryHierarchy: "Prod H",
      attributeSetId: "1",
    });
    assert.equal(elryanValuesForEnvironment(both, "staging").categoryId, "100");
    assert.equal(elryanValuesForEnvironment(both, "production").categoryId, "900");
    assert.equal(both.environments.staging.categoryId, "100");
    assert.equal(both.environments.production.categoryId, "900");
  });
});

describe("Elryan Phase 3.1 smart + manual mapping save", () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri());
    await User.deleteMany({});
    const admin = await User.create({
      email: "elryan-p31@example.com",
      passwordHash: "x",
      role: "admin",
      name: "Elryan P31 Admin",
    });
    token = jwt.sign({ sub: String(admin._id), role: "admin" }, process.env.JWT_SECRET, {
      expiresIn: "2h",
    });
    await Partner.deleteMany({});
    await Partner.create({ slug: "elryan", name: "Elryan" });
    await Partner.create({ slug: "miswag", name: "Miswag" });
    await Partner.create({ slug: "gini", name: "Gini" });
    server = await listen(app());
  });

  after(async () => {
    setElryanFetch(null);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setElryanFetch(async () =>
      mockResponse(200, {
        data: {
          id: "as-7",
          name: "Beauty set",
          attributes: [
            { id: "a1", code: "brand", name: "Brand", mandatory: true, input: "select", values: [] },
          ],
        },
      })
    );
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
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: STAGING_CATALOG.length,
      reportedTotal: STAGING_CATALOG.length,
      categories: STAGING_CATALOG,
    });
    await Product.create({
      ibsherId: "ibs-p31-1",
      itemCode: "P31-SKU-1",
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

  it("rejects unauthenticated mapping save", async () => {
    const res = await call(
      "POST",
      "/api/admin/platforms/elryan/mapping/save",
      {
        body: { brownCollectionId: "col-acne", categoryId: "100", confirm: true },
        auth: false,
      }
    );
    assert.ok(res.status === 401 || res.status === 403);
  });

  it("preview never auto-saves even for HIGH confidence rows", async () => {
    const before = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    const preview = await call("GET", "/api/admin/platforms/elryan/mapping-preview?limit=20");
    assert.equal(preview.status, 200);
    assert.equal(preview.json.mappingPersistence, "explicit_save_only");
    assert.equal(preview.json.sentToElryan, false);
    for (const row of preview.json.rows || []) {
      assert.equal(row.autoSave, false);
      assert.equal(row.previewOnly, true);
    }
    const after = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    assert.equal(after, before);
  });

  it("manual snapshot search matches English, Arabic, hierarchy, and ID with pagination", async () => {
    const byName = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping/snapshot-search?q=Acne&limit=10&offset=0"
    );
    assert.equal(byName.status, 200);
    assert.ok(byName.json.categories.some((c) => String(c.categoryId) === "100"));

    const byAr = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping/snapshot-search?q=%D8%A3%D9%82%D9%81%D8%A7%D9%84&limit=10"
    );
    assert.equal(byAr.status, 200);
    assert.ok(byAr.json.categories.some((c) => String(c.categoryId) === "201"));

    const byId = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping/snapshot-search?q=200&limit=10"
    );
    assert.equal(byId.status, 200);
    assert.ok(byId.json.categories.some((c) => String(c.categoryId) === "200"));

    const leafOnly = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping/snapshot-search?leafOnly=1&limit=50"
    );
    assert.equal(leafOnly.status, 200);
    assert.ok(leafOnly.json.categories.every((c) => c.isParent === false));
    assert.ok(leafOnly.json.categories.every((c) => c.kind === "leaf"));

    const page = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping/snapshot-search?limit=1&offset=1"
    );
    assert.equal(page.status, 200);
    assert.equal(page.json.categories.length, 1);
    assert.equal(page.json.offset, 1);
    assert.ok(page.json.totalMatching >= 2);
  });

  it("preview-save blocks parent categories and rejects invented IDs", async () => {
    const parent = await call("POST", "/api/admin/platforms/elryan/mapping/preview-save", {
      body: { brownCollectionId: "col-acne", categoryId: "10", includeAttributes: false },
    });
    assert.equal(parent.status, 200);
    assert.equal(parent.json.canSave, false);
    assert.equal(parent.json.elryan.kind, "parent");
    assert.ok(parent.json.blockers.length >= 1);

    const invented = await call("POST", "/api/admin/platforms/elryan/mapping/preview-save", {
      body: { brownCollectionId: "col-acne", categoryId: "999999", includeAttributes: false },
    });
    assert.equal(invented.status, 400);
    assert.equal(invented.json.code, "category_not_in_snapshot");
  });

  it("requires confirm:true and does not write without it", async () => {
    const denied = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "100" },
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, "confirm_required");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" }), 0);
  });

  it("rejects parent save even with confirm", async () => {
    const denied = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "10", confirm: true },
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, "mapping_blocked");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" }), 0);
  });

  it("saves verified leaf mapping by collection ID with read-back", async () => {
    let sawNonGet = false;
    setElryanFetch(async (_url, options = {}) => {
      const method = String(options.method || "GET").toUpperCase();
      if (method !== "GET" && method !== "HEAD") sawNonGet = true;
      return mockResponse(200, {
        data: {
          id: "as-7",
          name: "Beauty set",
          attributes: [{ id: "a1", code: "brand", name: "Brand", mandatory: true }],
        },
      });
    });

    const saved = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: {
        brownCollectionId: "col-acne",
        categoryId: "100",
        confirm: true,
        source: "smart",
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.ok, true);
    assert.equal(saved.json.sentToElryan, false);
    assert.equal(saved.json.productWrites, false);
    assert.equal(saved.json.readBackConfirmed, true);
    assert.equal(saved.json.brownCollectionId, "col-acne");
    assert.equal(saved.json.values.categoryId, "100");
    assert.equal(saved.json.values.categoryName, "Acne Patches");
    assert.equal(saved.json.values.attributeSetId, "7");
    assert.equal(saved.json.environment, "staging");
    assert.equal(sawNonGet, false);

    const doc = await PlatformTaxonomyConfig.findOne({
      partner: "elryan",
      brownCollectionId: "col-acne",
    }).lean();
    assert.ok(doc);
    assert.equal(doc.values.environments.staging.categoryId, "100");
    assert.equal(doc.values.elryanEnvironment, "staging");

    const preview = await call(
      "GET",
      "/api/admin/platforms/elryan/mapping-preview?brownCollectionId=col-acne&limit=5"
    );
    assert.equal(preview.status, 200);
    const row = preview.json.rows.find((r) => r.brownCollectionId === "col-acne");
    assert.ok(row);
    assert.equal(row.existingMapping.configured, true);
    assert.equal(row.existingMapping.values.categoryId, "100");
  });

  it("requires overwrite:true when replacing an existing mapping", async () => {
    await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "100", confirm: true },
    });
    const blocked = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "200", confirm: true },
    });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "overwrite_required");
    assert.ok(Array.isArray(blocked.json.details?.changes));

    const still = await PlatformTaxonomyConfig.findOne({
      partner: "elryan",
      brownCollectionId: "col-acne",
    }).lean();
    assert.equal(still.values.categoryId, "100");

    const overwritten = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: {
        brownCollectionId: "col-acne",
        categoryId: "200",
        confirm: true,
        overwrite: true,
        source: "manual",
      },
    });
    assert.equal(overwritten.status, 200);
    assert.equal(overwritten.json.values.categoryId, "200");
    assert.equal(overwritten.json.readBackConfirmed, true);
  });

  it("blocks production mapping saves when only a staging snapshot exists", async () => {
    await ElryanConnection.findOneAndUpdate(
      { singletonKey: "default" },
      {
        $set: {
          environment: "production",
          productionApiKeyEnc: encryptApiKey(API_KEY),
          hasApiKey: true,
        },
      }
    );
    const res = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "100", confirm: true },
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "catalog_env_unavailable");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" }), 0);
  });

  it("does not mutate Miswag or GINI configs when saving Elryan mapping", async () => {
    await PlatformTaxonomyConfig.create([
      { partner: "miswag", brownCollectionId: "col-acne", values: { categoryId: "L3-keep" } },
      {
        partner: "gini",
        brownCollectionId: "col-acne",
        values: { categoryId: "g1", categoryName: "G", subcategoryId: "s1", subcategoryName: "S" },
      },
    ]);
    const saved = await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "100", confirm: true },
    });
    assert.equal(saved.status, 200);
    const miswag = await PlatformTaxonomyConfig.findOne({ partner: "miswag" }).lean();
    const gini = await PlatformTaxonomyConfig.findOne({ partner: "gini" }).lean();
    assert.equal(miswag.values.categoryId, "L3-keep");
    assert.equal(gini.values.categoryId, "g1");
    assert.equal(gini.values.subcategoryId, "s1");
  });

  it("keeps product write gates disabled and never issues product writes during mapping save", async () => {
    assert.equal(elryanProductWritesEnabled(), false);
    let methods = [];
    setElryanFetch(async (_url, options = {}) => {
      methods.push(String(options.method || "GET").toUpperCase());
      return mockResponse(200, {
        data: { id: "as-7", name: "Beauty", attributes: [] },
      });
    });
    await call("POST", "/api/admin/platforms/elryan/mapping/save", {
      body: { brownCollectionId: "col-acne", categoryId: "100", confirm: true },
    });
    assert.ok(methods.every((m) => m === "GET" || m === "HEAD"));
  });
});
