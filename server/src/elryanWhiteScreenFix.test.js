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
import { ElryanCategoryCatalogSnapshot } from "./models/ElryanCategoryCatalogSnapshot.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import {
  elryanCatalogStatusSummary,
  normalizeElryanCatalogWarnings,
} from "../../client/src/utils/elryanCatalogStatusUi.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-white-screen-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;

const API_KEY = "elryan-ws-test-key-not-for-browser-55";

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

async function call(method, urlPath) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, raw: JSON.stringify(json) };
}

describe("Elryan white-screen regressions", () => {
  it("normalizes warnings so React never receives objects as children", () => {
    const warnings = normalizeElryanCatalogWarnings([
      "ok",
      { code: "X", message: "bad" },
      null,
      12,
    ]);
    assert.deepEqual(warnings[0], "ok");
    assert.match(warnings[1], /bad/);
    assert.equal(warnings.includes(""), false);
    assert.ok(warnings.every((w) => typeof w === "string"));
  });

  it("builds a compact status summary without needing categories[]", () => {
    const summary = elryanCatalogStatusSummary({
      status: "complete",
      uniqueCount: 1393,
      reportedTotal: 1393,
      coverage: "complete",
      pagesFetched: 28,
    });
    assert.equal(summary.ready, true);
    assert.match(summary.line, /1393/);
    assert.match(summary.line, /complete/);
  });
});

describe("Elryan catalog status excludes categories payload", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-white-screen"));
    const user = await User.create({
      email: "elryan-ws@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "WS",
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
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
      hasApiKey: true,
      lastAuthOk: true,
      lastStatus: "authenticated",
    });
  });

  it("status endpoint stays small with 1393 categories stored (no categories[] in JSON)", async () => {
    const categories = Array.from({ length: 1393 }, (_, i) => ({
      id: i + 1,
      name: `Category ${i + 1}`,
      hierarchy: `Root : Category ${i + 1}`,
      isParent: false,
      level: 2,
    }));
    await ElryanCategoryCatalogSnapshot.create({
      environment: "staging",
      status: "complete",
      coverage: "complete",
      uniqueCount: 1393,
      reportedTotal: 1393,
      pagesFetched: 28,
      categories,
      warnings: ["note"],
    });

    const res = await call("GET", "/api/admin/platforms/elryan/category-catalog/status");
    assert.equal(res.status, 200);
    assert.equal(res.json.status, "complete");
    assert.equal(res.json.uniqueCount, 1393);
    assert.equal(res.json.categoryCount, 1393);
    assert.equal(Object.prototype.hasOwnProperty.call(res.json, "categories"), false);
    assert.ok(res.raw.length < 5000, `status payload unexpectedly large: ${res.raw.length}`);

    // Snapshot rows remain intact after status reads.
    const snap = await ElryanCategoryCatalogSnapshot.findOne({ environment: "staging" }).lean();
    assert.equal(snap.categories.length, 1393);
    assert.equal(snap.uniqueCount, 1393);
  });
});
