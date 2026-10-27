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
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  __resetElryanAttributeValueCatalogCacheForTests,
  peekElryanAttributeValueListCacheForTests,
} from "./services/elryanAttributeValueCatalog.js";
import { elryanProductWritesEnabled } from "./utils/elryanConstants.js";
import {
  assertVerifiedElryanValueIdForMapping,
  findElryanCatalogRowByExactId,
  normalizeElryanAttributeName,
  verifyElryanCatalogIdAndName,
} from "./utils/elryanAttributeValues.js";
import { encryptApiKey } from "./utils/partnerAuth.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-brand-safety-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-brand-safety-test-key-not-for-browser";

const BRAND_LIST = [
  { id: "8792", name: "Tosot", nameAr: "توسوت" },
  { id: "10104", name: "ingco", nameAr: "انكو" },
  { id: "9001", name: "Other", nameAr: "" },
];

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
  return { status: response.status, json };
}

function mockResponse(status, body = {}) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-type" ? "application/json" : null;
      },
    },
    async text() {
      return text;
    },
  };
}

function mockBrandListFetch() {
  setElryanFetch(async (url) => {
    const target = String(url);
    if (target.includes("/attribute-values/id/")) {
      return mockResponse(404, {
        success: false,
        error: { code: "NOT_FOUND", message: "Resource not found" },
      });
    }
    if (target.includes("/attribute-values/Brand/list")) {
      return mockResponse(200, {
        success: true,
        data: BRAND_LIST,
        meta: { timestamp: "t" },
      });
    }
    if (target.includes("/attribute-values/Color/list")) {
      return mockResponse(200, {
        success: true,
        data: [{ id: "52", name: "Gray", nameAr: "" }],
        meta: { timestamp: "t" },
      });
    }
    return mockResponse(200, { data: [], meta: { page: 1, limit: 30, total: 0, timestamp: "t" } });
  });
}

describe("Elryan attribute value id helpers", () => {
  it("matches exact ids and normalizes names without inventing ids", () => {
    assert.equal(normalizeElryanAttributeName("INGCO"), "ingco");
    const found = findElryanCatalogRowByExactId(BRAND_LIST, "10104");
    assert.equal(found.verifiedId, "10104");
    assert.equal(found.name, "ingco");
    assert.equal(findElryanCatalogRowByExactId(BRAND_LIST, 0), null);
    assert.throws(() => assertVerifiedElryanValueIdForMapping("brand", ""), /verified/i);
  });

  it("verifies 10104 + ingco and rejects mismatches", () => {
    const ok = verifyElryanCatalogIdAndName({
      rows: BRAND_LIST,
      valueId: "10104",
      name: "INGCO",
      requireName: true,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.value.verifiedId, "10104");

    const badName = verifyElryanCatalogIdAndName({
      rows: BRAND_LIST,
      valueId: "10104",
      name: "Tosot",
      requireName: true,
    });
    assert.equal(badName.ok, false);
    assert.equal(badName.code, "name_id_mismatch");

    const missing = verifyElryanCatalogIdAndName({
      rows: BRAND_LIST,
      valueId: "99999",
      name: "ingco",
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.code, "attribute_value_not_found");
  });
});

describe("Elryan Brand/list verification (mocked)", () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri());
    const user = await User.create({
      email: "elryan-brand-list@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Elryan Brand List",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan" });
    server = await listen(app());
  });

  after(async () => {
    setElryanFetch(null);
    __resetElryanAttributeValueCatalogCacheForTests();
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    setElryanFetch(null);
    __resetElryanAttributeValueCatalogCacheForTests();
    await ElryanConnection.deleteMany({});
    await ElryanValueMapping.deleteMany({});
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
    mockBrandListFetch();
  });

  it("searches Brand/list with real ids and server-side pagination", async () => {
    const res = await call(
      "GET",
      "/api/admin/platforms/elryan/attribute-values/Brand?search=ingco&page=1&limit=30"
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.idsAvailable, true);
    assert.ok(res.json.values.some((v) => v.verifiedId === "10104" && v.name === "ingco"));
    assert.equal(res.json.environment, "staging");
  });

  it("verifies INGCO id 10104 against Brand/list even when by-id returns 404", async () => {
    const byId = await call("GET", "/api/admin/platforms/elryan/attribute-values/id/10104");
    assert.equal(byId.status, 404);

    const verified = await call("POST", "/api/admin/platforms/elryan/attribute-values/verify", {
      body: { attribute: "Brand", valueId: "10104", name: "ingco" },
    });
    assert.equal(verified.status, 200);
    assert.equal(verified.json.ok, true);
    assert.equal(verified.json.value.verifiedId, "10104");
    assert.equal(verified.json.value.name, "ingco");
    assert.equal(verified.json.verifiedAgainst, "attribute_values_list");
  });

  it("rejects invalid/missing ids and name mismatches on verify", async () => {
    const missing = await call("POST", "/api/admin/platforms/elryan/attribute-values/verify", {
      body: { attribute: "Brand", valueId: "99999", name: "ingco" },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, "attribute_value_not_found");

    const mismatch = await call("POST", "/api/admin/platforms/elryan/attribute-values/verify", {
      body: { attribute: "Brand", valueId: "10104", name: "Tosot" },
    });
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.json.code, "name_id_mismatch");

    const empty = await call("POST", "/api/admin/platforms/elryan/attribute-values/verify", {
      body: { attribute: "Brand", valueId: "" },
    });
    assert.equal(empty.status, 400);
  });

  it("blocks save when catalog is empty or remote errors", async () => {
    setElryanFetch(async (url) => {
      if (String(url).includes("/Brand/list")) {
        return mockResponse(200, { success: true, data: [], meta: { timestamp: "t" } });
      }
      return mockResponse(500, { error: { code: "ERROR", message: "boom" } });
    });
    __resetElryanAttributeValueCatalogCacheForTests();
    const emptySave = await call("PUT", "/api/admin/platforms/elryan/value-mappings", {
      body: {
        kind: "brand",
        brownKey: "INGCO",
        brownLabel: "INGCO",
        elryanId: "10104",
        elryanLabel: "ingco",
      },
    });
    assert.ok(emptySave.status >= 400);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "brand" }), 0);

    setElryanFetch(async () =>
      mockResponse(502, { error: { code: "BAD_GATEWAY", message: "down" } })
    );
    __resetElryanAttributeValueCatalogCacheForTests();
    const errSave = await call("PUT", "/api/admin/platforms/elryan/value-mappings", {
      body: {
        kind: "brand",
        brownKey: "INGCO",
        brownLabel: "INGCO",
        elryanId: "10104",
        elryanLabel: "ingco",
      },
    });
    assert.ok(errSave.status >= 400);
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "brand" }), 0);
  });

  it("saves brand mapping only after Brand/list verification of 10104 + ingco", async () => {
    const saved = await call("PUT", "/api/admin/platforms/elryan/value-mappings", {
      body: {
        kind: "brand",
        brownKey: "INGCO",
        brownLabel: "INGCO",
        elryanId: "10104",
        elryanLabel: "ingco",
      },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.mapping.elryanId, "10104");
    assert.equal(saved.json.mapping.elryanLabel, "ingco");
  });

  it("blocks save when verification fails (id/name mismatch)", async () => {
    const denied = await call("PUT", "/api/admin/platforms/elryan/value-mappings", {
      body: {
        kind: "brand",
        brownKey: "INGCO",
        brownLabel: "INGCO",
        elryanId: "10104",
        elryanLabel: "Tosot",
      },
    });
    assert.equal(denied.status, 400);
    assert.equal(denied.json.code, "name_id_mismatch");
    assert.equal(await ElryanValueMapping.countDocuments({ kind: "brand" }), 0);
  });

  it("keeps staging/production catalog caches isolated", async () => {
    await call("GET", "/api/admin/platforms/elryan/attribute-values/Brand?search=ingco");
    assert.ok(peekElryanAttributeValueListCacheForTests("staging", "Brand"));
    assert.equal(peekElryanAttributeValueListCacheForTests("production", "Brand"), null);

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
    __resetElryanAttributeValueCatalogCacheForTests();
    // production fetch still mocked to Brand/list
    await call("GET", "/api/admin/platforms/elryan/attribute-values/Brand?search=ingco");
    assert.ok(peekElryanAttributeValueListCacheForTests("production", "Brand"));
    assert.equal(peekElryanAttributeValueListCacheForTests("staging", "Brand"), null);
  });

  it("keeps product write gates disabled", () => {
    assert.equal(elryanProductWritesEnabled(), false);
  });
});
