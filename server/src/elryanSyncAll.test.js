import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { fileURLToPath } from "node:url";
import { adminRouter } from "./routes/admin.js";
import { Commission } from "./models/Commission.js";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanConnection } from "./models/ElryanConnection.js";
import { ElryanSyncJob } from "./models/ElryanSyncJob.js";
import { ElryanSyncProductResult } from "./models/ElryanSyncProductResult.js";
import { ElryanValueMapping } from "./models/ElryanValueMapping.js";
import { Partner } from "./models/Partner.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import { setElryanFetch } from "./services/elryanClient.js";
import {
  getElryanSyncAllStatus,
  pauseElryanSyncAll,
  resetElryanSyncRuntimeForTests,
  resumeElryanSyncAll,
  runElryanSyncPreview,
  setElryanSyncBatchSizeForTests,
  setElryanSyncTestHook,
  startElryanSyncAll,
  stopElryanSyncAll,
} from "./services/elryanSyncAll.js";
import { buildElryanProductPayload } from "./utils/elryanPayloadBuilder.js";
import { ELRYAN_READINESS } from "./utils/elryanConstants.js";
import { validateElryanPreviewParts } from "./utils/elryanValidator.js";
import { normalizeElryanWarrantyCatalog, warrantyBlockersFor } from "./utils/elryanWarranty.js";
import { encryptApiKey } from "./utils/partnerAuth.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-sync-all-test-secret";
delete process.env.ELRYAN_PRODUCT_WRITES_ENABLED;
delete process.env.ELRYAN_ALLOW_LIVE_PRODUCT_WRITES;

const API_KEY = "elryan-sync-test-key-123456";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let memory;
let server;
let token;
let releaseGate = () => {};
const calls = [];

function mockResponse(status, body) {
  return {
    status,
    headers: { get() { return "application/json"; } },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function installFetch() {
  calls.length = 0;
  setElryanFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push(`${method} ${target}`);
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`Unexpected Elryan write: ${method} ${target}`);
    }
    if (target.includes("/v1/warranty")) {
      return mockResponse(200, {
        success: true,
        data: [{ id: "w1", warranty_code: "W-STD", warranty_name: "Standard" }],
      });
    }
    if (target.includes("/v1/attribute-sets/category/")) {
      return mockResponse(200, {
        success: true,
        data: {
          id: "as-1",
          attributes: [
            {
              code: "plug_type",
              mandatory: true,
              values: [{ id: "5", name: "Two pin" }],
            },
          ],
        },
      });
    }
    return mockResponse(200, { success: true, data: [] });
  });
}

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/admin", adminRouter);
  return instance;
}

async function call(method, urlPath, body) {
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

async function waitFor(predicate, timeout = 8000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeout) {
    last = await getElryanSyncAllStatus();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const job = last?.job;
  throw new Error(`timed out waiting for preview (${job?.status} ${job?.processed}/${job?.total})`);
}

function productShape(overrides) {
  return {
    name: { en: "Lamp", ar: "مصباح" },
    description: { en: "Desk lamp" },
    price: 10000,
    isActive: true,
    category: { _id: "cat-1", name: { en: "Home" } },
    subCategory: { _id: "sub-1", name: { en: "Lighting" } },
    brand: { _id: "brand-1", name: { en: "Acme" } },
    variants: [
      {
        color: { en: "Black" },
        images: [{ url: "https://cdn.example.com/lamp.jpg", isMain: true }],
        sizes: [{ size: "One", stockQuantity: 4 }],
      },
    ],
    ...overrides,
  };
}

describe("Elryan warranty and pricing contract", () => {
  it("keeps missing warranty mapping and reports WARRANTY_UNVERIFIED when no code exists", () => {
    const catalog = normalizeElryanWarrantyCatalog([], 200);
    assert.equal(catalog.empty, true);
    assert.equal(catalog.checked, true);
    const blockers = warrantyBlockersFor({ code: "", catalog });
    assert.ok(blockers.some((item) => item.code === "missing_warranty_mapping"));
    assert.ok(blockers.some((item) => item.code === "warranty_unverified"));
    const result = validateElryanPreviewParts({
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "SKU-1",
      mapping: { categoryId: "c1" },
      brand: { elryanId: "b1" },
      color: { elryanId: "c1" },
      warranty: null,
      warrantyCatalog: catalog,
      attributes: {},
      requiredAttributeCodes: [],
      variation: { ok: true, reasons: [] },
      pricing: { proposedElryanPrice: 1000 },
      images: ["https://cdn.example.com/a.jpg"],
    });
    assert.equal(result.readiness, ELRYAN_READINESS.MISSING_MAPPING);
    assert.equal(result.readiness === ELRYAN_READINESS.READY, false);
  });

  it("confirms a warranty only when the live list contains that code", () => {
    const catalog = normalizeElryanWarrantyCatalog(
      [{ warranty_code: "W-STD", warranty_name: "Standard", id: "w1" }],
      200
    );
    assert.equal(catalog.items[0].code, "W-STD");
    assert.equal(catalog.items[0].name, "Standard");
    const confirmed = validateElryanPreviewParts({
      hasApiKey: true,
      resolved: { name: { en: "A", ar: "ب" } },
      sku: "SKU-1",
      mapping: { categoryId: "c1" },
      brand: { elryanId: "b1" },
      color: { elryanId: "c1" },
      warranty: { elryanCode: "W-STD" },
      warrantyCatalog: catalog,
      attributes: {},
      requiredAttributeCodes: [],
      variation: { ok: true, reasons: [] },
      pricing: { proposedElryanPrice: 1000, pricingNote: "unverified" },
      images: ["https://cdn.example.com/a.jpg"],
    });
    assert.equal(confirmed.readiness, ELRYAN_READINESS.READY);
    assert.equal(confirmed.ready, true);
    assert.equal(confirmed.blockers.some((item) => item.code === "warranty_unverified"), false);
    const unknown = warrantyBlockersFor({ code: "MADE-UP", catalog });
    assert.equal(unknown.some((item) => item.code === "missing_warranty_mapping"), false);
    assert.equal(unknown.some((item) => item.code === "warranty_unverified"), true);
  });

  it("uses fileUrl and omits cost", () => {
    const payload = buildElryanProductPayload({
      resolved: {
        name: { en: "Lamp" },
        variants: [{ images: [{ url: "https://cdn.example.com/a.jpg" }] }],
      },
      sku: "LAMP-1",
      mapping: { categoryId: "c1" },
      pricing: { proposedElryanPrice: 1250 },
      quantity: 2,
    });
    assert.deepEqual(payload.images, [{ fileUrl: "https://cdn.example.com/a.jpg" }]);
    assert.equal(payload.price, 1250);
    assert.equal("cost" in payload, false);
    assert.equal(payload.warrantyCode, undefined);
  });

  it("does not call product writes from the sync-all service", () => {
    const source = fs.readFileSync(path.join(__dirname, "services/elryanSyncAll.js"), "utf8");
    assert.equal(/miswag|gini/i.test(source), false);
    assert.equal(source.includes("batchCreate"), false);
    assert.equal(source.includes('method: "POST"'), false);
    assert.equal(source.includes("ElryanConfirmedSend.create"), false);
    assert.equal(/Product\.(update|findOneAndUpdate|create|delete)/.test(source), false);
  });
});

describe("Elryan Sync All preview", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-sync-all"));
    const user = await User.create({
      email: "elryan-sync@brownstore.test",
      passwordHash: "x",
      role: "admin",
      name: "Elryan Sync",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "elryan", name: "Elryan", isActive: true });
    server = await new Promise((resolve) => {
      const running = app().listen(0, "127.0.0.1", () => resolve(running));
    });
  });

  after(async () => {
    releaseGate();
    resetElryanSyncRuntimeForTests();
    setElryanFetch(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    releaseGate();
    releaseGate = () => {};
    resetElryanSyncRuntimeForTests();
    installFetch();
    await Promise.all([
      ElryanSyncJob.deleteMany({}),
      ElryanSyncProductResult.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
      ElryanValueMapping.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "elryan" }),
      PlatformVisibilityRule.deleteMany({ partner: "elryan" }),
      Product.deleteMany({}),
      Commission.deleteMany({}),
      ElryanConnection.deleteMany({}),
    ]);
    await ElryanConnection.create({
      singletonKey: "default",
      environment: "staging",
      stagingApiKeyEnc: encryptApiKey(API_KEY),
    });
    await ElryanValueMapping.create([
      { kind: "brand", brownKey: "brand-1", elryanId: "elr-brand-1", elryanLabel: "Acme" },
      { kind: "color", brownKey: "black", elryanId: "elr-color-1", elryanLabel: "Black" },
      {
        kind: "warranty",
        brownKey: "staging:brand:brand-1",
        environment: "staging",
        warrantyScope: "brand",
        elryanCode: "W-STD",
        elryanLabel: "Standard",
      },
    ]);
    await PlatformTaxonomyConfig.create([
      {
        partner: "elryan",
        brownCollectionId: "col-1",
        values: { categoryId: "elr-cat-9", categoryName: "Lamps", attributes: { plug_type: "5" } },
      },
      {
        partner: "elryan",
        brownCollectionId: "col-2",
        values: { categoryId: "elr-cat-9", categoryName: "Lamps" },
      },
    ]);
    const ready = await Product.create(productShape({
      ibsherId: "ibs-ready",
      itemCode: "EL-READY-1",
      collectionName: { _id: "col-1", name: { en: "Lamps" } },
    }));
    await Product.create(productShape({
      ibsherId: "ibs-brand",
      itemCode: "EL-BRAND-1",
      collectionName: { _id: "col-1", name: { en: "Lamps" } },
      brand: { _id: "brand-missing", name: { en: "Other" } },
    }));
    await Product.create(productShape({
      ibsherId: "ibs-attr",
      itemCode: "EL-ATTR-1",
      collectionName: { _id: "col-2", name: { en: "Bare" } },
    }));
    const hidden = await Product.create(productShape({
      ibsherId: "ibs-hidden",
      itemCode: "EL-HIDDEN-1",
      collectionName: { _id: "col-1", name: { en: "Lamps" } },
    }));
    await PlatformVisibilityRule.create({
      partner: "elryan",
      scope: "product",
      targetId: String(hidden._id),
      isActive: false,
    });
    void ready;
  });

  afterEach(async () => {
    releaseGate();
    releaseGate = () => {};
    resetElryanSyncRuntimeForTests();
    setElryanFetch(null);
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

  it("previews staging products without sending and does not send a resolved price", async () => {
    const started = await runElryanSyncPreview({ strategy: "full" });
    assert.equal(started.dryRun, true);
    assert.equal(started.sentToElryan, 0);
    assert.equal(started.environment, "staging");
    const done = await waitFor((status) => status.job?.status === "preview" && status.job?.finishedAt);
    const job = done.job;
    assert.equal(job.scanned, 4);
    assert.equal(job.ready, 1);
    assert.equal(job.newCount, 1);
    assert.equal(job.changedCount, 0);
    assert.equal(job.unchangedCount, 0);
    assert.equal(job.missingBrand, 1);
    assert.equal(job.missingRequired, 1);
    assert.equal(job.inactive, 1);
    assert.equal(job.skipped, 2);
    assert.equal(job.failed, 0);
    assert.equal(job.sentToElryan, 0);
    assert.equal(job.pricingUnverified, 0);
    assert.equal(job.pricingSummary.status, "BROWNSTORE_RULES");
    assert.equal(job.warrantySummary.status, "LIST_LOADED");
    assert.equal(job.warrantySummary.catalogCount, 1);
    assert.equal(job.warrantySummary.items[0].name, "Standard");
    assert.equal(calls.some((line) => line.startsWith("POST") || line.startsWith("PATCH") || line.startsWith("PUT")), false);

    const complete = await ElryanSyncProductResult.findOne({ sku: "EL-READY-1" }).lean();
    assert.equal(complete.status, "READY");
    assert.equal(complete.readiness, ELRYAN_READINESS.READY);
    assert.equal(complete.blockerCodes.includes("pricing_unverified"), false);
    assert.equal(await ElryanSyncProductResult.countDocuments({ status: "READY" }), 1);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);

    await runElryanSyncPreview({ strategy: "changed" });
    const changed = await waitFor((status) => status.job?.strategy === "changed" && status.job?.status === "preview");
    assert.equal(changed.job.ready, 1);
    assert.equal(changed.job.newCount, 1);
    assert.equal(changed.job.changedCount, 0);
    assert.equal(changed.job.unchangedCount, 0);
    assert.equal(changed.job.sentToElryan, 0);
    assert.equal(await ElryanSyncProductResult.countDocuments({ status: "READY" }), 2);
  });

  it("pauses, resumes, stops, and rejects an overlapping preview", async () => {
    setElryanSyncBatchSizeForTests(1);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    releaseGate = () => release();
    let opened = false;
    const openedPromise = new Promise((resolve) => {
      setElryanSyncTestHook(async () => {
        if (!opened) {
          opened = true;
          resolve();
          await gate;
        }
      });
    });
    await runElryanSyncPreview({ strategy: "full" });
    await openedPromise;
    await assert.rejects(runElryanSyncPreview({ strategy: "changed" }), (error) => {
      assert.equal(error.code, "sync_active");
      assert.equal(error.status, 409);
      return true;
    });
    const paused = await pauseElryanSyncAll();
    assert.equal(paused.job.status, "paused");
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const whilePaused = await getElryanSyncAllStatus();
    assert.equal(whilePaused.job.status, "paused");
    assert.equal(whilePaused.job.processed, 0);
    await resumeElryanSyncAll();
    const finished = await waitFor((status) => status.job?.status === "preview" && status.job?.processed === 4);
    assert.equal(finished.job.scanned, 4);

    let secondRelease;
    const secondGate = new Promise((resolve) => {
      secondRelease = resolve;
    });
    releaseGate = () => secondRelease();
    let secondOpened = false;
    const secondOpenedPromise = new Promise((resolve) => {
      setElryanSyncTestHook(async () => {
        if (!secondOpened) {
          secondOpened = true;
          resolve();
          await secondGate;
        }
      });
    });
    await runElryanSyncPreview({ strategy: "full" });
    await secondOpenedPromise;
    const stopped = await stopElryanSyncAll();
    assert.equal(stopped.job.status, "stopped");
    secondRelease();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterStop = await getElryanSyncAllStatus();
    assert.equal(afterStop.job.status, "stopped");
    assert.equal(afterStop.job.sentToElryan, 0);
  });

  it("keeps staging and production preview jobs isolated", async () => {
    await runElryanSyncPreview({ strategy: "full" });
    const staging = await waitFor((status) => status.job?.status === "preview" && status.job?.finishedAt);
    assert.equal(staging.job.environment, "staging");
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "production" } });
    await runElryanSyncPreview({ strategy: "full" });
    const production = await waitFor((status) => status.environment === "production" && status.job?.status === "preview");
    assert.equal(production.job.environment, "production");
    assert.equal(production.job.ready, 0);
    assert.ok(production.job.missingCategory >= 1);
    await ElryanConnection.updateOne({ singletonKey: "default" }, { $set: { environment: "staging" } });
    const back = await getElryanSyncAllStatus();
    assert.equal(back.environment, "staging");
    assert.equal(back.job.environment, "staging");
    assert.equal(staging.job.ready, 1);
    assert.equal(back.job.ready, 1);
    const stored = await ElryanSyncJob.find({}).select("environment ready").lean();
    assert.deepEqual(stored.map((row) => row.environment).sort(), ["production", "staging"]);
  });

  it("refuses start sync over HTTP and does not write products", async () => {
    const before = await Product.countDocuments({});
    const started = await startElryanSyncAll();
    assert.equal(started.ok, false);
    assert.equal(started.code, "writes_disabled");
    assert.equal(started.sentToElryan, 0);
    const http = await call("POST", "/api/admin/platforms/elryan/sync-all/start", { confirm: true, strategy: "full" });
    assert.equal(http.status, 403);
    assert.equal(http.json.code, "writes_disabled");
    assert.equal(http.json.sentToElryan, 0);
    assert.equal(await Product.countDocuments({}), before);
    assert.equal(calls.some((line) => !line.startsWith("GET")), false);
  });
});
