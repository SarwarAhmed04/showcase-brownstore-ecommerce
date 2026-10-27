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
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanCategoryCatalogSnapshot } from "./models/ElryanCategoryCatalogSnapshot.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { ELRYAN_MAPPING_PREVIEW } from "./utils/elryanConstants.js";
import { sampleProductsForCollections } from "./services/elryanMappingPreview.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-mapping-perf-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;

const API_KEY = "elryan-mapping-perf-key-not-for-browser-22";

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

describe("Elryan mapping preview performance bounds", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-mapping-perf"));
    const user = await User.create({
      email: "elryan-perf@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Perf",
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
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
  });

  it("batches product samples for many collections in one query", async () => {
    const products = [];
    for (let i = 0; i < 30; i += 1) {
      products.push({
        ibsherId: `ibs-perf-${i}`,
        itemCode: `PERF-${i}`,
        name: { en: `Product ${i}` },
        description: { en: "Desc" },
        price: 1000,
        brand: { _id: "b1", name: { en: "B" } },
        category: { _id: "c1", name: { en: "Cat" } },
        subCategory: { _id: "s1", name: { en: "Sub" } },
        collectionName: { _id: `col-${i % 10}`, name: { en: `Collection ${i % 10}` } },
        variants: [
          {
            color: { en: "Black" },
            images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
            sizes: [{ size: "One", stockQuantity: 1 }],
          },
        ],
        isActive: true,
      });
    }
    await Product.insertMany(products);

    const map = await sampleProductsForCollections(
      Array.from({ length: 10 }, (_, i) => `col-${i}`),
      3
    );
    assert.equal(map.size, 10);
    assert.ok([...map.values()].every((list) => list.length > 0 && list.length <= 3));
  });

  it("scores only the requested page (not all collections) and stays fast", async () => {
    const catalog = Array.from({ length: 200 }, (_, i) => ({
      id: i + 1,
      name: i === 0 ? "Alpha Widgets" : `Cat ${i}`,
      hierarchy: i === 0 ? "Root : Alpha Widgets" : `Root : Cat ${i}`,
      isParent: false,
      level: 2,
    }));
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: catalog.length,
      reportedTotal: catalog.length,
      categories: catalog,
    });

    // 80 collections — old code would sample products 80 times before paginating.
    const docs = [];
    for (let i = 0; i < 80; i += 1) {
      docs.push({
        ibsherId: `ibs-many-${i}`,
        itemCode: `MANY-${i}`,
        name: { en: `Item ${i}` },
        description: { en: "x" },
        price: 1000,
        brand: { _id: "b1", name: { en: "B" } },
        category: { _id: "c1", name: { en: "Root" } },
        subCategory: { _id: "s1", name: { en: "Branch" } },
        collectionName: {
          _id: `many-col-${i}`,
          name: { en: i === 0 ? "Alpha Widgets" : `Collection ${i}` },
        },
        variants: [
          {
            color: { en: "Black" },
            images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
            sizes: [{ size: "One", stockQuantity: 1 }],
          },
        ],
        isActive: true,
      });
    }
    await Product.insertMany(docs);

    const t0 = Date.now();
    const res = await call("/api/admin/platforms/elryan/mapping-preview?limit=10&offset=0");
    const elapsed = Date.now() - t0;

    assert.equal(res.status, 200);
    assert.ok(res.json.rows.length <= 10);
    assert.ok(res.json.counts.scored <= ELRYAN_MAPPING_PREVIEW.MAX_COLLECTIONS_SCORED);
    assert.ok(res.json.counts.scored <= 10 || res.json.counts.scored <= 30);
    assert.equal(res.json.mappingPersistence, "explicit_save_only");
    assert.ok(elapsed < 5000, `preview too slow: ${elapsed}ms`);
    assert.ok(res.json.timingMs < 5000);
  });

  it("does not persist taxonomy mappings from preview", async () => {
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 1,
      categories: [{ id: 1, name: "Solo", hierarchy: "Solo", isParent: false }],
    });
    await Product.create({
      ibsherId: "ibs-nopersist",
      itemCode: "NP-1",
      name: { en: "Solo" },
      description: { en: "x" },
      price: 1000,
      brand: { _id: "b1", name: { en: "B" } },
      category: { _id: "c1", name: { en: "C" } },
      subCategory: { _id: "s1", name: { en: "S" } },
      collectionName: { _id: "col-solo", name: { en: "Solo" } },
      variants: [
        {
          color: { en: "Black" },
          images: [{ url: "https://cdn.example.com/a.jpg", isMain: true }],
          sizes: [{ size: "One", stockQuantity: 1 }],
        },
      ],
      isActive: true,
    });

    const before = await mongoose.connection.collection("platformtaxonomyconfigs").countDocuments({
      partner: "elryan",
    });
    await call("/api/admin/platforms/elryan/mapping-preview?limit=5");
    const after = await mongoose.connection.collection("platformtaxonomyconfigs").countDocuments({
      partner: "elryan",
    });
    assert.equal(after, before);
  });
});
