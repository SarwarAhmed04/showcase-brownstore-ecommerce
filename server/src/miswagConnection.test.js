import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { MiswagConnection } from "./models/MiswagConnection.js";
import {
  MISWAG_AUTH_HEADERS,
  MISWAG_HEALTHCHECK_PATH,
  assertMiswagSyncAllowed,
  getMiswagConnectionPublic,
  miswagSyncAllowed,
  setMiswagFetch,
  testMiswagConnection,
} from "./services/miswag.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "miswag-connection-test-secret";

let memory;
let server;
let token;
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

describe("Miswag API connection", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "miswag-conn@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
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
  });

  it("reports missing credentials", async () => {
    const state = await getMiswagConnectionPublic();
    assert.equal(state.status, "not_configured");
    assert.equal(state.configured, false);
    assert.equal(state.syncEnabled, false);
    assert.equal(state.hasApiKey, false);
    assert.equal(state.hasApiSecret, false);

    const tested = await testMiswagConnection({});
    assert.equal(tested.ok, false);
    assert.equal(tested.status, "not_configured");
    assert.match(tested.message, /API Key|API Secret|Base URL/i);
    assert.equal(tested.syncEnabled, false);
  });

  it("connects only after healthcheck AND authenticated categories GET succeed", async () => {
    let seenHeaders = null;
    const methods = [];
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      methods.push(method);
      seenHeaders = options.headers;
      if (method === "HEAD") {
        assert.ok(String(url).includes(MISWAG_HEALTHCHECK_PATH));
        return mockResponse(200, "");
      }
      assert.ok(String(url).includes("/v1/categories/flat"));
      return mockResponse(200, { data: { content: [], paging: {} } });
    });

    process.env.MISWAG_BASE_URL = "https://seller-api.miswag.com";
    process.env.MISWAG_API_KEY = "ak_prd_test_key_123";
    process.env.MISWAG_API_SECRET = "sk_prd_test_secret_456";

    const result = await testMiswagConnection();
    assert.equal(result.ok, true);
    assert.equal(result.status, "connected");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.message, "Connected successfully");
    assert.equal(result.syncEnabled, true);
    assert.equal(result.diagnostics.authOk, true);
    assert.equal(result.diagnostics.endpoint, "/v1/categories/flat");
    assert.deepEqual(methods, ["HEAD", "GET"]);
    assert.equal(seenHeaders[MISWAG_AUTH_HEADERS.apiKey], "ak_prd_test_key_123");
    assert.equal(seenHeaders[MISWAG_AUTH_HEADERS.apiSecret], "sk_prd_test_secret_456");
    assert.equal(await miswagSyncAllowed(), true);
  });

  it("does not stay Connected when categories GET returns 401 after healthcheck 200", async () => {
    setMiswagFetch(async (url, options) => {
      const method = String(options?.method || "GET").toUpperCase();
      if (method === "HEAD") return mockResponse(200, "");
      assert.ok(String(url).includes("/v1/categories/flat"));
      return mockResponse(401, { message: "Unauthorized" });
    });
    process.env.MISWAG_API_KEY = "ak_prd_partial";
    process.env.MISWAG_API_SECRET = "sk_prd_partial";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "auth_failed");
    assert.equal(result.httpStatus, 401);
    assert.equal(result.endpoint, "/v1/categories/flat");
    assert.equal(result.method, "GET");
    assert.equal(await miswagSyncAllowed(), false);
    const publicState = await getMiswagConnectionPublic();
    assert.equal(publicState.status, "auth_failed");
    assert.equal(publicState.syncEnabled, false);
  });

  it("maps 401 authentication failures", async () => {
    setMiswagFetch(async () => mockResponse(401, { message: "Unauthorized" }));
    process.env.MISWAG_API_KEY = "ak_bad";
    process.env.MISWAG_API_SECRET = "sk_bad";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "auth_failed");
    assert.equal(result.httpStatus, 401);
    assert.match(result.message, /Authentication failed/i);
    assert.equal(result.syncEnabled, false);
  });

  it("maps 403 forbidden responses", async () => {
    setMiswagFetch(async () => mockResponse(403, { message: "Forbidden" }));
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "forbidden");
    assert.equal(result.httpStatus, 403);
    assert.match(result.message, /access is not permitted/i);
  });

  it("maps 404 incorrect endpoint responses", async () => {
    setMiswagFetch(async () => mockResponse(404, { message: "Missing" }));
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "not_found");
    assert.equal(result.httpStatus, 404);
    assert.match(result.message, /Base URL may be incorrect/i);
  });

  it("maps 429 rate limits", async () => {
    setMiswagFetch(async () => mockResponse(429, { message: "Slow down" }, { "retry-after": "2" }));
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "rate_limited");
    assert.equal(result.httpStatus, 429);
    assert.match(result.message, /rate limit/i);
  });

  it("maps 500 server errors", async () => {
    setMiswagFetch(async () => mockResponse(500, { message: "Boom", event_id: "evt_1" }));
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "server_error");
    assert.equal(result.httpStatus, 500);
    assert.match(result.message, /server error/i);
  });

  it("maps network failures with a safe message", async () => {
    setMiswagFetch(async () => {
      throw new Error("getaddrinfo ENOTFOUND seller-api.miswag.com");
    });
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const result = await testMiswagConnection();
    assert.equal(result.ok, false);
    assert.equal(result.status, "network_error");
    assert.equal(result.httpStatus, 0);
    assert.match(result.message, /ENOTFOUND|network/i);
    assert.equal(result.syncEnabled, false);
  });

  it("never returns the API secret to the client after save", async () => {
    const secret = "sk_prd_never_echo_this_secret_value";
    const saved = await call("PUT", "/api/admin/platforms/miswag/connection", {
      body: {
        baseUrl: "https://seller-api.miswag.com",
        apiKey: "ak_prd_visible_prefix_only",
        apiSecret: secret,
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.hasApiSecret, true);
    assert.equal(saved.json.secretSet, true);
    assert.equal(saved.json.hasApiKey, true);
    assert.ok(saved.json.apiKeyPrefix);
    assert.equal(saved.raw.includes(secret), false);
    assert.equal("apiSecret" in saved.json, false);
    assert.equal(JSON.stringify(saved.json).includes(secret), false);

    const loaded = await call("GET", "/api/admin/platforms/miswag/connection");
    assert.equal(loaded.status, 200);
    assert.equal(loaded.raw.includes(secret), false);
    assert.equal("apiSecret" in loaded.json, false);
  });

  it("disables product sync actions until connection succeeds", async () => {
    const blocked = await call("POST", "/api/admin/platforms/miswag/sync/products");
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.message, /disabled until Test Connection/i);
    assert.equal(await miswagSyncAllowed(), false);
    await assert.rejects(() => assertMiswagSyncAllowed(), /disabled until Test Connection/);

    setMiswagFetch(async (_url, options) => {
      if (String(options?.method || "GET").toUpperCase() === "HEAD") return mockResponse(200, "");
      return mockResponse(200, { data: { content: [], paging: {} } });
    });
    process.env.MISWAG_API_KEY = "ak_ok";
    process.env.MISWAG_API_SECRET = "sk_ok";
    const connected = await testMiswagConnection();
    assert.equal(connected.ok, true);

    const after = await call("POST", "/api/admin/platforms/miswag/sync/products");
    assert.equal(after.status, 501);
    assert.match(after.json.message, /not implemented|Sync 1 Product/i);

    const bulk = await call("POST", "/api/admin/platforms/miswag/sync/bulk");
    assert.equal(bulk.status, 501);
  });

  it("exposes diagnostics without secrets on test endpoint", async () => {
    const secret = "sk_prd_diag_secret_zzz";
    setMiswagFetch(async () => mockResponse(401, { message: "nope" }));
    const result = await call("POST", "/api/admin/platforms/miswag/connection/test", {
      body: {
        baseUrl: "https://seller-api.miswag.com",
        apiKey: "ak_prd_diag",
        apiSecret: secret,
      },
    });
    assert.equal(result.status, 401);
    assert.equal(result.json.httpStatus, 401);
    assert.equal(result.json.diagnostics.endpoint, MISWAG_HEALTHCHECK_PATH);
    assert.equal(result.json.diagnostics.authOk, false);
    assert.ok(Number(result.json.diagnostics.responseMs) >= 0);
    assert.equal(result.raw.includes(secret), false);
    assert.equal(result.json.connection?.headers?.apiKey, MISWAG_AUTH_HEADERS.apiKey);
    assert.equal(result.json.connection?.headers?.apiSecret, MISWAG_AUTH_HEADERS.apiSecret);
  });
});
