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
import { encryptApiKey } from "./utils/partnerAuth.js";
import {
  collectElryanMappingPage,
  elryanMappingScanBudget,
  finalizeElryanMappingPage,
} from "./services/elryanMappingPreview.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-mapping-quick-page-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;

const API_KEY = "elryan-mapping-quick-page-key-not-for-browser";

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

async function call(urlPath) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

function productDoc({ id, name, category = "General", sub = "Branch" }) {
  return {
    ibsherId: `ibs-${id}`,
    itemCode: `SKU-${id}`,
    name: { en: name },
    description: { en: "x" },
    price: 1000,
    brand: { _id: "b1", name: { en: "B" } },
    category: { _id: `cat-${category}`, name: { en: category } },
    subCategory: { _id: `sub-${sub}`, name: { en: sub } },
    collectionName: { _id: id, name: { en: name } },
    variants: [
      {
        color: { en: "Black" },
        images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
        sizes: [{ size: "One", stockQuantity: 1 }],
      },
    ],
    isActive: true,
  };
}

function leafCategory(id, name) {
  return {
    id,
    name,
    hierarchy: `Depotroot : Shelfnode : ${name}`,
    isParent: false,
    level: 3,
    attributeSetId: 4,
  };
}

async function walkPreview(params) {
  let offset = 0;
  const pages = [];
  const ids = [];
  for (let guard = 0; guard < 40; guard += 1) {
    const qs = new URLSearchParams({ ...params, offset: String(offset) });
    const res = await call(`/api/admin/platforms/elryan/mapping-preview?${qs.toString()}`);
    assert.equal(res.status, 200, res.json?.message || res.json?.error || "preview failed");
    const pageIds = (res.json.rows || []).map((row) => row.brownCollectionId);
    for (const id of pageIds) {
      assert.equal(ids.includes(id), false, `duplicate collection ${id}`);
      ids.push(id);
    }
    assert.equal(res.json.nextOffset, offset + res.json.scanned);
    assert.ok(res.json.scanned <= res.json.scanBudget);
    pages.push(res.json);
    if (!res.json.hasMore) {
      assert.equal(res.json.nextOffset, res.json.counts.filtered);
      break;
    }
    assert.ok(res.json.nextOffset > offset);
    offset = res.json.nextOffset;
  }
  return { pages, ids };
}

describe("Elryan mapping page cursor", () => {
  it("stops an early full page at the last scored row instead of the scan budget", () => {
    const planned = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    let visits = 0;
    const collected = collectElryanMappingPage(planned, {
      take: 3,
      visit(id) {
        visits += 1;
        return { id };
      },
    });
    assert.equal(visits, 3);
    assert.equal(collected.consumed, 3);
    assert.equal(collected.rows.length, 3);
    const page = finalizeElryanMappingPage({
      filteredLength: 20,
      offset: 0,
      plannedCount: planned.length,
      consumed: collected.consumed,
      pageMatchCount: collected.rows.length,
      confidenceFiltered: true,
    });
    assert.equal(page.nextOffset, 3);
    assert.notEqual(page.nextOffset, planned.length);
    assert.equal(page.hasMore, true);
    assert.equal(page.totalMatching, null);
    assert.equal(page.totalMatchingExact, false);
    assert.equal(page.confidenceMatchCountExact, false);
    assert.equal(page.progress.exact, false);
    assert.equal(page.progress.pageMatches, 3);
  });

  it("walks sparse confidence matches without skipping or repeating rows", () => {
    const ids = Array.from({ length: 20 }, (_, index) => index);
    const matchAt = new Set([4, 17]);
    const take = 2;
    const budget = elryanMappingScanBudget(take, true);
    assert.equal(budget, 6);
    let offset = 0;
    const seen = [];
    let guard = 0;
    while (guard < 20) {
      const planned = ids.slice(offset, offset + budget);
      const collected = collectElryanMappingPage(planned, {
        take,
        visit(id) {
          return matchAt.has(id) ? { id } : null;
        },
      });
      const page = finalizeElryanMappingPage({
        filteredLength: ids.length,
        offset,
        plannedCount: planned.length,
        consumed: collected.consumed,
        pageMatchCount: collected.rows.length,
        confidenceFiltered: true,
      });
      assert.equal(page.nextOffset, offset + collected.consumed);
      assert.ok(page.nextOffset <= offset + planned.length);
      assert.equal(page.totalMatching, null);
      for (const row of collected.rows) {
        assert.equal(seen.includes(row.id), false);
        seen.push(row.id);
      }
      if (!page.hasMore) {
        assert.equal(page.nextOffset, ids.length);
        break;
      }
      assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
      guard += 1;
    }
    assert.deepEqual(seen, [4, 17]);
  });

  it("fills an early page and still returns the later match exactly once", () => {
    const ids = Array.from({ length: 12 }, (_, index) => index);
    const matchAt = new Set([0, 1, 2, 3, 4, 10]);
    const take = 3;
    const budget = elryanMappingScanBudget(take, true);
    let offset = 0;
    const seen = [];
    let firstConsumed = null;
    while (offset < ids.length) {
      const planned = ids.slice(offset, offset + budget);
      const collected = collectElryanMappingPage(planned, {
        take,
        visit(id) {
          return matchAt.has(id) ? { id } : null;
        },
      });
      if (firstConsumed == null) firstConsumed = collected.consumed;
      const page = finalizeElryanMappingPage({
        filteredLength: ids.length,
        offset,
        plannedCount: planned.length,
        consumed: collected.consumed,
        pageMatchCount: collected.rows.length,
        confidenceFiltered: true,
      });
      seen.push(...collected.rows.map((row) => row.id));
      if (!page.hasMore) break;
      offset = page.nextOffset;
    }
    assert.equal(firstConsumed, 3);
    assert.deepEqual(seen, [0, 1, 2, 3, 4, 10]);
  });
});

describe("Elryan mapping preview pagination", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-mapping-quick-page"));
    const user = await User.create({
      email: "elryan-page@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Page",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan" });
    server = await listen(app());
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    await ElryanConnection.deleteMany({});
    await ElryanCategoryCatalogSnapshot.deleteMany({});
    await Product.deleteMany({});
    await PlatformTaxonomyConfig.deleteMany({});
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
  });

  it("pages every collection past the first 40 without duplicates and without writing mappings", async () => {
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 1,
      categories: [leafCategory(1, "Solo Catalog")],
    });
    const docs = [];
    for (let i = 0; i < 50; i += 1) {
      const pad = String(i).padStart(2, "0");
      docs.push(
        productDoc({
          id: `col-${pad}`,
          name: `Item ${pad}`,
          category: "General",
          sub: i === 49 ? "Zinc Path Marker" : "Branch",
        })
      );
    }
    await Product.insertMany(docs);
    const before = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });

    const walked = await walkPreview({ limit: "40" });
    assert.equal(walked.ids.length, 50);
    assert.equal(walked.pages.length, 2);
    assert.equal(walked.pages[0].rows.length, 40);
    assert.equal(walked.pages[0].offset, 0);
    assert.equal(walked.pages[0].nextOffset, 40);
    assert.equal(walked.pages[0].hasMore, true);
    assert.equal(walked.pages[0].totalMatching, 50);
    assert.equal(walked.pages[0].totalMatchingExact, true);
    assert.equal(walked.pages[0].progress.from, 1);
    assert.equal(walked.pages[0].progress.to, 40);
    assert.equal(walked.pages[1].offset, 40);
    assert.equal(walked.pages[1].rows.length, 10);
    assert.equal(walked.pages[1].hasMore, false);
    assert.equal(walked.pages[1].progress.from, 41);
    assert.equal(walked.pages[1].progress.to, 50);
    assert.ok(walked.ids.includes("col-49"));
    assert.equal(walked.pages[0].mappingPersistence, "explicit_save_only");
    assert.equal(walked.pages[0].sentToElryan, false);
    for (const row of walked.pages.flatMap((page) => page.rows)) {
      assert.equal(row.autoSave, false);
      assert.equal(row.previewOnly, true);
    }

    const byId = await call("/api/admin/platforms/elryan/mapping-preview?q=col-49&limit=40&offset=0");
    assert.equal(byId.status, 200);
    assert.equal(byId.json.counts.filtered, 1);
    assert.equal(byId.json.rows[0].brownCollectionId, "col-49");

    const byName = await call(
      "/api/admin/platforms/elryan/mapping-preview?q=Item%2049&limit=40&offset=0"
    );
    assert.equal(byName.json.rows[0].brownCollectionId, "col-49");

    const byPath = await call(
      "/api/admin/platforms/elryan/mapping-preview?q=Zinc%20Path%20Marker&limit=40&offset=0"
    );
    assert.equal(byPath.json.rows.length, 1);
    assert.equal(byPath.json.rows[0].brownCollectionId, "col-49");
    assert.match(byPath.json.rows[0].taxonomyPath, /Zinc Path Marker/);

    const after = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    assert.equal(after, before);
  });

  it("keeps mapped and unmapped filters consistent across pages", async () => {
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 1,
      categories: [leafCategory(1, "Solo Catalog")],
    });
    const docs = [];
    for (let i = 0; i < 50; i += 1) {
      const pad = String(i).padStart(2, "0");
      docs.push(productDoc({ id: `col-${pad}`, name: `Item ${pad}` }));
    }
    await Product.insertMany(docs);
    await PlatformTaxonomyConfig.create([
      {
        partner: "elryan",
        brownCollectionId: "col-00",
        values: { categoryId: "1", categoryName: "Solo Catalog", elryanEnvironment: "staging" },
      },
      {
        partner: "elryan",
        brownCollectionId: "col-49",
        values: { categoryId: "1", categoryName: "Solo Catalog", elryanEnvironment: "staging" },
      },
    ]);

    const unmapped = await walkPreview({ limit: "40", status: "unmapped" });
    assert.equal(unmapped.ids.length, 48);
    assert.equal(unmapped.ids.includes("col-00"), false);
    assert.equal(unmapped.ids.includes("col-49"), false);
    assert.equal(unmapped.pages[0].totalMatching, 48);
    assert.equal(unmapped.pages[0].totalMatchingExact, true);

    const mapped = await call("/api/admin/platforms/elryan/mapping-preview?status=mapped&limit=40&offset=0");
    assert.equal(mapped.status, 200);
    assert.equal(mapped.json.counts.filtered, 2);
    assert.equal(mapped.json.hasMore, false);
    const mappedIds = mapped.json.rows.map((row) => row.brownCollectionId).sort();
    assert.deepEqual(mappedIds, ["col-00", "col-49"]);
    assert.ok(mapped.json.rows.every((row) => row.existingMapping.configured === true));
  });

  it("continues a sparse confidence filter from the real consumed offset", async () => {
    const highs = ["Alphaone", "Alphatwo", "Alphathree", "Alphafour", "Alphafive", "Zuluunique"];
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: highs.length,
      categories: highs.map((name, index) => leafCategory(index + 1, name)),
    });
    const docs = highs.slice(0, 5).map((name, index) =>
      productDoc({
        id: `col-high-${index}`,
        name,
        category: "Depotroot",
        sub: "Shelfnode",
      })
    );
    for (let i = 5; i <= 40; i += 1) {
      const pad = String(i).padStart(2, "0");
      docs.push(
        productDoc({
          id: `col-noise-${pad}`,
          name: `Qnnoise ${pad}`,
          category: "Miscbox",
          sub: "Otherbin",
        })
      );
    }
    docs.push(
      productDoc({
        id: "col-zulu",
        name: "Zuluunique",
        category: "Depotroot",
        sub: "Shelfnode",
      })
    );
    await Product.insertMany(docs);
    const before = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });

    const first = await call(
      "/api/admin/platforms/elryan/mapping-preview?confidence=HIGH&limit=3&offset=0"
    );
    assert.equal(first.status, 200);
    assert.equal(first.json.rows.length, 3);
    assert.equal(first.json.scanned, 3);
    assert.equal(first.json.scanBudget, elryanMappingScanBudget(3, true));
    assert.equal(first.json.nextOffset, 3);
    assert.notEqual(first.json.nextOffset, first.json.scanBudget);
    assert.equal(first.json.totalMatching, null);
    assert.equal(first.json.totalMatchingExact, false);
    assert.equal(first.json.confidenceMatchCountExact, false);
    assert.equal(first.json.progress.exact, false);
    assert.notEqual(first.json.pageMatchCount, first.json.counts.filtered);

    const walked = await walkPreview({ confidence: "HIGH", limit: "3" });
    assert.deepEqual(
      walked.ids.sort(),
      ["col-high-0", "col-high-1", "col-high-2", "col-high-3", "col-high-4", "col-zulu"].sort()
    );
    assert.equal(walked.ids.filter((id) => id.startsWith("col-noise")).length, 0);
    assert.equal(walked.pages[0].nextOffset, 3);
    const cursors = walked.pages.map((page) => page.offset);
    assert.deepEqual(cursors, [...new Set(cursors)]);
    for (let i = 1; i < walked.pages.length; i += 1) {
      assert.equal(walked.pages[i].offset, walked.pages[i - 1].nextOffset);
    }

    const after = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    assert.equal(after, before);
  });

  it("does not serve a staging catalog as a production mapping preview", async () => {
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 1,
      categories: [leafCategory(1, "Alphaone")],
    });
    await Product.create(productDoc({ id: "col-prod", name: "Alphaone", category: "Depotroot", sub: "Shelfnode" }));
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
    const before = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    const res = await call("/api/admin/platforms/elryan/mapping-preview?limit=40&offset=0");
    assert.equal(res.status, 409);
    assert.equal(res.json.code, "catalog_env_unavailable");
    const after = await PlatformTaxonomyConfig.countDocuments({ partner: "elryan" });
    assert.equal(after, before);
  });
});
