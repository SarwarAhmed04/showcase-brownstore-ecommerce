import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Category } from "./models/Category.js";
import { BrownTaxonomyKnownNode } from "./models/BrownTaxonomyKnownNode.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "./models/PlatformTaxonomyNotice.js";
import { TaxonomyBaseline } from "./models/TaxonomyBaseline.js";
import { Product } from "./models/Product.js";
import { PARTNER_SLUGS } from "./models/Partner.js";
import { listCategorySetup } from "./utils/platformTaxonomy.js";
import {
  runTaxonomyCheck,
  syncBrownTaxonomyNotices,
} from "./utils/taxonomyNotices.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;

function product(id, categoryId, subcategoryId, collectionId) {
  return {
    ibsherId: id,
    itemCode: id,
    name: { en: id, ku: id, ar: id },
    price: 1000,
    isActive: true,
    category: { _id: categoryId, name: { en: categoryId } },
    subCategory: { _id: subcategoryId, name: { en: subcategoryId } },
    collectionName: { _id: collectionId, name: { en: collectionId } },
    brand: { _id: "brand-1", name: { en: "Philips" } },
    createdBy: { _id: "vendor-1", name: "Vendor A" },
  };
}

async function openNotices(scope, targetId) {
  return PlatformTaxonomyNotice.find({ status: "open", scope, targetId }).lean();
}

describe("taxonomy notices", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("taxonomy-notices"));
  });

  beforeEach(async () => {
    await Promise.all([
      Product.deleteMany({}),
      Category.deleteMany({}),
      BrownTaxonomyKnownNode.deleteMany({}),
      PlatformTaxonomyNotice.deleteMany({}),
      TaxonomyBaseline.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({}),
    ]);
  });

  after(async () => {
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  it("baselines the current catalog without new alerts and does not repeat them", async () => {
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    const first = await syncBrownTaxonomyNotices();
    assert.equal(first.baseline, true);
    assert.equal(first.created, 0);
    assert.equal(await PlatformTaxonomyNotice.countDocuments(), 0);
    assert.equal(await BrownTaxonomyKnownNode.countDocuments() >= 3, true);
    const known = await BrownTaxonomyKnownNode.countDocuments();
    const second = await syncBrownTaxonomyNotices();
    assert.equal(second.created, 0);
    assert.equal(await PlatformTaxonomyNotice.countDocuments(), 0);
    assert.equal(await BrownTaxonomyKnownNode.countDocuments(), known);
  });

  it("does not baseline an empty catalog", async () => {
    const result = await syncBrownTaxonomyNotices();
    assert.equal(result.skipped, "empty");
    assert.equal(await TaxonomyBaseline.countDocuments(), 0);
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    const next = await syncBrownTaxonomyNotices();
    assert.equal(next.baseline, true);
    assert.equal(await PlatformTaxonomyNotice.countDocuments(), 0);
  });

  it("creates one notice per fixed platform for a new category, subcategory, and collection", async () => {
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    await syncBrownTaxonomyNotices();

    await Product.create(product("CAT", "cat-new", "sub-1", "col-1"));
    await syncBrownTaxonomyNotices();
    const categories = await openNotices("category", "cat-new");
    assert.equal(categories.length, PARTNER_SLUGS.length);
    assert.deepEqual(categories.map((row) => row.partner).sort(), [...PARTNER_SLUGS].sort());
    await syncBrownTaxonomyNotices();
    assert.equal((await openNotices("category", "cat-new")).length, PARTNER_SLUGS.length);

    await Product.create(product("SUB", "cat-1", "sub-new", "col-1"));
    await syncBrownTaxonomyNotices();
    assert.equal((await openNotices("subcategory", "sub-new")).length, PARTNER_SLUGS.length);

    await Product.create(product("COL", "cat-1", "sub-1", "col-new"));
    await syncBrownTaxonomyNotices();
    const collections = await openNotices("collection", "col-new");
    assert.equal(collections.length, PARTNER_SLUGS.length);
    assert.equal(collections[0].path.includes("→"), true);
    await syncBrownTaxonomyNotices();
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ scope: "collection", targetId: "col-new" }), PARTNER_SLUGS.length);
  });

  it("resolves a collection notice only after that platform's setup is complete", async () => {
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    await syncBrownTaxonomyNotices();
    await Product.create(product("COL", "cat-new", "sub-new", "col-new"));
    await syncBrownTaxonomyNotices();

    const { saveCategorySetup } = await import("./utils/platformTaxonomy.js");
    await saveCategorySetup("gini", "col-new", {
      categoryName: "الجمال والعناية",
      categoryId: "7",
      subcategoryName: "العناية بالبشرة",
      subcategoryId: "31",
    });

    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", targetId: "col-new", status: "resolved" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "subcategory", targetId: "sub-new", status: "resolved" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "category", targetId: "cat-new", status: "resolved" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "miswag", targetId: "col-new", status: "open" }), 1);
    await syncBrownTaxonomyNotices();
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", targetId: "col-new" }), 1);
  });

  it("keeps a parent notice open until every current collection is configured", async () => {
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    await syncBrownTaxonomyNotices();
    await Product.create([
      product("A", "cat-new", "sub-new", "col-a"),
      product("B", "cat-new", "sub-new", "col-b"),
    ]);
    await syncBrownTaxonomyNotices();
    const { saveCategorySetup } = await import("./utils/platformTaxonomy.js");
    const values = {
      categoryName: "الجمال والعناية",
      categoryId: "7",
      subcategoryName: "العناية بالبشرة",
      subcategoryId: "31",
    };
    await saveCategorySetup("gini", "col-a", values);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "category", targetId: "cat-new", status: "open" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "subcategory", targetId: "sub-new", status: "open" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "collection", targetId: "col-a", status: "resolved" }), 1);
    await saveCategorySetup("gini", "col-b", values);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "category", targetId: "cat-new", status: "resolved" }), 1);
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ partner: "gini", scope: "subcategory", targetId: "sub-new", status: "resolved" }), 1);
  });

  it("keeps a category notice open when it has no collections", async () => {
    await Product.create(product("P1", "cat-1", "sub-1", "col-1"));
    await syncBrownTaxonomyNotices();
    await Category.create({ ibsherId: "cat-empty", name: { en: "Empty", ku: "Empty", ar: "Empty" } });
    await syncBrownTaxonomyNotices();
    assert.equal((await openNotices("category", "cat-empty")).length, PARTNER_SLUGS.length);
    await syncBrownTaxonomyNotices();
    assert.equal(await PlatformTaxonomyNotice.countDocuments({ scope: "category", targetId: "cat-empty", status: "open" }), PARTNER_SLUGS.length);
  });

  it("lists current collections without setup as missing and ignores a thrown check", async () => {
    await Product.create([
      product("P1", "cat-1", "sub-1", "col-1"),
      product("P2", "cat-1", "sub-1", "col-2"),
    ]);
    await syncBrownTaxonomyNotices();
    const missing = await listCategorySetup({ partner: "gini", q: "", status: "missing", page: 1, limit: 20 });
    assert.equal(missing.counts.total, 2);
    assert.equal(missing.counts.configured, 0);
    assert.equal(missing.counts.missing, 2);
    assert.deepEqual(missing.rows.map((row) => row.id).sort(), ["col-1", "col-2"]);
    assert.equal(missing.noticeCount, 0);

    let summary = { ok: true };
    summary = await (async () => {
      await runTaxonomyCheck(async () => {
        throw new Error("notice failed");
      });
      return summary;
    })();
    assert.equal(summary.ok, true);

    const admin = fs.readFileSync(path.join(__dirname, "routes/admin.js"), "utf8");
    const notices = fs.readFileSync(path.join(__dirname, "utils/taxonomyNotices.js"), "utf8");
    assert.match(admin, /runTaxonomyCheck\(/);
    assert.equal(notices.includes("fetch("), false);
    assert.equal(/https?:\/\//.test(notices), false);

    const clientFiles = [
      "api.js",
      "i18n.js",
      "pages/admin/Commissions.jsx",
      "components/admin/platform/CategorySetupPanel.jsx",
      "components/admin/platform/PlatformOverview.jsx",
      "components/admin/platform/PlatformSidebar.jsx",
    ];
    const client = clientFiles
      .map((file) => fs.readFileSync(path.join(__dirname, "../../client/src", file), "utf8"))
      .join("\n");
    assert.equal(client.includes("category-mappings"), false);
    assert.equal(client.includes("platform-categories"), false);
    assert.equal(client.includes("importPlatformCategories"), false);
    assert.equal(client.includes("Choose .xlsx"), false);
    assert.equal(client.includes("searchPlatformCategory"), false);
    assert.equal(client.includes("Import categories"), false);
    assert.equal(client.includes("Import Categories"), false);
  });
});
