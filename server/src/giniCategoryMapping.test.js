import assert from "node:assert/strict";
import fs from "node:fs";
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
import { GiniConnection } from "./models/GiniConnection.js";
import { applyCommissionRate } from "./utils/commission.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH } from "./utils/giniSigner.js";
import { GINI_DEFAULT_BASE_URL, setGiniFetch } from "./services/giniConnection.js";
import {
  applyCategoryChange,
  applySubcategoryChange,
  categoryOptions,
  giniMappingStatus,
  giniMappingValues,
  normalizeGiniCategories,
  subcategoryOptions,
  summarizeGiniStatuses,
} from "./utils/giniCategoryTree.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "gini-category-mapping-test-secret";

const CLIENT_ID = "gini-category-client";
const SECRET = "gini-category-secret-not-for-the-browser";

const LIVE_TREE = {
  data: [
    {
      id: 1,
      name: "Home",
      slug: "home",
      is_active: 1,
      image_url: "https://cdn.test/secret-category-image",
      icon_url: "https://cdn.test/secret-icon",
      subcategories: [
        { id: 10, name: "Blenders", slug: "blenders", is_active: 1, image: "https://cdn.test/secret-sub-image" },
        { id: 11, name: "Retired blades", slug: "retired-blades", is_active: 0 },
      ],
    },
    {
      id: 2,
      name: "Hidden",
      slug: "hidden",
      is_active: 0,
      subcategories: [{ id: 20, name: "Archived", slug: "archived", is_active: 1 }],
    },
  ],
};

let memory;
let server;
let token;
const methods = [];

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

function mockResponse(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    async text() {
      return text;
    },
  };
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

function installGiniReads(body = LIVE_TREE) {
  methods.length = 0;
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    methods.push(method);
    if (method !== "GET") throw new Error(`GINI write attempted: ${method} ${url}`);
    if (String(url).endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (String(url).split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, body);
    throw new Error(`unexpected ${url}`);
  });
}

const categories = normalizeGiniCategories(LIVE_TREE).categories;

describe("GINI category tree rules", () => {
  it("keeps only active categories and the active subcategories of the selected category", () => {
    assert.deepEqual(categoryOptions(categories, "").map((category) => category.id), [1]);
    assert.deepEqual(subcategoryOptions(categories, "1", "").map((sub) => sub.id), [10]);
    assert.equal(subcategoryOptions(categories, "1", "").some((sub) => sub.id === 11), false);
  });

  it("clears the subcategory when the category changes", () => {
    const selected = applySubcategoryChange(categories, applyCategoryChange(categories, "1"), "10");
    assert.equal(selected.subcategoryId, "10");
    const changed = applyCategoryChange(categories, "1");
    assert.equal(changed.categoryId, "1");
    assert.equal(changed.subcategoryId, "");
    assert.equal(changed.subcategoryName, "");
  });

  it("requires both live IDs and never matches a collection by name", () => {
    assert.throws(() => giniMappingValues(categories, { categoryId: "1" }), /required/);
    assert.throws(() => giniMappingValues(categories, { subcategoryId: "10" }), /required/);
    assert.equal(giniMappingStatus({ categoryName: "Home", subcategoryName: "Blenders" }, categories), "missing");
    const saved = giniMappingValues(categories, {
      categoryId: "1",
      categoryName: "guessed name",
      subcategoryId: "10",
      subcategoryName: "guessed sub",
    });
    assert.deepEqual(saved, {
      categoryId: "1",
      categoryName: "Home",
      subcategoryId: "10",
      subcategoryName: "Blenders",
    });
  });

  it("classifies configured, missing, invalid, and inactive mappings without deleting them", () => {
    assert.equal(giniMappingStatus({}, categories), "missing");
    assert.equal(
      giniMappingStatus({ categoryId: "1", subcategoryId: "10", categoryName: "Old", subcategoryName: "Old" }, categories),
      "configured"
    );
    assert.equal(giniMappingStatus({ categoryId: "999", subcategoryId: "10" }, categories), "invalid");
    assert.equal(giniMappingStatus({ categoryId: "1", subcategoryId: "999" }, categories), "invalid");
    assert.equal(giniMappingStatus({ categoryId: "1", subcategoryId: "11" }, categories), "inactive");
    assert.equal(giniMappingStatus({ categoryId: "2", subcategoryId: "20" }, categories), "inactive");
    const legacy = subcategoryOptions(categories, "1", "11");
    assert.equal(legacy.find((sub) => String(sub.id) === "11").legacy, true);
    assert.equal(categoryOptions(categories, "2").some((category) => category.legacy && String(category.id) === "2"), true);
    const counts = summarizeGiniStatuses(["configured", "missing", "invalid", "inactive"]);
    assert.deepEqual(counts, { total: 4, configured: 1, missing: 1, invalid: 1, inactive: 1 });
  });
});

describe("GINI live category mapping", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-category-mapping"));
    const user = await User.create({
      email: "gini-categories@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "gini", name: "Gini" });
    await Product.create([
      {
        ibsherId: "blender-1",
        itemCode: "BL-1",
        name: { en: "Blender" },
        category: { _id: "home", name: { en: "Home Appliances" } },
        subCategory: { _id: "food", name: { en: "Food Preparation" } },
        collectionName: { _id: "blenders", name: { en: "Blenders" } },
      },
      {
        ibsherId: "toaster-1",
        itemCode: "TS-1",
        name: { en: "Toaster" },
        category: { _id: "home", name: { en: "Home Appliances" } },
        subCategory: { _id: "food", name: { en: "Food Preparation" } },
        collectionName: { _id: "toasters", name: { en: "Toasters" } },
      },
    ]);
    server = await listen(app());
  });

  after(async () => {
    setGiniFetch(null);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    methods.length = 0;
    setGiniFetch(null);
    await GiniConnection.deleteMany({});
    await PlatformTaxonomyConfig.deleteMany({ partner: "gini" });
  });

  it("requires an admin and a connected GINI API before reading categories", async () => {
    const anonymous = await call("GET", "/api/admin/platforms/gini/categories", { auth: false });
    assert.equal(anonymous.status, 401);
    installGiniReads();
    const blocked = await call("GET", "/api/admin/platforms/gini/categories");
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "connection_required");
    assert.equal(blocked.json.message, "Connect GINI API first");
    assert.deepEqual(methods, []);
  });

  it("loads the live category tree with GET only and hides credentials", async () => {
    installGiniReads();
    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const tested = await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(tested.json.categories.ok, true);
    assert.equal(tested.json.categories.topLevelCount, 2);
    methods.length = 0;
    const loaded = await call("GET", "/api/admin/platforms/gini/categories");
    const refreshed = await call("GET", "/api/admin/platforms/gini/categories?refresh=1");
    assert.equal(loaded.status, 200);
    assert.equal(refreshed.status, 200);
    assert.deepEqual(methods, ["GET", "GET"]);
    assert.equal(loaded.json.categories.length, 2);
    assert.equal(loaded.json.categories[0].isActive, true);
    assert.equal(loaded.json.categories[0].subcategories[0].isActive, true);
    assert.equal(loaded.json.categories[0].subcategories[1].isActive, false);
    assert.equal(loaded.raw.includes(SECRET), false);
    assert.equal(loaded.raw.includes(CLIENT_ID), false);
    assert.equal(loaded.raw.includes("clientSecret"), false);
    assert.equal(loaded.raw.includes("X-SIGNATURE"), false);
    assert.equal(loaded.raw.includes("secret-category-image"), false);
    assert.equal(loaded.raw.includes("secret-sub-image"), false);
    const stored = await GiniConnection.findOne({ singletonKey: "default" }).lean();
    assert.equal(stored.categories, undefined);
    assert.equal(JSON.stringify(stored).includes("Blenders"), false);
  });

  it("does not save a GINI mapping when the API is not connected", async () => {
    const existing = await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "blenders",
      values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" },
    });
    installGiniReads();
    const created = await call("PUT", "/api/admin/platforms/gini/category-setup/toasters", {
      body: { values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" } },
    });
    const changed = await call("PUT", "/api/admin/platforms/gini/category-setup/blenders", {
      body: { values: { categoryId: "1", categoryName: "Changed", subcategoryId: "11", subcategoryName: "Retired blades" } },
    });
    assert.equal(created.status, 409);
    assert.equal(changed.status, 409);
    assert.equal(created.json.code, "connection_required");
    assert.equal(created.json.message, "Connect GINI API first");
    assert.deepEqual(methods, []);
    const rows = await PlatformTaxonomyConfig.find({ partner: "gini" }).lean();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].brownCollectionId, "blenders");
    assert.equal(rows[0].values.categoryId, "1");
    assert.equal(rows[0].values.subcategoryId, "10");
    assert.equal(rows[0].values.categoryName, "Home");
    assert.equal(String(rows[0].updatedAt), String(existing.updatedAt));
  });

  it("saves one collection into PlatformTaxonomyConfig and leaves the others missing", async () => {
    installGiniReads();
    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const saved = await call("PUT", "/api/admin/platforms/gini/category-setup/blenders", {
      body: {
        values: {
          categoryId: "1",
          categoryName: "not the live name",
          subcategoryId: "10",
          subcategoryName: "not the live subcategory",
        },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.setup.values.categoryName, "Home");
    assert.equal(saved.json.setup.values.subcategoryName, "Blenders");
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "gini" }), 1);
    const setup = await call("GET", "/api/admin/platforms/gini/category-setup?limit=1000");
    const byId = Object.fromEntries(setup.json.rows.map((row) => [row.id, row]));
    assert.equal(giniMappingStatus(byId.blenders.values, categories), "configured");
    assert.equal(giniMappingStatus(byId.toasters.values, categories), "missing");
    assert.equal(byId.toasters.values.categoryId, undefined);

    const invalid = await call("PUT", "/api/admin/platforms/gini/category-setup/blenders", {
      body: { values: { categoryId: "999", categoryName: "Missing", subcategoryId: "10", subcategoryName: "Blenders" } },
    });
    assert.equal(invalid.status, 400);
    const inactive = await call("PUT", "/api/admin/platforms/gini/category-setup/toasters", {
      body: { values: { categoryId: "1", categoryName: "Home", subcategoryId: "11", subcategoryName: "Retired blades" } },
    });
    assert.equal(inactive.status, 400);
    const kept = await PlatformTaxonomyConfig.find({ partner: "gini" }).lean();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].brownCollectionId, "blenders");
    assert.equal(kept[0].values.subcategoryId, "10");

    await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "toasters",
      values: { categoryId: "2", categoryName: "Hidden", subcategoryId: "20", subcategoryName: "Archived" },
    });
    installGiniReads();
    setGiniFetch(async () => mockResponse(500, { message: "unavailable" }));
    const failed = await call("GET", "/api/admin/platforms/gini/categories?refresh=1");
    assert.equal(failed.status, 400);
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "gini" }), 2);
    assert.equal(
      giniMappingStatus(
        (await PlatformTaxonomyConfig.findOne({ partner: "gini", brownCollectionId: "toasters" }).lean()).values,
        categories
      ),
      "inactive"
    );
  });

  it("does not add a mapping model, GINI writes, Excel changes, commission changes, or Miswag changes", () => {
    assert.equal(fs.existsSync(new URL("./models/GiniCategoryMapping.js", import.meta.url)), false);
    assert.equal(mongoose.modelNames().includes("GiniCategoryMapping"), false);
    const panel = fs.readFileSync(
      new URL("../../client/src/components/admin/platform/CategorySetupPanel.jsx", import.meta.url),
      "utf8"
    );
    assert.match(panel, /applyCategoryChange/);
    assert.match(panel, /subcategoryOptions/);
    assert.match(panel, /giniCategories\(\{ refresh: true \}\)/);
    assert.match(panel, /giniConnectFirst/);
    assert.equal(panel.includes("fuzz"), false);
    assert.equal(panel.includes("autoMap"), false);
    const refresh = panel.slice(panel.indexOf("async function refreshCategories"), panel.indexOf("async function save"));
    assert.equal(refresh.includes("setRows([])"), false);
    assert.equal(refresh.includes("deleteMany"), false);
    const excel = fs.readFileSync(new URL("./utils/platformExcel/gini.js", import.meta.url), "utf8");
    assert.match(excel, /اسم المنتج/);
    assert.equal(excel.includes("fetchGiniCategoryTree"), false);
    const commission = fs.readFileSync(new URL("./utils/commission.js", import.meta.url), "utf8");
    assert.equal(commission.includes("giniCategoryTree"), false);
    assert.equal(applyCommissionRate(100000, 10), 110000);
    const miswag = fs.readFileSync(new URL("./services/miswag.js", import.meta.url), "utf8");
    assert.equal(miswag.includes("/api/v2.0/third-party/categories"), false);
    const tree = fs.readFileSync(new URL("./utils/giniCategoryTree.js", import.meta.url), "utf8");
    assert.equal(/fuzz|levenshtein|autoMap|suggestMapping/i.test(tree), false);
  });
});
