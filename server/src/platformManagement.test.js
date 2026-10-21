import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter, syncFromIbsher } from "./routes/admin.js";
import { Commission } from "./models/Commission.js";
import { Partner, PARTNER_DEFS } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformProduct } from "./models/PlatformProduct.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { seedPartners } from "./seedPartners.js";
import { buildCommissionWorkbook } from "./utils/commissionExcel.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import {
  eligibilityBucket,
  evaluatePlatformEligibility,
} from "./utils/platformEligibility.js";
import { platformDashboard } from "./utils/platformTaxonomy.js";
import { streamIbsherCatalog } from "./services/ibsher.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "platform-test-secret";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;
let server;
let token;

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

function catalogProduct(id, overrides = {}) {
  return {
    ibsherId: id,
    itemCode: id,
    name: { en: id, ku: id, ar: id },
    price: 1000,
    discountPrice: 0,
    isActive: true,
    category: { _id: "cat-1", name: { en: "Home Appliances" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen Appliances" } },
    collectionName: { _id: "col-1", name: { en: "Food Processors" } },
    brand: { _id: "brand-1", name: { en: "Philips" } },
    createdBy: { _id: "vendor-1", name: "Vendor A" },
    ...overrides,
  };
}

describe("platform management", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "platform-test@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "old-shop", name: "Old Shop", isActive: true });
    await seedPartners();
    await Product.insertMany([
      catalogProduct("HR7778"),
      catalogProduct("UNMAPPED", { collectionName: { _id: "col-unmapped", name: { en: "Other" } } }),
      catalogProduct("CAT-OFF", { category: { _id: "cat-off", name: { en: "Fashion" } } }),
      catalogProduct("SUB-OFF", { subCategory: { _id: "sub-off", name: { en: "Off Sub" } } }),
      catalogProduct("COL-OFF", { collectionName: { _id: "col-off", name: { en: "Off Collection" } } }),
      catalogProduct("BRAND-OFF", { brand: { _id: "brand-off", name: { en: "Apple" } } }),
      catalogProduct("VENDOR-OFF", { createdBy: { _id: "vendor-off", name: "Vendor B" } }),
      catalogProduct("ABC123"),
    ]);
    await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "col-1",
      values: {
        categoryName: "Food",
        categoryId: "7",
        subcategoryName: "Kitchen",
        subcategoryId: "31",
      },
    });
    await PlatformVisibilityRule.create([
      { partner: "miswag", scope: "category", targetId: "cat-off", isActive: false },
      { partner: "miswag", scope: "subcategory", targetId: "sub-off", isActive: false },
      { partner: "miswag", scope: "collection", targetId: "col-off", isActive: false },
      { partner: "miswag", scope: "brand", targetId: "brand-off", isActive: false },
      { partner: "miswag", scope: "vendor", targetId: "vendor-off", isActive: false },
    ]);
    const hidden = await Product.findOne({ itemCode: "ABC123" });
    await PlatformVisibilityRule.create({
      partner: "miswag",
      scope: "product",
      targetId: String(hidden._id),
      isActive: false,
    });
    await Commission.create({
      partner: "miswag",
      scope: "brand",
      targetId: "brand-1",
      targetName: { en: "Philips", ku: "Philips", ar: "Philips" },
      percentage: 10,
      isActive: true,
    });
    await PlatformProduct.create({
      partner: "miswag",
      product: hidden._id,
      overrides: { sku: "ABC123-custom" },
    });
    server = await listen(app());
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  it("keeps fixed platforms and unknown records", async () => {
    const slugs = (await Partner.find().select("slug").lean()).map((item) => item.slug);
    for (const def of PARTNER_DEFS) assert.ok(slugs.includes(def.slug));
    assert.ok(slugs.includes("old-shop"));
    const listed = await call("GET", "/api/admin/platforms");
    assert.equal(listed.status, 200);
    assert.deepEqual(
      listed.json.platforms.map((item) => item.slug),
      ["miswag", "gini", "elryan", "ibazzar"]
    );
    assert.equal(listed.json.unknownPlatforms[0].slug, "old-shop");
    assert.equal(listed.json.unknownPlatforms[0].fixed, false);
  });

  it("refuses admin create and delete without removing data", async () => {
    const before = await Partner.countDocuments();
    const created = await call("POST", "/api/admin/platforms", { body: { name: "New Platform" } });
    assert.equal(created.status, 403);
    const removed = await call("DELETE", "/api/admin/platforms/miswag");
    assert.equal(removed.status, 403);
    assert.equal(await Partner.countDocuments(), before);
    assert.ok(await Partner.findOne({ slug: "miswag" }));
    assert.ok(await Partner.findOne({ slug: "old-shop" }));
  });

  it("evaluates every blocking reason and keeps platforms independent", async () => {
    const products = await Product.find().lean();
    const byCode = Object.fromEntries(products.map((item) => [item.itemCode, item]));
    const { loadEligibilityContext } = await import("./utils/platformTaxonomy.js");
    const miswag = await loadEligibilityContext("miswag");
    const gini = await loadEligibilityContext("gini");

    assert.equal(evaluatePlatformEligibility(byCode.HR7778, miswag).eligible, true);
    assert.equal(evaluatePlatformEligibility(byCode.UNMAPPED, miswag).eligible, true);
    assert.equal(eligibilityBucket(evaluatePlatformEligibility(byCode.UNMAPPED, gini)), "missing_setup");
    assert.ok(
      evaluatePlatformEligibility(byCode["CAT-OFF"], miswag).reasons.some((reason) => reason.code === "category_inactive")
    );
    assert.ok(
      evaluatePlatformEligibility(byCode["SUB-OFF"], miswag).reasons.some((reason) => reason.code === "subcategory_inactive")
    );
    assert.ok(
      evaluatePlatformEligibility(byCode["COL-OFF"], miswag).reasons.some((reason) => reason.code === "collection_inactive")
    );
    assert.ok(
      evaluatePlatformEligibility(byCode["BRAND-OFF"], miswag).reasons.some((reason) => reason.code === "brand_inactive")
    );
    assert.ok(
      evaluatePlatformEligibility(byCode["VENDOR-OFF"], miswag).reasons.some((reason) => reason.code === "vendor_inactive")
    );
    assert.ok(
      evaluatePlatformEligibility(byCode.ABC123, miswag).reasons.some((reason) => reason.code === "product_inactive")
    );
    assert.equal(evaluatePlatformEligibility(byCode.ABC123, gini).eligible, true);
    assert.equal(evaluatePlatformEligibility(byCode["CAT-OFF"], gini).eligible, true);
    assert.equal(evaluatePlatformEligibility(byCode.HR7778, gini).eligible, true);
  });

  it("uses one eligibility result for dashboard counts and Excel rows", async () => {
    const summary = await platformDashboard(await Partner.findOne({ slug: "miswag" }));
    assert.equal(summary.totalProducts, 8);
    assert.equal(summary.exportReady, 2);
    assert.equal(summary.inactiveExcluded, 6);
    assert.equal(summary.missingSetup, 0);
    assert.equal(summary.priceRules, 1);
    assert.equal(summary.totalCollections, 3);
    assert.equal(summary.configuredCollections, 0);
    assert.equal(summary.missingSetupCollections, 3);
    assert.equal(summary.newTaxonomyAlerts, 0);

    const partner = await Partner.findOne({ slug: "miswag" });
    const rules = await Commission.find({ partner: "miswag" });
    const { workbook, total } = await buildCommissionWorkbook(partner, rules);
    assert.equal(total, 2);
    const sheet = workbook.getWorksheet("Excel");
    const headers = sheet.getRow(1).values.slice(1);
    const values = sheet.getRow(2).values.slice(1);
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    assert.equal(row.SKU, "HR7778");
    assert.equal(row.Price, 1250);
    assert.equal(row["Platform price"], 1250);
    assert.equal(row["Commission %"], 10);
    const priced = partnerPricePreview(await Product.findOne({ itemCode: "HR7778" }), rules);
    assert.equal(priced.storePrice, 1000);
    assert.equal(priced.price, 1250);
    assert.equal((await Product.findOne({ itemCode: "HR7778" }).lean()).price, 1000);
    assert.equal(sheet.rowCount, 3);

    const gini = await Partner.findOne({ slug: "gini" });
    const giniBook = await buildCommissionWorkbook(gini, []);
    assert.equal(giniBook.total, 6);
    const meta = await call("GET", "/api/admin/platforms/miswag/excel?meta=1");
    assert.equal(meta.status, 200);
    assert.equal(meta.json.total, 2);
    assert.equal(partnerPricePreview(await Product.findOne({ itemCode: "HR7778" }), rules).customPrice, false);
  });

  it("saves one manual gini category record and keeps platforms separate", async () => {
    const missing = await call("GET", "/api/admin/platforms/gini/category-setup?status=missing");
    assert.equal(missing.status, 200);
    assert.equal(missing.json.fields.length, 4);
    assert.equal(missing.json.rows.some((row) => row.id === "col-unmapped"), true);
    assert.equal(missing.json.rows.some((row) => row.id === "col-1"), false);
    const removed = await call("GET", "/api/admin/platforms/gini/category-mappings");
    assert.equal(removed.status, 404);
    const imported = await call("POST", "/api/admin/platforms/gini/platform-categories/import", {
      body: { file: "unused" },
    });
    assert.equal(imported.status, 404);

    const saved = await call("PUT", "/api/admin/platforms/gini/category-setup/col-unmapped", {
      body: {
        values: {
          categoryName: "الجمال والعناية",
          categoryId: "7",
          subcategoryName: "العناية بالبشرة",
          subcategoryId: "31",
        },
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.setup.configured, true);
    const updated = await call("PUT", "/api/admin/platforms/gini/category-setup/col-unmapped", {
      body: {
        values: {
          categoryName: "الجمال والعناية",
          categoryId: "7",
          subcategoryName: "العناية بالبشرة",
          subcategoryId: "32",
        },
      },
    });
    assert.equal(updated.status, 200);
    assert.equal(await PlatformTaxonomyConfig.countDocuments({ partner: "gini", brownCollectionId: "col-unmapped" }), 1);
    const reloaded = await call("GET", "/api/admin/platforms/gini/category-setup?q=Other");
    assert.equal(reloaded.json.rows[0].values.subcategoryId, "32");
    const denied = await call("PUT", "/api/admin/platforms/miswag/category-setup/col-1", {
      body: { values: { categoryId: "1" } },
    });
    assert.equal(denied.status, 400);
    await PlatformTaxonomyConfig.create({
      partner: "elryan",
      brownCollectionId: "col-unmapped",
      values: { categoryId: "999" },
    });
    const gini = await PlatformTaxonomyConfig.findOne({ partner: "gini", brownCollectionId: "col-unmapped" }).lean();
    const elryan = await PlatformTaxonomyConfig.findOne({ partner: "elryan", brownCollectionId: "col-unmapped" }).lean();
    assert.equal(gini.values.categoryId, "7");
    assert.equal(elryan.values.categoryId, "999");
  });

  it("stores inactive overrides and requires confirmation for large bulk changes", async () => {
    const products = await Product.find().select("_id").lean();
    const extra = [];
    for (let index = 0; index < 25; index += 1) {
      extra.push(catalogProduct(`BULK-${index}`, { collectionName: { _id: "col-bulk", name: { en: "Bulk" } } }));
    }
    await Product.insertMany(extra);
    const ids = (await Product.find({ itemCode: /^BULK-/ }).select("_id").lean()).map((item) => String(item._id));
    const denied = await call("POST", "/api/admin/platforms/ibazzar/availability", {
      body: { scope: "product", targetIds: ids, isActive: false },
    });
    assert.equal(denied.status, 400);
    assert.equal(await PlatformVisibilityRule.countDocuments({ partner: "ibazzar" }), 0);
    const accepted = await call("POST", "/api/admin/platforms/ibazzar/availability", {
      body: { scope: "product", targetIds: ids, isActive: false, confirm: true },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.json.updated, 25);
    assert.equal(await Product.countDocuments({ itemCode: /^BULK-/ }), 25);
    const restore = await call("POST", "/api/admin/platforms/ibazzar/availability", {
      body: { scope: "product", targetIds: ids, isActive: true, confirm: true },
    });
    assert.equal(restore.status, 200);
    assert.equal(await PlatformVisibilityRule.countDocuments({ partner: "ibazzar", scope: "product" }), 0);
    assert.equal(products.length > 0, true);
  });

  it("does not restore customized price and does not call catalog sync", async () => {
    const product = await Product.findOne({ itemCode: "HR7778" });
    const priced = await call("PATCH", `/api/admin/platforms/miswag/products/${product._id}`, {
      body: { price: 50 },
    });
    assert.equal(priced.status, 410);
    const stored = await Product.findById(product._id).lean();
    assert.equal(stored.price, 1000);
    assert.equal(typeof syncFromIbsher, "function");
    assert.equal(typeof streamIbsherCatalog, "function");
    const files = [
      "models/PlatformTaxonomyConfig.js",
      "models/BrownTaxonomyKnownNode.js",
      "models/PlatformTaxonomyNotice.js",
      "models/TaxonomyBaseline.js",
      "models/PlatformVisibilityRule.js",
      "utils/platformEligibility.js",
      "utils/platformTaxonomy.js",
      "utils/platformTaxonomyFields.js",
      "utils/taxonomyNotices.js",
      "routes/platformManagement.js",
    ];
    const walk = (dir, prefix) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const relative = `${prefix}/${name}`;
        if (fs.statSync(full).isDirectory()) walk(full, relative);
        else if (name.endsWith(".js")) files.push(relative);
      }
    };
    walk(path.join(__dirname, "utils/platformExcel"), "utils/platformExcel");
    for (const file of files) {
      const text = fs.readFileSync(path.join(__dirname, file), "utf8");
      assert.equal(/https?:\/\//.test(text), false, file);
    }
    assert.equal(await Commission.countDocuments({ partner: "miswag" }), 1);
    assert.equal(await PlatformProduct.countDocuments({ partner: "miswag" }), 1);
  });
});
