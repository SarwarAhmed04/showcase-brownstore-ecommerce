import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GiniSkuCreateAttempt } from "./models/GiniSkuCreateAttempt.js";
import { GiniSkuCreatePreview } from "./models/GiniSkuCreatePreview.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH } from "./utils/giniSigner.js";
import { GINI_DEFAULT_BASE_URL, setGiniFetch } from "./services/giniConnection.js";
import { setGiniMediaFetch } from "./services/giniSyncOne.js";
import {
  assessGiniMerchantIdentity,
  existingGiniWriteGatesEnabled,
  giniSkuCreateAttemptIndexesEnforced,
  giniSkuCreateWritesEnabled,
} from "./services/giniSkuCreate.js";
import { classifyGiniBulk } from "./utils/giniSyncEvaluate.js";
import { GINI_HISTORICAL_HOLD_SKUS, GINI_REFERENCE_SKUS, isGiniHistoricalHoldSku } from "./utils/giniHistoricalHold.js";
import { giniSkuCreateAttemptIndexesMatch } from "./utils/giniSkuCreateIndexes.js";
import { giniSyncOneWritesEnabled } from "./utils/giniSkuCreateGates.js";
import { canConfirmGiniSkuCreate } from "../../client/src/components/admin/platform/giniSkuCreateDisplay.js";
import { GINI_PRODUCTS_PATH } from "./utils/giniSyncOnePlan.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "gini-sku-create-test-secret";

const SECRET = "sku-create-secret-not-for-output";
const CLIENT_ID = "1423abcd2bee";
const CANDIDATE_ID = "6aae476f023c0be610d48024";
const CANDIDATE_SKU = "ZJP00.000BK";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const LIVE_TREE = {
  data: [{ id: 1, name: "Home", slug: "home", is_active: 1, subcategories: [{ id: 10, name: "Blenders", slug: "blenders", is_active: 1 }] }],
};

let memory;
let server;
let token;
let calls;
let allowPost;
let remoteMode;
let liveProduct;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use("/api/admin", adminRouter);
  return instance;
}

function listen(instance) {
  return new Promise((resolve) => {
    const running = instance.listen(0, "127.0.0.1", () => resolve(running));
  });
}

function mockResponse(status, body, extraHeaders = {}) {
  const headers = { "content-type": "application/json", ...extraHeaders };
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return JSON.stringify(body);
    },
  };
}

function postedSku(options) {
  if (!options?.body?.entries) return "";
  for (const [key, value] of options.body.entries()) {
    if (key === "sku" && typeof value === "string") return value;
  }
  return "";
}

function installFetch() {
  calls = [];
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push({ method, url: target, options });
    if (!["GET", "POST"].includes(method)) throw new Error(`unexpected ${method}`);
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return mockResponse(200, LIVE_TREE);
    if (method === "POST" && target.split("?")[0].endsWith(GINI_PRODUCTS_PATH)) {
      if (!allowPost) throw new Error(`GINI write attempted: ${target}`);
      if (remoteMode === "lost") throw new Error("connection lost before a GINI response");
      const sku = postedSku(options);
      liveProduct = { id: "9001", sku };
      return mockResponse(201, { data: { id: "9001", sku } });
    }
    if (method === "GET" && target.includes("/products/")) {
      if (remoteMode === "rate") return mockResponse(429, { message: "slow" }, { "retry-after": "2" });
      if (remoteMode === "server") return mockResponse(503, { message: "down" });
      if (remoteMode === "auth") return mockResponse(401, { message: "unauthorized" });
      if (liveProduct && remoteMode === "mismatch") return mockResponse(200, { data: { id: "7777", sku: liveProduct.sku } });
      if (liveProduct && remoteMode !== "unconfirmed" && remoteMode !== "lost") {
        return mockResponse(200, { data: { id: liveProduct.id, sku: liveProduct.sku } });
      }
      return mockResponse(404, { message: "Product not found." });
    }
    if (method === "GET" && target.includes("/products?")) {
      if (remoteMode === "incomplete") return mockResponse(200, { data: [], meta: {} });
      if (remoteMode === "duplicate") {
        return mockResponse(200, {
          data: [
            { id: "1", sku: CANDIDATE_SKU },
            { id: "2", sku: CANDIDATE_SKU },
          ],
          meta: { last_page: 1 },
        });
      }
      if (remoteMode === "exists") {
        return mockResponse(200, { data: [{ id: "55", sku: CANDIDATE_SKU }], meta: { last_page: 1 } });
      }
      return mockResponse(200, { data: [], meta: { last_page: 1 } });
    }
    throw new Error(`unexpected ${target}`);
  });
}

function installMedia() {
  setGiniMediaFetch(async () => ({
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "image/png" : null) },
    async arrayBuffer() {
      return PNG;
    },
  }));
}

async function call(method, urlPath, { body, auth = true } = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json, raw: JSON.stringify(json) };
}

function simpleVariant() {
  return [{ color: { en: "black", ar: "", ku: "" }, images: [{ url: "/uploads/products/patch.webp", isMain: true }], sizes: [{ size: "one", stockQuantity: 5 }] }];
}

async function makeProduct(overrides = {}) {
  return Product.create({
    ...(overrides._id ? { _id: overrides._id } : {}),
    ibsherId: overrides.ibsherId || `ibs-${crypto.randomBytes(4).toString("hex")}`,
    itemCode: overrides.itemCode ?? CANDIDATE_SKU,
    name: { en: "Black Cable", ar: "كابل أسود", ku: "کێبڵ" },
    description: { en: "A black cable.", ar: "كابل أسود قصير", ku: "کێبڵ" },
    price: overrides.price ?? 6500,
    discountPrice: 0,
    brand: { name: "Brown" },
    category: { _id: "cat-beauty", name: { en: "Beauty & Personal Care" } },
    subCategory: { _id: "sub-skin", name: { en: "Skin Care" } },
    collectionName: { _id: "col-acne", name: { en: "Acne Patches" } },
    isActive: true,
    variants: overrides.variants || simpleVariant(),
  });
}

function posts() {
  return calls.filter((item) => item.method === "POST" && item.url.includes(GINI_PRODUCTS_PATH));
}

function enableSkuGates() {
  process.env.GINI_SKU_CREATE_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_SKU_CREATE = "true";
  allowPost = true;
}

function clearGates() {
  delete process.env.GINI_SKU_CREATE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_SKU_CREATE;
  delete process.env.GINI_BULK_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
  delete process.env.GINI_UPDATE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
  delete process.env.GINI_IMAGE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_IMAGE_WRITES;
  delete process.env.GINI_RESYNC_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_RESYNC_WRITES;
  delete process.env.GINI_SYNC_ONE_WRITES_ENABLED;
  delete process.env.GINI_ALLOW_LIVE_SYNC_ONE_WRITES;
  allowPost = false;
}

async function previewOf(product, sku = product.itemCode) {
  return call("POST", "/api/admin/platforms/gini/sku-create/preview", {
    body: { sku, productId: String(product._id) },
  });
}

async function sendOf(product, previewToken, extra = {}) {
  return call("POST", "/api/admin/platforms/gini/sku-create/send", {
    body: {
      sku: extra.sku || product.itemCode,
      productId: extra.productId || String(product._id),
      confirm: extra.confirm !== undefined ? extra.confirm : true,
      previewToken,
      expectedCount: extra.expectedCount !== undefined ? extra.expectedCount : 1,
      limit: extra.limit,
    },
  });
}

describe("GINI historical hold and SKU-scoped gates", () => {
  it("holds the 59 historical SKUs and HB-632, and does not preauthorize the candidate", () => {
    assert.equal(GINI_REFERENCE_SKUS.length, 59);
    assert.equal(new Set(GINI_HISTORICAL_HOLD_SKUS).size, 60);
    assert.equal(isGiniHistoricalHoldSku("HA0449"), true);
    assert.equal(isGiniHistoricalHoldSku("hb-632"), true);
    assert.equal(isGiniHistoricalHoldSku(CANDIDATE_SKU), false);
    const absent = { blockers: [], lookupState: "absent" };
    const held = classifyGiniBulk({ plan: { ...absent, sku: "HB-632" }, isActive: true });
    assert.equal(held.classification, "BLOCKED");
    assert.equal(held.blockers.includes("historical_sku_hold"), true);
    const candidate = classifyGiniBulk({ plan: { ...absent, sku: CANDIDATE_SKU }, isActive: true });
    assert.equal(candidate.classification, "READY_CREATE");
    const source = fs.readFileSync(new URL("./services/giniSkuCreate.js", import.meta.url), "utf8");
    assert.equal(source.includes(CANDIDATE_ID), false);
    assert.equal(source.includes(CANDIDATE_SKU), false);
    assert.equal(source.includes('method: "PUT"'), false);
    assert.equal(source.includes('method: "PATCH"'), false);
    assert.equal(source.includes('method: "DELETE"'), false);
  });

  it("requires both new gates exactly true and keeps the existing eight independent", () => {
    assert.equal(giniSkuCreateWritesEnabled({}), false);
    assert.equal(giniSkuCreateWritesEnabled({ GINI_SKU_CREATE_WRITES_ENABLED: "TRUE", GINI_ALLOW_LIVE_SKU_CREATE: "true" }), false);
    assert.equal(
      giniSkuCreateWritesEnabled({ GINI_BULK_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_BULK_WRITES: "true" }),
      false
    );
    assert.equal(
      giniSkuCreateWritesEnabled({ GINI_SKU_CREATE_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_SKU_CREATE: "true" }),
      true
    );
    assert.equal(existingGiniWriteGatesEnabled({ GINI_SKU_CREATE_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_SKU_CREATE: "true" }), false);
    assert.equal(giniSyncOneWritesEnabled({}), false);
    assert.equal(giniSyncOneWritesEnabled({ GINI_SKU_CREATE_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_SKU_CREATE: "true" }), false);
    assert.equal(giniSkuCreateWritesEnabled({ GINI_SYNC_ONE_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_SYNC_ONE_WRITES: "true" }), false);
    assert.equal(giniSyncOneWritesEnabled({ GINI_SYNC_ONE_WRITES_ENABLED: "TRUE", GINI_ALLOW_LIVE_SYNC_ONE_WRITES: "true" }), false);
    assert.equal(giniSyncOneWritesEnabled({ GINI_SYNC_ONE_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_SYNC_ONE_WRITES: "true" }), true);
    assert.equal(
      giniSkuCreateAttemptIndexesMatch([
        { key: { skuKey: 1 }, unique: true, name: "skuKey_1" },
        { key: { productId: 1 }, unique: true, name: "productId_1" },
      ]),
      true
    );
    assert.equal(
      giniSkuCreateAttemptIndexesMatch([
        { key: { skuKey: 1 }, unique: true, sparse: true, name: "skuKey_1" },
        { key: { productId: 1 }, unique: true, name: "productId_1" },
      ]),
      false
    );
    const syncOne = fs.readFileSync(new URL("./services/giniSyncOne.js", import.meta.url), "utf8");
    assert.equal(syncOne.includes("giniSkuCreateWritesEnabled"), false);
    assert.equal(syncOne.includes("giniSyncOneWritesEnabled"), true);
    assert.equal(syncOne.includes("isGiniHistoricalHoldSku"), true);
    const merchant = assessGiniMerchantIdentity({
      baseUrl: "https://merchant.gini.iq",
      clientId: CLIENT_ID,
      hasSecret: true,
    });
    assert.equal(merchant.matches, true);
    assert.equal(merchant.clientMask, "1423...2bee");
    assert.equal("clientId" in merchant, false);
    assert.equal(assessGiniMerchantIdentity({ baseUrl: "https://app.gini.iq", clientId: CLIENT_ID, hasSecret: true }).matches, false);
    assert.equal(assessGiniMerchantIdentity({ baseUrl: "https://merchant.gini.iq", clientId: "other-client", hasSecret: true }).matches, false);
    const readyPreview = {
      sku: "ZJP00.000BK",
      productId: "6aae476f023c0be610d48024",
      canCreate: true,
      previewToken: "token",
      productCount: 1,
      writesEnabled: true,
    };
    assert.equal(canConfirmGiniSkuCreate({ preview: null, sku: "", productId: "", confirmed: true, busy: false }), false);
    assert.equal(canConfirmGiniSkuCreate({ preview: readyPreview, sku: "", productId: "", confirmed: false, busy: false }), false);
    assert.equal(canConfirmGiniSkuCreate({ preview: { ...readyPreview, writesEnabled: false }, sku: readyPreview.sku, productId: readyPreview.productId, confirmed: true, busy: false }), false);
    assert.equal(canConfirmGiniSkuCreate({ preview: readyPreview, sku: readyPreview.sku, productId: readyPreview.productId, confirmed: true, busy: false }), true);
    const panel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniSkuCreatePanel.jsx", import.meta.url), "utf8");
    assert.equal(panel.includes("ZJP00.000BK"), false);
    assert.equal(panel.includes("6aae476f023c0be610d48024"), false);
    assert.equal(panel.includes('useState("ZJP'), false);
    assert.equal(/GINI_SKU_CREATE_WRITES_ENABLED\s*=\s*["']true["']/.test(panel), false);
  });
});

describe("GINI SKU-scoped create", { concurrency: 1 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-sku-create"));
    const user = await User.create({ email: "sku-create@brownstore.test", passwordHash: "hash", role: "admin" });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    await PlatformTaxonomyConfig.create({
      partner: "gini",
      brownCollectionId: "col-acne",
      values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" },
    });
    await GiniSkuCreateAttempt.init();
    assert.equal(await giniSkuCreateAttemptIndexesEnforced(), true);
    server = await listen(app());
    installFetch();
    installMedia();
    await call("PUT", "/api/admin/platforms/gini/connection", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    const tested = await call("POST", "/api/admin/platforms/gini/connection/test", {
      body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
    });
    assert.equal(tested.json.status, "connected");
  });

  after(async () => {
    clearGates();
    setGiniFetch(null);
    setGiniMediaFetch(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    clearGates();
    remoteMode = "missing";
    liveProduct = null;
    calls = [];
    installFetch();
    await Promise.all([
      Product.deleteMany({}),
      Commission.deleteMany({}),
      GiniSkuCreatePreview.deleteMany({}),
      GiniSkuCreateAttempt.deleteMany({}),
      GiniSyncSendState.deleteMany({}),
    ]);
  });

  it("requires an admin and does not create from the preview", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const hidden = await call("POST", "/api/admin/platforms/gini/sku-create/preview", {
      auth: false,
      body: { sku: CANDIDATE_SKU, productId: CANDIDATE_ID },
    });
    assert.equal(hidden.status, 401);
    const preview = await previewOf(product);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.readOnly, true);
    assert.equal(preview.json.canCreate, true);
    assert.equal(preview.json.productCount, 1);
    assert.equal(preview.json.sku, CANDIDATE_SKU);
    assert.equal(preview.json.productId, CANDIDATE_ID);
    assert.equal(preview.json.remote.code, "verified_missing");
    assert.equal(preview.json.writesEnabled, false);
    assert.equal(preview.json.sentToGini, 0);
    assert.equal(calls.every((item) => item.method === "GET"), true);
    assert.equal(preview.raw.includes(SECRET), false);
    assert.equal(preview.raw.includes(CLIENT_ID), false);
    assert.equal(await GiniSyncSendState.countDocuments({}), 0);
  });

  it("blocks a historical SKU and HB-632 even when the remote search is empty", async () => {
    const historical = await makeProduct({ itemCode: "HA0449" });
    const syncOne = await makeProduct({ itemCode: "HB-632" });
    const first = await previewOf(historical);
    const second = await previewOf(syncOne);
    assert.equal(first.json.code, "historical_sku_hold");
    assert.equal(first.json.canCreate, false);
    assert.equal(first.json.previewToken, "");
    assert.equal(second.json.code, "historical_sku_hold");
    enableSkuGates();
    const sent = await sendOf(historical, "missing-token");
    assert.equal(sent.status, 409);
    assert.equal(sent.json.code, "historical_sku_hold");
    assert.equal(posts().length, 0);
  });

  it("rejects a different SKU, product id, merchant, or incomplete remote read", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const other = await makeProduct({ itemCode: "OTHER-SKU" });
    const conflict = await previewOf(product, "OTHER-SKU");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.code, "sku_identity_conflict");
    const wrongCase = await previewOf(product, "zjp00.000bk");
    assert.equal(wrongCase.json.code, "sku_identity_conflict");
    const wrongId = await call("POST", "/api/admin/platforms/gini/sku-create/preview", {
      body: { sku: CANDIDATE_SKU, productId: String(other._id) },
    });
    assert.equal(wrongId.json.code, "sku_identity_conflict");

    remoteMode = "incomplete";
    const unfinished = await previewOf(product);
    assert.equal(unfinished.json.canCreate, false);
    assert.equal(unfinished.json.code, "search_pagination_incomplete");
    remoteMode = "rate";
    assert.equal((await previewOf(product)).json.code, "rate_limited");
    remoteMode = "server";
    assert.equal((await previewOf(product)).json.code, "gini_lookup_failed");
    remoteMode = "duplicate";
    assert.equal((await previewOf(product)).json.code, "duplicate_remote_sku");
    remoteMode = "exists";
    assert.equal((await previewOf(product)).json.code, "existing_gini_product");
    remoteMode = "auth";
    assert.equal((await previewOf(product)).json.code, "gini_access_forbidden");
    assert.equal(posts().length, 0);

    remoteMode = "missing";
    calls = [];
    const preview = await previewOf(product);
    assert.equal(preview.json.canCreate, true);
    remoteMode = "incomplete";
    enableSkuGates();
    const sent = await sendOf(product, preview.json.previewToken);
    assert.equal(sent.status, 409);
    assert.equal(sent.json.code, "search_pagination_incomplete");
    assert.equal(posts().length, 0);
  });

  it("keeps the SKU gates independent and refuses a stale preview or a count other than one", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const preview = await previewOf(product);
    const blocked = await sendOf(product, preview.json.previewToken);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.code, "sku_create_writes_disabled");
    process.env.GINI_SKU_CREATE_WRITES_ENABLED = "TRUE";
    process.env.GINI_ALLOW_LIVE_SKU_CREATE = "true";
    allowPost = true;
    assert.equal((await sendOf(product, preview.json.previewToken)).json.code, "sku_create_writes_disabled");
    enableSkuGates();
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    assert.equal((await sendOf(product, preview.json.previewToken)).json.code, "existing_write_gates_must_stay_off");
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    assert.equal((await sendOf(product, preview.json.previewToken, { confirm: false })).status, 400);
    assert.equal((await sendOf(product, preview.json.previewToken, { expectedCount: 2 })).json.code, "expected_count_required");
    await Product.updateOne({ _id: product._id }, { $set: { price: 9000 } });
    const stale = await sendOf(product, preview.json.previewToken);
    assert.equal(stale.json.code, "stale_preview");
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncSendState.countDocuments({}), 0);
  });

  it("creates only the confirmed SKU after a matching live GET and does not retry a lost response", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const preview = await previewOf(product);
    enableSkuGates();
    remoteMode = "lost";
    const lost = await sendOf(product, preview.json.previewToken, { limit: 25 });
    assert.equal(lost.status, 409);
    assert.equal(lost.json.code, "sku_create_uncertain");
    assert.equal(posts().length, 1);
    assert.equal(await GiniSyncSendState.countDocuments({}), 0);
    assert.equal((await GiniSkuCreateAttempt.findOne({ sku: CANDIDATE_SKU }).lean()).status, "uncertain");
    remoteMode = "missing";
    clearGates();
    const freshAfterLoss = await previewOf(product);
    enableSkuGates();
    const retried = await sendOf(product, freshAfterLoss.json.previewToken);
    assert.equal(retried.status, 409);
    assert.equal(retried.json.code, "sku_create_uncertain");
    assert.equal(posts().length, 1);

    await GiniSkuCreateAttempt.deleteMany({});
    await GiniSkuCreatePreview.deleteMany({});
    calls = [];
    liveProduct = null;
    remoteMode = "missing";
    allowPost = false;
    const again = await previewOf(product);
    remoteMode = "mismatch";
    enableSkuGates();
    const mismatched = await sendOf(product, again.json.previewToken);
    assert.equal(mismatched.json.code, "sku_create_uncertain");
    assert.equal(await GiniSyncSendState.countDocuments({}), 0);
    assert.equal(posts().length, 1);

    await GiniSkuCreateAttempt.deleteMany({});
    await GiniSkuCreatePreview.deleteMany({});
    calls = [];
    liveProduct = null;
    remoteMode = "missing";
    clearGates();
    const ready = await previewOf(product);
    remoteMode = "missing";
    enableSkuGates();
    const created = await sendOf(product, ready.json.previewToken, { limit: 25 });
    assert.equal(created.status, 200);
    assert.equal(created.json.ok, true);
    assert.equal(created.json.productCount, 1);
    assert.equal(created.json.sku, CANDIDATE_SKU);
    assert.equal(created.json.productId, CANDIDATE_ID);
    assert.equal(created.json.giniProductId, "9001");
    assert.equal(created.json.sentToGini, 1);
    assert.equal(posts().length, 1);
    assert.equal(postedSku(posts()[0].options), CANDIDATE_SKU);
    const saved = await GiniSyncSendState.findOne({ sku: CANDIDATE_SKU }).lean();
    assert.equal(saved.giniProductId, "9001");
    assert.equal(saved.productId, CANDIDATE_ID);
    assert.equal((await GiniSkuCreateAttempt.findOne({ sku: CANDIDATE_SKU }).lean()).status, "confirmed");
    assert.equal(created.raw.includes(SECRET), false);
    assert.equal(created.raw.includes(CLIENT_ID), false);
    const duplicate = await sendOf(product, ready.json.previewToken);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.code, "existing_gini_product");
    assert.equal(posts().length, 1);
    assert.equal(await GiniSyncSendState.countDocuments({}), 1);
  });

  it("allows only one of two concurrent sends to post", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const preview = await previewOf(product);
    enableSkuGates();
    const [first, second] = await Promise.all([
      sendOf(product, preview.json.previewToken),
      sendOf(product, preview.json.previewToken),
    ]);
    const outcomes = [first, second];
    assert.equal(outcomes.filter((item) => item.json.ok === true).length, 1);
    assert.equal(posts().length, 1);
    assert.equal(await GiniSyncSendState.countDocuments({ sku: CANDIDATE_SKU }), 1);
    assert.equal(outcomes.some((item) => item.raw.includes(SECRET)), false);
  });

  it("enforces one POST when two different preview tokens target the same SKU", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const firstPreview = await previewOf(product);
    const secondPreview = await previewOf(product);
    assert.equal(firstPreview.json.canCreate, true);
    assert.equal(secondPreview.json.canCreate, true);
    assert.notEqual(firstPreview.json.previewToken, secondPreview.json.previewToken);
    enableSkuGates();
    calls = [];
    const [first, second] = await Promise.all([
      sendOf(product, firstPreview.json.previewToken),
      sendOf(product, secondPreview.json.previewToken),
    ]);
    assert.equal([first, second].filter((item) => item.json.ok === true).length, 1);
    assert.equal(posts().length, 1);
    assert.equal(postedSku(posts()[0].options), CANDIDATE_SKU);
    assert.equal(await GiniSyncSendState.countDocuments({ sku: CANDIDATE_SKU }), 1);
    const blocked = [first, second].find((item) => item.json.ok !== true);
    assert.equal(blocked.status, 409);
    assert.equal(["sku_create_in_progress", "existing_gini_product", "confirmed_send_exists"].includes(blocked.json.code), true);
  });

  it("refuses an expired preview and a send when the lock indexes are missing", async () => {
    const product = await makeProduct({ _id: CANDIDATE_ID });
    const preview = await previewOf(product);
    await GiniSkuCreatePreview.updateOne({ token: preview.json.previewToken }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    enableSkuGates();
    const expired = await sendOf(product, preview.json.previewToken);
    assert.equal(expired.status, 409);
    assert.equal(expired.json.code, "preview_expired");
    assert.equal(posts().length, 0);

    const fresh = await previewOf(product);
    const indexes = await GiniSkuCreateAttempt.collection.indexes();
    const names = indexes
      .filter((index) => index.unique === true && ["skuKey", "productId"].includes(Object.keys(index.key || {})[0]))
      .map((index) => index.name);
    assert.equal(names.length >= 2, true);
    for (const name of names) await GiniSkuCreateAttempt.collection.dropIndex(name);
    assert.equal(await giniSkuCreateAttemptIndexesEnforced(), false);
    calls = [];
    try {
      const missing = await sendOf(product, fresh.json.previewToken);
      assert.equal(missing.status, 409);
      assert.equal(missing.json.code, "sku_create_indexes_unavailable");
      assert.equal(posts().length, 0);
    } finally {
      await GiniSkuCreateAttempt.syncIndexes();
      assert.equal(await giniSkuCreateAttemptIndexesEnforced(), true);
    }
  });

  it("rejects a duplicate lock and an unauthenticated send", async () => {
    await GiniSkuCreateAttempt.create({
      skuKey: "zjp00.000bk",
      productId: CANDIDATE_ID,
      sku: CANDIDATE_SKU,
      status: "in_progress",
    });
    await assert.rejects(
      () =>
        GiniSkuCreateAttempt.create({
          skuKey: "zjp00.000bk",
          productId: "6aae476f023c0be610d48025",
          sku: CANDIDATE_SKU,
          status: "in_progress",
        }),
      (err) => err?.code === 11000
    );
    await assert.rejects(
      () =>
        GiniSkuCreateAttempt.create({
          skuKey: "other-sku",
          productId: CANDIDATE_ID,
          sku: "OTHER-SKU",
          status: "uncertain",
        }),
      (err) => err?.code === 11000
    );
    const hidden = await call("POST", "/api/admin/platforms/gini/sku-create/send", {
      auth: false,
      body: { sku: CANDIDATE_SKU, productId: CANDIDATE_ID, confirm: true, expectedCount: 1, previewToken: "none" },
    });
    assert.equal(hidden.status, 401);
    assert.equal(posts().length, 0);
  });
});
