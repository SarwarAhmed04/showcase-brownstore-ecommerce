import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import { User } from "./models/User.js";
import {
  findMiswagBrands,
  findMiswagCategories,
  normalizeMiswagBrand,
  normalizeMiswagCategory,
  setMiswagFetch,
  testMiswagConnection,
} from "./services/miswag.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-discovery-test-secret";

let memory;
let server;
let token;

function mockResponse(status, body = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: { get() { return null; } },
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

async function call(method, urlPath) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
}

async function markConnected() {
  process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
  process.env.MISWAG_API_KEY = "ak_prd_disc";
  process.env.MISWAG_API_SECRET = "sk_prd_disc_secret";
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

describe("Miswag category/brand discovery helpers", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "miswag-discovery@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    server = await listen(app());
  });

  after(async () => {
    setMiswagFetch(null);
    delete process.env.MISWAG_API_KEY;
    delete process.env.MISWAG_API_SECRET;
    delete process.env.MISWAG_BASE_URL;
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setMiswagFetch(null);
    await MiswagConnection.deleteMany({});
    delete process.env.MISWAG_API_KEY;
    delete process.env.MISWAG_API_SECRET;
    delete process.env.MISWAG_BASE_URL;
  });

  it("normalizes category rows and derives L3/L4 levels from ids", () => {
    const row = normalizeMiswagCategory({
      id: "L4-123",
      name_en: "Blenders",
      name_ar: "خلاطات",
      path: ["Home", "Kitchen", "Blenders"],
      active: true,
    });
    assert.equal(row.id, "L4-123");
    assert.equal(row.level, "L4");
    assert.equal(row.name, "Blenders");
    assert.equal(row.path, "Home > Kitchen > Blenders");
  });

  it("filters live flat categories without saving a mapping store", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      assert.match(String(url), /\/v1\/categories\/flat/);
      return mockResponse(200, {
        data: {
          content: [
            { id: "L2-1", name_en: "Home", path: "Home" },
            { id: "L4-99", name_en: "Food Processors", name_ar: "محضرات", path: "Home > Kitchen > Food Processors" },
            { id: "L3-50", name_en: "Kitchen Appliances", path: "Home > Kitchen" },
            { id: "L4-100", name_en: "Toasters", path: "Home > Kitchen > Toasters" },
          ],
          paging: {},
        },
      });
    });

    const found = await findMiswagCategories({ q: "food", limit: 10 });
    assert.equal(found.endpoint, "/v1/categories/flat");
    assert.equal(found.searchEndpoint, null);
    assert.equal(found.categories.length, 1);
    assert.equal(found.categories[0].id, "L4-99");
    assert.equal(found.categories[0].level, "L4");
    assert.match(found.categories[0].path, /Food Processors/);

    const viaApi = await call("GET", "/api/admin/platforms/miswag/sync-one/categories?q=kitchen");
    assert.equal(viaApi.status, 200);
    assert.ok(viaApi.json.categories.some((row) => row.id === "L3-50" || row.id === "L4-100"));
    assert.equal(viaApi.json.categories.every((row) => row.level === "L3" || row.level === "L4"), true);
  });

  it("searches brands via /v1/brands/search", async () => {
    await markConnected();
    setMiswagFetch(async (url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      assert.match(String(url), /\/v1\/brands\/search\?q=/);
      return mockResponse(200, {
        data: {
          content: [
            { id: 42, name: "Philips", alias: "philips" },
            { id: 7, name: "Other" },
          ],
        },
      });
    });

    const brand = normalizeMiswagBrand({ id: 42, name: "Philips", alias: "philips" });
    assert.deepEqual(brand, { id: 42, name: "Philips", alias: "philips" });

    const found = await findMiswagBrands({ q: "Philips" });
    assert.equal(found.endpoint, "/v1/brands/search");
    assert.equal(found.brands[0].id, 42);
    assert.equal(found.brands[0].name, "Philips");

    const viaApi = await call("GET", "/api/admin/platforms/miswag/sync-one/brands?q=Philips");
    assert.equal(viaApi.status, 200);
    assert.equal(viaApi.json.brands[0].id, 42);
  });

  it("requires Connected status for discovery routes", async () => {
    const cats = await call("GET", "/api/admin/platforms/miswag/sync-one/categories?q=x");
    assert.equal(cats.status, 403);
    const brands = await call("GET", "/api/admin/platforms/miswag/sync-one/brands?q=x");
    assert.equal(brands.status, 403);
  });
});
