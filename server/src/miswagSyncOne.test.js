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
import { Commission } from "./models/Commission.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { MiswagProductSyncState } from "./models/MiswagProductSyncState.js";
import { Partner } from "./models/Partner.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { partnerPricePreview } from "./utils/partnerCatalog.js";
import { setMiswagFetch, testMiswagConnection } from "./services/miswag.js";
import {
  MISWAG_ITEM_CREATE_PATH,
  buildMiswagTestPayload,
  previewMiswagTestProduct,
  sendMiswagTestProduct,
} from "./services/miswagTestProduct.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-sync-one-test-secret";
process.env.MEDIA_PUBLIC_ORIGIN = "https://api.brownstore.test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let memory;
let server;
let token;
let productId;
let inactiveProductId;

const originalEnv = {
  baseUrl: process.env.MISWAG_BASE_URL,
  apiKey: process.env.MISWAG_API_KEY,
  apiSecret: process.env.MISWAG_API_SECRET,
};

function clearMiswagEnv() {
  delete process.env.MISWAG_BASE_URL;
  delete process.env.MISWAG_API_KEY;
  delete process.env.MISWAG_API_SECRET;
}

function restoreMiswagEnv() {
  if (originalEnv.baseUrl == null) delete process.env.MISWAG_BASE_URL;
  else process.env.MISWAG_BASE_URL = originalEnv.baseUrl;
  if (originalEnv.apiKey == null) delete process.env.MISWAG_API_KEY;
  else process.env.MISWAG_API_KEY = originalEnv.apiKey;
  if (originalEnv.apiSecret == null) delete process.env.MISWAG_API_SECRET;
  else process.env.MISWAG_API_SECRET = originalEnv.apiSecret;
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
  return { status: response.status, json, raw: JSON.stringify(json) };
}

function mockResponse(status, body = {}, headers = {}) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
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

function sampleProduct(overrides = {}) {
  return {
    ibsherId: "ibs-sync-one-1",
    itemCode: "SKU-SYNC-1",
    name: { en: "Sample Blender", ar: "خلاط تجريبي", ku: "تێکەڵکەری نموونە" },
    description: {
      en: "A sample blender",
      ar: "وصف عربي كافٍ للمنتج التجريبي",
      ku: "وەسف",
    },
    price: 1000,
    discountPrice: 0,
    isActive: true,
    keyword: ["blender", "kitchen"],
    brand: { _id: "brand-1", name: { en: "Philips" } },
    category: { _id: "cat-1", name: { en: "Home" } },
    subCategory: { _id: "sub-1", name: { en: "Kitchen" } },
    collectionName: { _id: "col-1", name: { en: "Blenders" } },
    variants: [
      {
        _id: "var-1",
        barcode: "6291041500213",
        color: { name: { en: "Black" }, hex: "#000000" },
        images: [{ url: "/media/sample.jpg", isMain: true }],
        sizes: [{ _id: "size-1", size: "One Size", stockQuantity: 4 }],
      },
    ],
    ...overrides,
  };
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_test_key";
  process.env.MISWAG_API_SECRET = "sk_prd_test_secret";
  setMiswagFetch(async (url, options) => {
    const method = String(options?.method || "GET").toUpperCase();
    if (method === "HEAD") return mockResponse(200, "");
    if (String(url).includes("/v1/categories/flat")) {
      return mockResponse(200, { data: { content: [], paging: {} } });
    }
    return mockResponse(404, { message: "not found" });
  });
  const result = await testMiswagConnection();
  assert.equal(result.ok, true);
}

describe("Miswag Sync 1 Product", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "miswag-sync-one@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "miswag", name: "Miswag", isActive: true });
    const active = await Product.create(sampleProduct());
    productId = String(active._id);
    const inactive = await Product.create(
      sampleProduct({
        ibsherId: "ibs-sync-one-inactive",
        itemCode: "SKU-INACTIVE",
        isActive: false,
      })
    );
    inactiveProductId = String(inactive._id);
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
    restoreMiswagEnv();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    clearMiswagEnv();
    setMiswagFetch(null);
    await MiswagConnection.deleteMany({});
    await PlatformVisibilityRule.deleteMany({});
  });

  it("cannot sync if Miswag connection is not Connected", async () => {
    const blocked = await call("GET", `/api/admin/platforms/miswag/sync-one/preview/${productId}`);
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.message, /disabled until Test Connection/i);
  });

  it("rejects more than one product id", async () => {
    await markConnected();
    const res = await call("POST", "/api/admin/platforms/miswag/sync-one/send", {
      body: { productId, productIds: [productId, inactiveProductId], confirm: true },
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, "not_exactly_one");
  });

  it("blocks inactive products", async () => {
    await markConnected();
    const preview = await previewMiswagTestProduct({
      productId: inactiveProductId,
      categoryId: "L4-999",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(preview.canSend, false);
    assert.equal(preview.plannedAction, "BLOCKED");
    assert.ok(preview.missingFields.some((msg) => /inactive/i.test(msg)));
  });

  it("blocks when required Miswag fields are missing", async () => {
    await markConnected();
    const preview = await previewMiswagTestProduct({
      productId,
      categoryId: "",
      brandId: "",
      lookupExisting: false,
    });
    assert.equal(preview.canSend, false);
    assert.ok(preview.missingFields.some((msg) => /category/i.test(msg)));
  });

  it("uses shared 250-IQD rounded price and does not change stored BrownStore price", async () => {
    await markConnected();
    const before = await Product.findById(productId).lean();
    const rules = await Commission.find({ partner: "miswag" }).lean();
    const pricing = partnerPricePreview(before, rules);
    assert.equal(pricing.storePrice, 1000);
    assert.equal(pricing.rate, 10);
    assert.equal(pricing.price, 1250);

    const built = buildMiswagTestPayload(before, {
      rules,
      categoryId: "L4-999",
      brandId: "42",
    });
    assert.equal(built.platformPrice, 1250);
    assert.equal(built.payload.price, 1250);
    assert.deepEqual(built.payload.variations[0].color, { name: "Black", value: "#000000" });

    const after = await Product.findById(productId).lean();
    assert.equal(after.price, before.price);
    assert.equal(after.discountPrice, before.discountPrice);
  });

  it("safe CREATE flow when item does not exist", async () => {
    await markConnected();
    let createCalled = false;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "GET" && String(url).includes("/v1/items/")) return mockResponse(404, { message: "missing" });
      if (method === "POST" && String(url).includes(MISWAG_ITEM_CREATE_PATH)) {
        createCalled = true;
        const body = JSON.parse(options.body);
        assert.equal(body.external_id, "bs-ibs-sync-one-1");
        assert.equal(body.category_id, "L4-999");
        assert.equal(body.brand_id, 42);
        assert.equal(body.price, 1250);
        assert.equal(body.currency, "IQD");
        assert.ok(Array.isArray(body.variations));
        assert.deepEqual(body.variations[0].color, { name: "Black", value: "#000000" });
        assert.equal(JSON.stringify(options.headers || {}).includes("sk_prd_test_secret"), true);
        return mockResponse(201, { data: { item_id: "mw-created-1" } });
      }
      return mockResponse(404, { message: "unexpected" });
    });

    const secret = process.env.MISWAG_API_SECRET;
    const sent = await sendMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      confirm: true,
    });
    assert.equal(createCalled, true);
    assert.equal(sent.ok, true);
    assert.equal(sent.action, "CREATE");
    assert.equal(sent.httpStatus, 201);
    assert.equal(sent.endpoint, MISWAG_ITEM_CREATE_PATH);
    assert.equal(sent.miswagProductId, "mw-created-1");
    assert.equal(JSON.stringify(sent).includes(secret), false);
    assert.equal(sent.storePriceUnchanged, true);
  });

  it("safe UPDATE flow when external_id already exists", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "GET" && String(url).includes("/v1/items/bs-ibs-sync-one-1")) {
        return mockResponse(200, { data: { id: "mw-existing-9", external_id: "bs-ibs-sync-one-1" } });
      }
      if (method === "POST" && String(url).includes(MISWAG_ITEM_CREATE_PATH)) {
        return mockResponse(200, { data: { item_id: "mw-existing-9" } });
      }
      return mockResponse(404, { message: "unexpected" });
    });

    const preview = await previewMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
    });
    assert.equal(preview.plannedAction, "UPDATE");
    assert.equal(preview.existingOnMiswag, true);

    const sent = await sendMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      confirm: true,
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.action, "UPDATE");
    assert.equal(sent.miswagProductId, "mw-existing-9");
  });

  it("previews one product with the original color and HEX and does not send", async () => {
    await markConnected();
    let posted = false;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "POST") {
        posted = true;
        return mockResponse(500, { message: "must not send" });
      }
      if (method === "HEAD") return mockResponse(200, "");
      return mockResponse(404, {});
    });
    const preview = await previewMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(posted, false);
    assert.equal(preview.canSend, true);
    assert.equal(preview.plannedAction, "CREATE");
    assert.deepEqual(preview.payloadPreview.variations[0].color, {
      name: "Black",
      value: "#000000",
    });
    assert.equal(preview.product.variants[0].color.name, "Black");
  });

  it("does not store a payload hash when Miswag rejects the product", async () => {
    await markConnected();
    await MiswagProductSyncState.deleteMany({});
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "GET" && String(url).includes("/v1/items/")) return mockResponse(404, {});
      if (method === "POST") {
        return mockResponse(422, {
          message: "The variations.0.color.value field is required.",
        });
      }
      return mockResponse(404, {});
    });
    const sent = await sendMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      confirm: true,
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.httpStatus, 422);
    assert.equal(await MiswagProductSyncState.countDocuments({}), 0);
  });

  it("handles duplicate/conflict 409", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "GET" && String(url).includes("/v1/items/")) return mockResponse(404, {});
      if (method === "POST") return mockResponse(409, { message: "Conflict", errors: ["duplicate"] });
      return mockResponse(500, {});
    });
    const sent = await sendMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      confirm: true,
    });
    assert.equal(sent.ok, false);
    assert.equal(sent.httpStatus, 409);
    assert.match(sent.message, /conflict|duplicate|failed|409/i);
  });

  it("maps 400/401/403/429/500 errors without crashing", async () => {
    const cases = [
      [400, /reject|failed|400|validation/i],
      [401, /Authentication failed/i],
      [403, /not permitted|refused|403/i],
      [429, /rate limit/i],
      [500, /server error/i],
    ];
    for (const [status, pattern] of cases) {
      // 401/403 clear Connected — re-establish before each case.
      await markConnected();
      setMiswagFetch(async (url, options) => {
        const method = String(options?.method || "GET").toUpperCase();
        if (method === "HEAD") return mockResponse(200, "");
        if (method === "GET" && String(url).includes("/v1/categories/flat")) {
          return mockResponse(200, { data: { content: [], paging: {} } });
        }
        if (method === "GET") return mockResponse(404, {});
        return mockResponse(status, { message: `err-${status}`, errors: [`e${status}`] });
      });
      const sent = await sendMiswagTestProduct({
        productId,
        categoryId: "L4-999",
        brandId: "42",
        confirm: true,
      });
      assert.equal(sent.ok, false);
      assert.equal(sent.httpStatus, status);
      assert.match(sent.message, pattern);
    }
  });

  it("never exposes the API secret in sync-one responses", async () => {
    await markConnected();
    const secret = "sk_prd_sync_secret_never";
    process.env.MISWAG_API_SECRET = secret;
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      if (method === "GET") return mockResponse(404, {});
      return mockResponse(201, { data: { item_id: "x" } });
    });
    const sent = await call("POST", "/api/admin/platforms/miswag/sync-one/send", {
      body: { productId, categoryId: "L4-999", brandId: "42", confirm: true },
    });
    assert.equal(sent.raw.includes(secret), false);
    assert.equal(sent.raw.toLowerCase().includes("x-api-secret"), false);
  });

  it("does not restore category-mapping models or UI", () => {
    const root = path.resolve(__dirname, "../..");
    assert.equal(fs.existsSync(path.join(__dirname, "models/PlatformCategoryMapping.js")), false);
    assert.equal(fs.existsSync(path.join(__dirname, "services/platformCategoryMapping.js")), false);
    assert.equal(
      fs.existsSync(path.join(root, "client/src/components/admin/MiswagCategoryMapping.jsx")),
      false
    );
    assert.equal(
      fs.existsSync(path.join(root, "client/src/pages/admin/PlatformCategoryMapping.jsx")),
      false
    );
  });

  it("blocks visibility-inactive products", async () => {
    await markConnected();
    await PlatformVisibilityRule.create({
      partner: "miswag",
      scope: "product",
      targetId: productId,
      isActive: false,
    });
    const preview = await previewMiswagTestProduct({
      productId,
      categoryId: "L4-999",
      brandId: "42",
      lookupExisting: false,
    });
    assert.equal(preview.canSend, false);
    assert.equal(preview.eligibility.eligible, false);
  });
});
