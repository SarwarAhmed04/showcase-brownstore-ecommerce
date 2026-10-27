import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  elryanCategoryParentKind,
  formatElryanChildrenLoadError,
  resolveElryanCategoryId,
  shouldFetchElryanCategoryChildren,
} from "./utils/elryanCategoryBrowse.js";
import {
  formatElryanReadError,
  parseElryanErrorPayload,
} from "./utils/elryanErrorMessage.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-catalog-browse-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-browse-test-key-not-for-browser-4c2a";

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

function mockResponse(status, body = {}) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get() {
        return "application/json";
      },
    },
    async text() {
      return text;
    },
  };
}

describe("Elryan category browse helpers", () => {
  it("uses the Elryan category id field", () => {
    assert.equal(resolveElryanCategoryId({ id: 111, hierarchy: "A : B" }), 111);
    assert.equal(resolveElryanCategoryId({ _id: "x" }), "x");
    assert.equal(resolveElryanCategoryId({ categoryId: 9 }), 9);
    assert.equal(resolveElryanCategoryId({}), null);
  });

  it("leaf category → no children request", () => {
    const row = { id: 111, name: "1-Door", isParent: false };
    assert.equal(elryanCategoryParentKind(row), "leaf");
    assert.equal(shouldFetchElryanCategoryChildren(row), false);
  });

  it("parent category → children request", () => {
    const row = { id: 10, name: "Appliances", isParent: true };
    assert.equal(elryanCategoryParentKind(row), "parent");
    assert.equal(shouldFetchElryanCategoryChildren(row), true);
  });

  it("missing isParent → safe handling (do not assume leaf)", () => {
    const row = { id: 55, name: "Unknown shape" };
    assert.equal(elryanCategoryParentKind(row), "unknown");
    assert.equal(shouldFetchElryanCategoryChildren(row), true);
  });

  it("parent 404 → visible inconsistency error (not empty list)", () => {
    const message = formatElryanChildrenLoadError({
      kind: "parent",
      categoryId: 111,
      status: 404,
      code: "NOT_FOUND",
      message: "NOT_FOUND — Category not found.",
    });
    assert.match(message, /parent category 111/i);
    assert.match(message, /inconsistency/i);
    assert.doesNotMatch(message, /no subcategories/i);
  });

  it("parses documented Elryan error bodies into readable messages", () => {
    const parsed = parseElryanErrorPayload({
      success: false,
      error: { code: "NOT_FOUND", message: "Category not found." },
    });
    assert.equal(parsed.code, "NOT_FOUND");
    assert.equal(parsed.message, "Category not found.");

    const formatted = formatElryanReadError({
      httpStatus: 404,
      json: {
        success: false,
        error: { code: "NOT_FOUND", message: "Category not found." },
      },
      text: JSON.stringify({
        success: false,
        error: { code: "NOT_FOUND", message: "Category not found." },
      }),
    });
    assert.equal(formatted.code, "NOT_FOUND");
    assert.equal(formatted.message, "NOT_FOUND — Category not found.");
  });

  it("does not treat every 404 as empty children in the formatter", () => {
    const unknown404 = formatElryanChildrenLoadError({
      kind: "unknown",
      categoryId: 111,
      status: 404,
      code: "NOT_FOUND",
      message: "NOT_FOUND — Category not found.",
    });
    assert.equal(unknown404, "NOT_FOUND — Category not found.");
  });
});

describe("Elryan category children API (mocked)", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-catalog-browse"));
    const user = await User.create({
      email: "elryan-browse-admin@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Elryan Browse Admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan" });
    server = await listen(app());
  });

  after(async () => {
    setElryanFetch(null);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setElryanFetch(null);
    await ElryanConnection.deleteMany({});
    await call("PUT", "/api/admin/platforms/elryan/connection", {
      body: { environment: "staging", apiKey: API_KEY },
    });
  });

  it("parent category → children request hits /children with numeric id", async () => {
    const hits = [];
    setElryanFetch(async (url, options = {}) => {
      const target = String(url);
      hits.push(target);
      assert.equal(options.headers?.["x-api-key"], API_KEY);
      if (target.includes("/v1/categories/10/children")) {
        return mockResponse(200, {
          success: true,
          data: [
            {
              id: 11,
              name: "Child",
              hierarchy: "Root : Child",
              isParent: false,
              level: 2,
            },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${target}`);
    });

    const res = await call("GET", "/api/admin/platforms/elryan/categories/10/children?limit=50");
    assert.equal(res.status, 200);
    assert.equal(res.json.categories.length, 1);
    assert.equal(res.json.categories[0].id, 11);
    assert.ok(hits.some((h) => h.includes("/v1/categories/10/children")));
    assert.equal(shouldFetchElryanCategoryChildren({ id: 10, isParent: true }), true);
  });

  it("parent 404 → visible API error with NOT_FOUND (not empty list)", async () => {
    setElryanFetch(async (url) => {
      const target = String(url);
      if (target.includes("/children")) {
        return mockResponse(404, {
          success: false,
          error: { code: "NOT_FOUND", message: "Category not found." },
          meta: { timestamp: "2026-01-01T00:00:00.000Z" },
        });
      }
      return mockResponse(200, { data: [] });
    });

    const res = await call("GET", "/api/admin/platforms/elryan/categories/111/children?limit=50");
    assert.equal(res.status, 404);
    assert.equal(res.json.code, "NOT_FOUND");
    assert.match(res.json.message, /NOT_FOUND/i);
    assert.match(res.json.message, /Category not found/i);
    assert.equal(Array.isArray(res.json.categories), false);

    const uiMessage = formatElryanChildrenLoadError({
      kind: "parent",
      categoryId: 111,
      status: res.status,
      code: res.json.code,
      message: res.json.message,
    });
    assert.match(uiMessage, /inconsistency/i);
  });

  it("empty children response → empty categories array", async () => {
    setElryanFetch(async (url) => {
      if (String(url).includes("/children")) {
        return mockResponse(200, { success: true, data: [] });
      }
      return mockResponse(200, { data: [] });
    });

    const res = await call("GET", "/api/admin/platforms/elryan/categories/20/children?limit=50");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.categories, []);
  });

  it("leaf decision never needs a children HTTP call", () => {
    const leaf = { id: 111, name: "1-Door", isParent: false, hierarchy: "Home : Fridge : 1-Door", level: 3 };
    assert.equal(shouldFetchElryanCategoryChildren(leaf), false);
    assert.equal(resolveElryanCategoryId(leaf), 111);
    assert.equal(elryanCategoryParentKind(leaf), "leaf");
  });
});
