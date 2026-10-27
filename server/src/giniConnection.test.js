import assert from "node:assert/strict";
import crypto from "crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Commission, COMMISSION_SCOPES } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniConnection } from "./models/GiniConnection.js";
import { decryptApiKey } from "./utils/partnerAuth.js";
import { applyCommissionRate } from "./utils/commission.js";
import { taxonomyFieldsFor } from "./utils/platformTaxonomyFields.js";
import { MISWAG_AUTH_HEADERS } from "./services/miswag.js";
import {
  GINI_CATEGORIES_PATH,
  GINI_PING_PATH,
  giniRequestPath,
  signGiniRequest,
} from "./utils/giniSigner.js";
import { GINI_DEFAULT_BASE_URL, GINI_HOST_UNVERIFIED_MESSAGE, setGiniFetch } from "./services/giniConnection.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "gini-connection-test-secret";

const CLIENT_ID = "gini-client-id-test";
const SECRET = "g1n1-seal-9f3c2a7b-not-a-header";
const SECRET_NEXT = "g1n1-replaced-secret-77aa";

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

function mockResponse(status, body = {}, headers = {}) {
  const text = body == null ? "" : typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async text() {
      return text;
    },
  };
}

function pingOk() {
  return mockResponse(200, { data: { ok: true } }, { "content-type": "application/json" });
}

function categoriesOk() {
  return mockResponse(
    200,
    {
      data: [
        { id: 3, name: "Electronics", subcategories: [{ id: 12, name: "Audio" }] },
        { id: 4, name: "Home", subcategories: [{ id: 18, name: "Kitchen" }] },
      ],
    },
    { "content-type": "application/json" }
  );
}

describe("GINI API connection", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("brownstore"));
    const user = await User.create({
      email: "gini-conn@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    server = await listen(app());
  });

  after(async () => {
    setGiniFetch(null);
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setGiniFetch(null);
    await GiniConnection.deleteMany({});
    await Partner.deleteMany({ slug: "gini" });
    await Commission.deleteMany({ partner: "gini" });
    await PlatformTaxonomyConfig.deleteMany({ partner: "gini" });
  });

  it("signs METHOD + PATH + empty GET body + TIMESTAMP as lowercase HMAC-SHA256", () => {
    const timestamp = "1739270400";
    const signed = signGiniRequest({
      method: "get",
      path: "https://merchant.gini.iq/api/v2.0/third-party/ping?page=2",
      body: "{\"ignored\":true}",
      timestamp,
      clientSecret: SECRET,
    });
    const signingString = `GET${GINI_PING_PATH}${timestamp}`;
    const expected = crypto.createHmac("sha256", SECRET).update(signingString).digest("hex");
    assert.equal(signed.method, "GET");
    assert.equal(signed.path, GINI_PING_PATH);
    assert.equal(signed.body, "");
    assert.equal(signed.path.includes("merchant.gini.iq"), false);
    assert.equal(signed.path.includes("?"), false);
    assert.equal(giniRequestPath("/api/v2.0/third-party/ping?page=2#x"), GINI_PING_PATH);
    assert.equal(signed.signature, expected);
    assert.match(signed.signature, /^[0-9a-f]+$/);
    assert.equal(signed.signature, signed.signature.toLowerCase());
  });

  it("keeps a future JSON body exact and still excludes the host and query", () => {
    const body = "{\"name\":\"Cup\"}";
    const signed = signGiniRequest({
      method: "POST",
      path: "/api/v2.0/third-party/products?dry=1",
      body,
      timestamp: "1739270401",
      clientSecret: SECRET,
    });
    const expected = crypto
      .createHmac("sha256", SECRET)
      .update(`POST/api/v2.0/third-party/products${body}1739270401`)
      .digest("hex");
    assert.equal(signed.body, body);
    assert.equal(signed.path, "/api/v2.0/third-party/products");
    assert.equal(signed.signature, expected);
  });

  it("encrypts the client secret at rest and never returns it", async () => {
    const saved = await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.hasSecret, true);
    assert.equal(saved.json.clientId, CLIENT_ID);
    assert.equal(saved.json.status, "configured");
    assert.equal(saved.raw.includes(SECRET), false);
    assert.equal(saved.raw.includes("clientSecret"), false);

    const raw = await GiniConnection.collection.findOne({ singletonKey: "default" });
    assert.notEqual(raw.clientSecretEnc, SECRET);
    assert.equal(decryptApiKey(raw.clientSecretEnc), SECRET);
    const lean = await GiniConnection.findOne({ singletonKey: "default" }).lean();
    assert.equal(lean.clientSecretEnc, undefined);

    const loaded = await call("GET", "/api/admin/platforms/gini/connection");
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.hasSecret, true);
    assert.equal(loaded.json.clientId, CLIENT_ID);
    assert.equal(loaded.json.baseUrl, GINI_DEFAULT_BASE_URL);
    assert.equal(loaded.raw.includes(SECRET), false);
    assert.equal(loaded.raw.includes(raw.clientSecretEnc), false);
  });

  it("preserves a saved secret when the secret field is blank and replaces it only when supplied", async () => {
    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const kept = await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: "https://app.gini.iq", clientId: CLIENT_ID, clientSecret: "   " },
    });
    assert.equal(kept.json.baseUrl, "https://app.gini.iq");
    assert.equal(kept.json.hasSecret, true);
    assert.equal(kept.raw.includes(SECRET), false);
    const still = await GiniConnection.collection.findOne({ singletonKey: "default" });
    assert.equal(decryptApiKey(still.clientSecretEnc), SECRET);

    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: "https://app.gini.iq", clientId: CLIENT_ID, clientSecret: SECRET_NEXT },
    });
    const replaced = await GiniConnection.collection.findOne({ singletonKey: "default" });
    assert.equal(decryptApiKey(replaced.clientSecretEnc), SECRET_NEXT);
    assert.notEqual(decryptApiKey(replaced.clientSecretEnc), SECRET);
  });

  it("rejects unsafe base URLs before any GINI request", async () => {
    const calls = [];
    setGiniFetch(async (url, options) => {
      calls.push({ url, method: options.method });
      return pingOk();
    });
    for (const baseUrl of [
      "http://merchant.gini.iq",
      "https://127.0.0.1",
      "https://localhost",
      "https://10.1.1.1",
      "https://evil.example",
      "https://user:secret@merchant.gini.iq",
    ]) {
      const response = await call("POST", "/api/admin/platforms/gini/connection/test", {
        body: { baseUrl, clientId: CLIENT_ID, clientSecret: SECRET },
      });
      assert.equal(response.status, 400, baseUrl);
      assert.equal(response.raw.includes(SECRET), false);
    }
    assert.equal(calls.length, 0);
  });

  it("tests with GET ping and categories only and ignores frontend timestamp and signature", async () => {
    const calls = [];
    const logs = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    console.error = (...args) => logs.push(args.map(String).join(" "));
    setGiniFetch(async (url, options) => {
      calls.push({ url: String(url), method: String(options.method), headers: options.headers });
      if (String(url).endsWith(GINI_PING_PATH)) return pingOk();
      if (String(url).endsWith(GINI_CATEGORIES_PATH)) return categoriesOk();
      throw new Error("unexpected path");
    });

    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const mapping = await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "col-1",
      values: { categoryId: "3", subcategoryId: "12", categoryName: "Keep", subcategoryName: "Keep" },
    });
    const commission = await Commission.create({
      partner: "gini",
      scope: "all",
      targetId: "*",
      percentage: 10,
    });
    const partner = await Partner.create({
      slug: "gini",
      name: "Gini",
      apiKeyEnc: "leave-partner-key",
      apiKeyHash: "leave-hash",
    });

    try {
      const response = await call("POST", "/api/admin/platforms/gini/connection/test", {
        body: {
          baseUrl: GINI_DEFAULT_BASE_URL,
          clientId: CLIENT_ID,
          clientSecret: SECRET,
          timestamp: "1",
          signature: "deadbeef",
        },
      });
      assert.equal(response.status, 200);
      assert.equal(response.json.ok, true);
      assert.equal(response.json.status, "connected");
      assert.equal(response.json.method, "GET");
      assert.equal(response.json.endpoint, GINI_PING_PATH);
      assert.equal(response.json.categories.ok, true);
      assert.equal(response.json.categories.topLevelCount, 2);
      assert.equal(response.json.categories.subcategoryAccess, true);
      assert.equal(response.json.connection.status, "connected");
      assert.equal(response.json.connection.hasSecret, true);
      assert.equal(response.raw.includes(SECRET), false);
      assert.equal(response.raw.includes("deadbeef"), false);
      assert.equal(response.raw.includes("clientSecret"), false);

      assert.equal(calls.length, 2);
      for (const entry of calls) {
        assert.equal(entry.method, "GET");
        assert.equal(entry.url.includes("?"), false);
        assert.equal(entry.url.startsWith(GINI_DEFAULT_BASE_URL), true);
        assert.equal(entry.headers["X-API-KEY"], CLIENT_ID);
        assert.match(entry.headers["X-TIMESTAMP"], /^\d+$/);
        assert.notEqual(entry.headers["X-TIMESTAMP"], "1");
        assert.match(entry.headers["X-SIGNATURE"], /^[0-9a-f]+$/);
        assert.notEqual(entry.headers["X-SIGNATURE"], "deadbeef");
        assert.ok(entry.headers["User-Agent"]);
        const signed = signGiniRequest({
          method: "GET",
          path: new URL(entry.url).pathname,
          body: "",
          timestamp: entry.headers["X-TIMESTAMP"],
          clientSecret: SECRET,
        });
        assert.equal(entry.headers["X-SIGNATURE"], signed.signature);
        assert.equal(response.raw.includes(signed.signature), false);
        const values = Object.values(entry.headers);
        assert.equal(values.includes(SECRET), false);
        assert.equal(Object.keys(entry.headers).some((key) => /secret/i.test(key)), false);
      }
      assert.equal(calls[0].url.endsWith(GINI_PING_PATH), true);
      assert.equal(calls[1].url.endsWith(GINI_CATEGORIES_PATH), true);
      assert.equal(logs.some((line) => line.includes(SECRET)), false);

      const storedMapping = await PlatformTaxonomyConfig.findById(mapping._id).lean();
      assert.equal(storedMapping.values.categoryId, "3");
      assert.equal(storedMapping.values.subcategoryId, "12");
      const storedCommission = await Commission.findById(commission._id).lean();
      assert.equal(storedCommission.percentage, 10);
      const storedPartner = await Partner.findById(partner._id).select("+apiKeyEnc").lean();
      assert.equal(storedPartner.apiKeyEnc, "leave-partner-key");
      assert.equal(await GiniConnection.countDocuments({ clientSecretEnc: SECRET }), 0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  });

  it("does not call the alternate host by itself", async () => {
    const hosts = [];
    setGiniFetch(async (url) => {
      hosts.push(new URL(url).host);
      const error = new Error("getaddrinfo ENOTFOUND");
      error.code = "ENOTFOUND";
      throw error;
    });
    const response = await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(response.json.status, "host_unverified");
    assert.match(response.json.message, /GINI host could not be verified/);
    assert.equal(response.json.message.includes(GINI_HOST_UNVERIFIED_MESSAGE), true);
    assert.deepEqual(hosts, ["merchant.gini.iq"]);
    assert.equal(response.json.alternateHost, "https://app.gini.iq");
    assert.equal(response.raw.includes(SECRET), false);
  });

  it("maps 401, 403, 429, 5xx, edge HTML, and network failures without leaking the secret", async () => {
    const cases = [
      {
        name: "401",
        response: mockResponse(401, { error: "Invalid signature" }),
        status: "auth_failed",
        message: /Authentication failed/,
      },
      {
        name: "403",
        response: mockResponse(403, { error: "Client account is inactive" }),
        status: "forbidden",
        message: /Access forbidden/,
      },
      {
        name: "429",
        response: mockResponse(429, { error: "slow down" }, { "retry-after": "9" }),
        status: "rate_limited",
        message: /Rate limited\. Wait 9 seconds/,
      },
      {
        name: "503",
        response: mockResponse(503, "<html>cloudfront</html>", { "content-type": "text/html" }),
        status: "server_error",
        message: /temporarily unavailable/,
      },
      {
        name: "edge",
        response: mockResponse(403, "<HTML>Generated by cloudfront Request blocked</HTML>", {
          "content-type": "text/html",
        }),
        status: "edge_blocked",
        message: /edge\/request blocked/,
      },
    ];

    for (const item of cases) {
      const methods = [];
      setGiniFetch(async (_url, options) => {
        methods.push(options.method);
        return item.response;
      });
      const response = await call("POST", "/api/admin/platforms/gini/connection/test", {
        body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
      });
      assert.equal(response.json.status, item.status, item.name);
      assert.match(response.json.message, item.message, item.name);
      assert.deepEqual(methods, ["GET"]);
      assert.equal(response.raw.includes(SECRET), false, item.name);
      assert.equal(response.json.ok, false);
    }

    setGiniFetch(async () => {
      throw new Error("socket hang up");
    });
    const network = await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: "https://app.gini.iq", clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(network.json.status, "connection_failed");
    assert.match(network.json.message, /Connection failed/);
    assert.equal(network.raw.includes(SECRET), false);
  });

  it("parses a category tree larger than 20 KB instead of marking categories failed", async () => {
    const filler = "ن".repeat(400);
    const data = [];
    for (let categoryId = 1; categoryId <= 20; categoryId += 1) {
      const subcategories = [];
      for (let subId = 1; subId <= 8; subId += 1) {
        subcategories.push({
          id: categoryId * 100 + subId,
          name: `${filler}-${categoryId}-${subId}`,
          slug: `sub-${categoryId}-${subId}`,
          is_active: 1,
          image: filler,
        });
      }
      data.push({
        id: categoryId,
        name: `Category ${categoryId} ${filler}`,
        slug: `cat-${categoryId}`,
        is_active: 1,
        image_url: filler,
        icon_url: filler,
        subcategories,
      });
    }
    const body = { data };
    assert.ok(JSON.stringify(body).length > 20000);
    const methods = [];
    setGiniFetch(async (url, options = {}) => {
      methods.push(String(options.method || "GET").toUpperCase());
      if (String(url).endsWith(GINI_PING_PATH)) return pingOk();
      if (String(url).endsWith(GINI_CATEGORIES_PATH)) {
        return mockResponse(200, body, { "content-type": "application/json" });
      }
      throw new Error(`unexpected ${url}`);
    });
    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const response = await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(response.json.ok, true);
    assert.equal(response.json.categories.ok, true);
    assert.equal(response.json.categories.topLevelCount, 20);
    assert.deepEqual(methods, ["GET", "GET"]);
    const stored = await GiniConnection.findOne({ singletonKey: "default" }).lean();
    assert.equal(stored.lastCategoriesOk, true);
    assert.equal(stored.lastCategoriesCount, 20);
    assert.equal(stored.categories, undefined);
    assert.equal(JSON.stringify(stored).includes(filler), false);
    const helper = fs.readFileSync(new URL("./services/giniConnection.js", import.meta.url), "utf8");
    const reader = helper.slice(helper.indexOf("async function giniGet"), helper.indexOf("function categorySummary"));
    assert.match(reader, /const text = String\(await response\.text\(\)\)/);
    assert.match(reader, /safeJson\(text, contentType\)/);
    assert.equal(reader.includes("response.text()).slice"), false);
  });

  it("leaves GINI Excel, taxonomy fields, commission rounding, and Miswag auth untouched", () => {
    const giniExport = fs.readFileSync(new URL("./utils/platformExcel/gini.js", import.meta.url), "utf8");
    assert.match(giniExport, /اسم المنتج/);
    assert.equal(giniExport.includes("signGiniRequest"), false);
    assert.equal(giniExport.includes("GiniConnection"), false);
    const fields = taxonomyFieldsFor("gini").map((field) => field.key);
    assert.deepEqual(fields, ["categoryName", "categoryId", "subcategoryName", "subcategoryId"]);
    assert.equal(applyCommissionRate(100000, 10), 110000);
    assert.equal(COMMISSION_SCOPES.includes("brand"), true);
    assert.equal(MISWAG_AUTH_HEADERS.apiSecret, "X-API-Secret");
    assert.equal(MISWAG_AUTH_HEADERS.apiKey, "X-API-Key");
  });
});
