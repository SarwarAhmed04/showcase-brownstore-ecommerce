import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { Commission } from "./models/Commission.js";
import { Partner } from "./models/Partner.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { seedPartners } from "./seedPartners.js";
import { saveFilterCommission } from "./utils/commission.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "platform-products-secret";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;
let server;
let token;
const byCode = new Map();

function app() {
  const instance = express();
  instance.use(express.json({ limit: "2mb" }));
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

function query(params = {}) {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : "";
}

function productsUrl(slug, params) {
  return `/api/admin/platforms/${slug}/products${query(params)}`;
}

function getProducts(slug, params) {
  return call("GET", productsUrl(slug, params));
}

function named(id, en) {
  return { _id: id, name: { en, ku: en, ar: en } };
}

function catalogProduct(code, overrides = {}) {
  return {
    ibsherId: code,
    itemCode: code,
    name: { en: code, ku: code, ar: code },
    price: 100000,
    discountPrice: 0,
    isActive: true,
    category: named("cat-plain", "Plain"),
    subCategory: named("sub-plain", "Plain Sub"),
    collectionName: named("col-plain", "Plain Collection"),
    brand: named("brand-plain", "Plain Brand"),
    createdBy: named("vendor-plain", "Plain Vendor"),
    ...overrides,
  };
}

function row(response, code) {
  return (response.json.products || []).find((item) => item.itemCode === code);
}

describe("platform products page", { concurrency: 1, timeout: 180000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("platform-products"));
    const user = await User.create({
      email: "platform-products@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await seedPartners();

    const pageDocs = [];
    for (let index = 1; index <= 60; index += 1) {
      const code = `PAGE-${String(index).padStart(3, "0")}`;
      pageDocs.push(
        catalogProduct(code, {
          price: 1000 + index,
          createdBy: named("vendor-page", "Page Vendor"),
          brand: named("brand-page", "Page Brand"),
          category: named("cat-page", "Page Category"),
          subCategory: named("sub-page", "Page Sub"),
          collectionName: named("col-page", "Page Collection"),
        })
      );
    }
    const inserted = await Product.insertMany([
      ...pageDocs,
      catalogProduct("BLENDER", {
        name: { en: "STAND BLENDER", ku: "STAND BLENDER", ar: "STAND BLENDER" },
        price: 100000,
        createdBy: named("vendor-home", "Home"),
        brand: named("brand-zilan", "ZILAN"),
        category: named("cat-kitchen", "Kitchen Appliances"),
        subCategory: named("sub-food", "Food Preparation"),
        collectionName: named("col-blenders", "Blenders"),
      }),
      catalogProduct("FRIDGE", {
        price: 100000,
        createdBy: named("vendor-spec", "Spec Vendor"),
        brand: named("brand-spec", "Spec Brand"),
        category: named("cat-spec", "Spec Category"),
        subCategory: named("sub-spec", "Spec Sub"),
        collectionName: named("col-fridge", "Refrigerators"),
      }),
      catalogProduct("WASH", {
        price: 100000,
        createdBy: named("vendor-spec", "Spec Vendor"),
        brand: named("brand-spec", "Spec Brand"),
        category: named("cat-spec", "Spec Category"),
        subCategory: named("sub-spec", "Spec Sub"),
        collectionName: named("col-wash", "Washers"),
      }),
      catalogProduct("OTHER-SUB", {
        price: 100000,
        createdBy: named("vendor-spec", "Spec Vendor"),
        brand: named("brand-spec", "Spec Brand"),
        category: named("cat-spec", "Spec Category"),
        subCategory: named("sub-other", "Other Sub"),
        collectionName: named("col-other", "Other Collection"),
      }),
      catalogProduct("OTHER-CAT", {
        price: 100000,
        createdBy: named("vendor-spec", "Spec Vendor"),
        brand: named("brand-spec", "Spec Brand"),
        category: named("cat-other", "Other Category"),
        subCategory: named("sub-other-cat", "Other Cat Sub"),
        collectionName: named("col-other-cat", "Other Cat Collection"),
      }),
      catalogProduct("RATE-7001", {
        price: 7001,
        createdBy: named("vendor-rate", "Rate Vendor"),
        brand: named("brand-rate", "Rate Brand"),
        category: named("cat-rate", "Rate Category"),
        subCategory: named("sub-rate", "Rate Sub"),
        collectionName: named("col-rate", "Rate Collection"),
      }),
      catalogProduct("NO-RULE", {
        price: 100000,
        createdBy: named("vendor-none", "None Vendor"),
        brand: named("brand-none", "None Brand"),
        category: named("cat-none", "None Category"),
        subCategory: named("sub-none", "None Sub"),
        collectionName: named("col-none", "None Collection"),
      }),
      catalogProduct("BLOCKED-1", {
        price: 61000,
        createdBy: named("vendor-blocked", "Blocked Vendor"),
        brand: named("brand-blocked", "Blocked Brand"),
        category: named("cat-blocked", "Blocked Category"),
        subCategory: named("sub-blocked", "Blocked Sub"),
        collectionName: named("col-blocked", "Blocked Collection"),
      }),
      catalogProduct("TOGGLE-1", {
        price: 100000,
        createdBy: named("vendor-toggle", "Toggle Vendor"),
        brand: named("brand-toggle", "Toggle Brand"),
        category: named("cat-toggle", "Toggle Category"),
        subCategory: named("sub-toggle", "Toggle Sub"),
        collectionName: named("col-toggle", "Toggle Collection"),
      }),
    ]);
    await Product.collection.bulkWrite(
      inserted
        .filter((doc) => String(doc.itemCode).startsWith("PAGE-"))
        .map((doc) => {
          const index = Number(String(doc.itemCode).slice(5)) - 1;
          return {
            updateOne: {
              filter: { _id: doc._id },
              update: { $set: { updatedAt: new Date(Date.UTC(2030, 0, 1) + index * 60000) } },
            },
          };
        })
    );
    const saved = await Product.find().select("_id itemCode price isActive").lean();
    for (const item of saved) byCode.set(item.itemCode, item);

    await saveFilterCommission({
      partner: "miswag",
      vendorId: "vendor-home",
      brandId: "brand-zilan",
      categoryId: "cat-kitchen",
      subCategoryId: "sub-food",
      collectionId: "col-blenders",
      percentage: 25,
    });
    await saveFilterCommission({
      partner: "miswag",
      vendorId: "vendor-spec",
      brandId: "brand-spec",
      categoryId: "cat-spec",
      percentage: 10,
    });
    await saveFilterCommission({
      partner: "miswag",
      vendorId: "vendor-spec",
      brandId: "brand-spec",
      categoryId: "cat-spec",
      subCategoryId: "sub-spec",
      percentage: 12,
    });
    await saveFilterCommission({
      partner: "miswag",
      vendorId: "vendor-spec",
      brandId: "brand-spec",
      categoryId: "cat-spec",
      subCategoryId: "sub-spec",
      collectionId: "col-fridge",
      percentage: 15,
    });
    await Commission.create([
      {
        partner: "miswag",
        scope: "brand",
        targetId: "brand-spec",
        targetName: { en: "Spec Brand", ku: "Spec Brand", ar: "Spec Brand" },
        percentage: 20,
        isActive: true,
      },
      {
        partner: "miswag",
        scope: "brand",
        targetId: "brand-rate",
        targetName: { en: "Rate Brand", ku: "Rate Brand", ar: "Rate Brand" },
        percentage: 10,
        isActive: true,
      },
      {
        partner: "elryan",
        scope: "brand",
        targetId: "brand-zilan",
        targetName: { en: "ZILAN", ku: "ZILAN", ar: "ZILAN" },
        percentage: 10,
        isActive: true,
      },
      {
        partner: "ibazzar",
        scope: "all",
        targetId: "*",
        targetName: { en: "All", ku: "All", ar: "All" },
        percentage: 5,
        isActive: true,
      },
      {
        partner: "gini",
        scope: "brand",
        targetId: "brand-none",
        targetName: { en: "None Brand", ku: "None Brand", ar: "None Brand" },
        percentage: 50,
        isActive: true,
      },
    ]);
    await PlatformVisibilityRule.create({
      partner: "miswag",
      scope: "product",
      targetId: String(byCode.get("BLOCKED-1")._id),
      isActive: false,
    });
    server = await listen(app());
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  it("keeps using the existing platform products endpoint", async () => {
    const admin = fs.readFileSync(path.join(__dirname, "routes/admin.js"), "utf8");
    const api = fs.readFileSync(path.join(__dirname, "../../client/src/api.js"), "utf8");
    const page = fs.readFileSync(path.join(__dirname, "../../client/src/pages/admin/Commissions.jsx"), "utf8");
    assert.equal(admin.match(/adminRouter\.get\("\/platforms\/:slug\/products"/g).length, 1);
    assert.equal(fs.existsSync(path.join(__dirname, "../../client/src/pages/admin/PlatformProducts.jsx")), false);
    assert.match(api, /adminPlatformProducts:/);
    assert.match(api, /\/platforms\/\$\{encodeURIComponent\(slug\)\}\/products/);
    assert.match(page, /PlatformTableProduct/);
    assert.match(page, /api\.adminPlatformProducts/);
    const response = await getProducts("miswag", { limit: 25, facets: "0" });
    assert.equal(response.status, 200);
    assert.ok(Array.isArray(response.json.products));
  });

  it("defaults to 50 and allows 25, 50, and 100, capping anything larger", async () => {
    const defaults = await getProducts("miswag", { facets: "0" });
    assert.equal(defaults.json.pagination.limit, 50);
    assert.equal(defaults.json.pagination.page, 1);
    assert.equal(defaults.json.products.length, 50);
    assert.ok(defaults.json.pagination.total > 50);
    assert.equal(defaults.json.pagination.hasPrev, false);
    assert.equal(defaults.json.pagination.hasNext, true);
    assert.equal(defaults.json.pagination.from, 1);
    assert.equal(defaults.json.pagination.to, 50);

    for (const limit of [25, 50, 100]) {
      const response = await getProducts("miswag", { limit, facets: "0" });
      assert.equal(response.json.pagination.limit, limit);
      assert.equal(response.json.products.length, Math.min(limit, response.json.pagination.total));
    }

    const capped = await getProducts("miswag", { limit: 500, facets: "0" });
    assert.equal(capped.json.pagination.limit, 100);
    assert.ok(capped.json.products.length <= 100);
    assert.equal(capped.json.products.length, capped.json.pagination.total);
  });

  it("returns only the requested page", async () => {
    const first = await getProducts("miswag", { vendor: "vendor-page", limit: 25, page: 1, facets: "0" });
    const second = await getProducts("miswag", { vendor: "vendor-page", limit: 25, page: 2, facets: "0" });
    assert.equal(first.json.products.length, 25);
    assert.equal(second.json.products.length, 25);
    assert.equal(second.json.products[0].itemCode, "PAGE-035");
    assert.equal(second.json.products.at(-1).itemCode, "PAGE-011");
    assert.equal(second.json.pagination.page, 2);
    assert.equal(second.json.pagination.pages, 3);
    assert.equal(second.json.pagination.total, 60);
    assert.equal(second.json.pagination.from, 26);
    assert.equal(second.json.pagination.to, 50);
    assert.equal(second.json.pagination.hasPrev, true);
    assert.equal(second.json.pagination.hasNext, true);
    const firstIds = new Set(first.json.products.map((item) => item.id));
    assert.equal(second.json.products.some((item) => firstIds.has(item.id)), false);
  });

  it("filters on the server by search, taxonomy, and eligibility", async () => {
    const search = await getProducts("miswag", { q: "PAGE-060", facets: "0" });
    assert.equal(search.json.products.length, 1);
    assert.equal(search.json.products[0].itemCode, "PAGE-060");

    const vendor = await getProducts("miswag", { vendor: "vendor-page", limit: 100, facets: "0" });
    assert.equal(vendor.json.pagination.total, 60);
    assert.equal(vendor.json.products.every((item) => item.itemCode.startsWith("PAGE-")), true);

    const brand = await getProducts("miswag", { brand: "brand-zilan", facets: "0" });
    assert.deepEqual(brand.json.products.map((item) => item.itemCode), ["BLENDER"]);

    const category = await getProducts("miswag", { category: "cat-kitchen", facets: "0" });
    assert.deepEqual(category.json.products.map((item) => item.itemCode), ["BLENDER"]);

    const subCategory = await getProducts("miswag", { subCategory: "sub-food", facets: "0" });
    assert.deepEqual(subCategory.json.products.map((item) => item.itemCode), ["BLENDER"]);

    const collection = await getProducts("miswag", { collection: "col-blenders", facets: "0" });
    assert.deepEqual(collection.json.products.map((item) => item.itemCode), ["BLENDER"]);

    const ready = await getProducts("miswag", { q: "BLOCKED-1", eligibility: "ready", facets: "0" });
    assert.equal(ready.json.products.length, 0);

    const blocked = await getProducts("miswag", { eligibility: "blocked", limit: 100, facets: "0" });
    assert.equal(blocked.json.products.some((item) => item.itemCode === "BLOCKED-1"), true);
    assert.equal(blocked.json.products.every((item) => item.eligibility.eligible === false), true);

    const inactive = await getProducts("miswag", { eligibility: "inactive", limit: 100, facets: "0" });
    const hidden = inactive.json.products.find((item) => item.itemCode === "BLOCKED-1");
    assert.ok(hidden);
    assert.equal(hidden.eligibility.reasons.some((reason) => reason.code === "product_inactive"), true);

    const visible = await getProducts("miswag", { q: "BLOCKED-1", eligibility: "all", facets: "0" });
    assert.equal(visible.json.products.length, 1);
    assert.equal(visible.json.products[0].eligibility.eligible, false);
    assert.equal(
      visible.json.products[0].eligibility.reasons.some((reason) => reason.code === "product_inactive"),
      true
    );
  });

  it("prices each platform from that platform's winning commission only", async () => {
    const miswag = row(await getProducts("miswag", { q: "BLENDER", facets: "0" }), "BLENDER");
    const gini = row(await getProducts("gini", { q: "BLENDER", facets: "0" }), "BLENDER");
    const elryan = row(await getProducts("elryan", { q: "BLENDER", facets: "0" }), "BLENDER");
    const ibazzar = row(await getProducts("ibazzar", { q: "BLENDER", facets: "0" }), "BLENDER");

    assert.equal(miswag.storePrice, 100000);
    assert.equal(miswag.commission.scope, "filter");
    assert.equal(miswag.commission.percentage, 25);
    assert.equal(
      miswag.commission.targetName.en,
      "Home → ZILAN → Kitchen Appliances → Food Preparation → Blenders"
    );
    assert.equal(miswag.commissionRate, 25);
    assert.equal(miswag.rawPrice, 125000);
    assert.equal(miswag.platformPrice, 125000);

    assert.equal(gini.storePrice, 100000);
    assert.equal(gini.commission, null);
    assert.equal(gini.commissionRate, 0);
    assert.equal(gini.rawPrice, 100000);
    assert.equal(gini.platformPrice, 100000);

    assert.equal(elryan.commission.scope, "brand");
    assert.equal(elryan.commission.percentage, 10);
    assert.equal(elryan.rawPrice, 110000);
    assert.equal(elryan.platformPrice, 110000);

    assert.equal(ibazzar.commission.scope, "all");
    assert.equal(ibazzar.commission.percentage, 5);
    assert.equal(ibazzar.rawPrice, 105000);
    assert.equal(ibazzar.platformPrice, 105000);

    const miswagNone = row(await getProducts("miswag", { q: "NO-RULE", facets: "0" }), "NO-RULE");
    const giniNone = row(await getProducts("gini", { q: "NO-RULE", facets: "0" }), "NO-RULE");
    assert.equal(miswagNone.commission, null);
    assert.equal(miswagNone.commissionRate, 0);
    assert.equal(miswagNone.rawPrice, 100000);
    assert.equal(miswagNone.platformPrice, 100000);
    assert.equal(giniNone.commission.scope, "brand");
    assert.equal(giniNone.commission.percentage, 50);
    assert.equal(giniNone.platformPrice, 150000);
  });

  it("lets the most specific filter win without stacking, and rounds only the final price", async () => {
    const fridge = row(await getProducts("miswag", { q: "FRIDGE", facets: "0" }), "FRIDGE");
    const wash = row(await getProducts("miswag", { q: "WASH", facets: "0" }), "WASH");
    const otherSub = row(await getProducts("miswag", { q: "OTHER-SUB", facets: "0" }), "OTHER-SUB");
    const otherCat = row(await getProducts("miswag", { q: "OTHER-CAT", facets: "0" }), "OTHER-CAT");
    const rated = row(await getProducts("miswag", { q: "RATE-7001", facets: "0" }), "RATE-7001");

    assert.equal(fridge.commission.scope, "filter");
    assert.equal(fridge.commission.percentage, 15);
    assert.equal(fridge.commissionRate, 15);
    assert.equal(fridge.rawPrice, 115000);
    assert.equal(fridge.platformPrice, 115000);

    assert.equal(wash.commission.scope, "filter");
    assert.equal(wash.commission.percentage, 12);
    assert.equal(wash.platformPrice, 112000);

    assert.equal(otherSub.commission.scope, "filter");
    assert.equal(otherSub.commission.percentage, 10);
    assert.equal(otherSub.platformPrice, 110000);

    assert.equal(otherCat.commission.scope, "brand");
    assert.equal(otherCat.commission.percentage, 20);
    assert.equal(otherCat.platformPrice, 120000);

    assert.equal(rated.storePrice, 7001);
    assert.equal(rated.commission.percentage, 10);
    assert.equal(rated.rawPrice, 7701.1);
    assert.equal(rated.platformPrice, 7750);
  });

  it("loads dependent catalog facets in one response and can skip them", async () => {
    const open = await getProducts("miswag", { limit: 25 });
    assert.equal(open.json.facets.vendors.some((item) => item.id === "vendor-page"), true);
    assert.equal(open.json.facets.brands.some((item) => item.id === "brand-zilan"), true);

    const narrowed = await getProducts("miswag", { vendor: "vendor-page", limit: 25 });
    assert.equal(narrowed.json.facets.brands.some((item) => item.id === "brand-page"), true);
    assert.equal(narrowed.json.facets.brands.some((item) => item.id === "brand-zilan"), false);
    assert.equal(narrowed.json.facets.categories.every((item) => item.id === "cat-page"), true);
    assert.equal(narrowed.json.facets.subcategories.every((item) => item.id === "sub-page"), true);
    assert.equal(narrowed.json.facets.collections.every((item) => item.id === "col-page"), true);

    const skipped = await getProducts("miswag", { page: 2, limit: 25, facets: "0" });
    assert.equal(skipped.json.facets, null);
    assert.equal(skipped.json.products.length, 25);
  });

  it("keeps availability control and does not store calculated platform prices", async () => {
    const id = String(byCode.get("TOGGLE-1")._id);
    const before = await Product.findById(id).lean();
    const hidden = await call("POST", "/api/admin/platforms/miswag/availability", {
      body: { scope: "product", targetId: id, isActive: false },
    });
    assert.equal(hidden.status, 200);
    const listed = row(await getProducts("miswag", { q: "TOGGLE-1", facets: "0" }), "TOGGLE-1");
    assert.equal(listed.platformActive, false);
    const stored = await Product.findById(id).lean();
    assert.equal(stored.isActive, true);
    assert.equal(stored.price, before.price);
    assert.equal(stored.platformPrice, undefined);
    assert.equal(stored.rawPrice, undefined);
    assert.equal(stored.rawPlatformPrice, undefined);

    const priced = await call("PATCH", `/api/admin/platforms/miswag/products/${id}`, {
      body: { price: 50 },
    });
    assert.equal(priced.status, 410);
    const after = await Product.findById(id).lean();
    assert.equal(after.price, before.price);
    assert.equal(after.platformPrice, undefined);
    assert.equal(after.discountPrice, 0);

    const restored = await call("POST", "/api/admin/platforms/miswag/availability", {
      body: { scope: "product", targetId: id, isActive: true },
    });
    assert.equal(restored.status, 200);
    const visible = row(await getProducts("miswag", { q: "TOGGLE-1", facets: "0" }), "TOGGLE-1");
    assert.equal(visible.platformActive, true);
  });

  it("does not change IBSHER sync, Miswag mapping, large product, or barcodes", () => {
    const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
    const admin = read("routes/admin.js");
    const commission = read("utils/commission.js");
    const ibsher = read("services/ibsher.js");
    const gini = read("utils/platformExcel/gini.js");
    const miswag = read("services/miswagTestProduct.js");
    const syncAll = read("services/miswagSyncAll.js");
    const mapping = read("services/miswagCategoryMapping.js");
    const fields = read("utils/platformTaxonomyFields.js");
    const barcodes = read("services/miswagTestBarcodes.js");

    assert.match(admin, /export function syncFromIbsher/);
    assert.match(admin, /Per-product platform prices have been removed/);
    assert.equal(ibsher.includes("rawPrice"), false);
    assert.equal(ibsher.includes("winningCommission"), false);
    assert.match(gini, /preview\.price/);
    assert.equal(gini.includes("rawPrice"), false);
    assert.match(miswag, /is_large: miswagIsLargeFlag/);
    assert.match(miswag, /rawPriceAfterCommission/);
    assert.equal(miswag.includes("commission.scope"), false);
    assert.match(syncAll, /buildMiswagTestPayload/);
    assert.equal(mapping.includes("winningCommission"), false);
    assert.equal(mapping.includes("resolveCommissionRate"), false);
    assert.match(fields, /export function miswagIsLargeFlag/);
    assert.equal(fields.includes("partnerPricePreview"), false);
    assert.equal(barcodes.includes("partnerPricePreview"), false);
    assert.equal(barcodes.includes("winningCommission"), false);
    assert.equal(commission.includes("is_large"), false);
    assert.equal(commission.includes("isLarge"), false);
  });
});
