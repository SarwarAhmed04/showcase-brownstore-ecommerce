import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { translations } from "../../client/src/i18n.js";
import {
  confirmedCreateCount,
  reconciliationWarnings,
  selectGiniSyncDisplay,
} from "../../client/src/components/admin/platform/giniSyncAllDisplay.js";
import { adminRouter } from "./routes/admin.js";
import { User } from "./models/User.js";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { Commission } from "./models/Commission.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { PlatformVisibilityRule } from "./models/PlatformVisibilityRule.js";
import { GiniConnection } from "./models/GiniConnection.js";
import { GiniSyncJob } from "./models/GiniSyncJob.js";
import { GiniSyncProductResult } from "./models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GiniProductUpdateAudit } from "./models/GiniProductUpdateAudit.js";
import { CatalogBlock } from "./models/CatalogBlock.js";
import { GINI_CATEGORIES_PATH, GINI_PING_PATH } from "./utils/giniSigner.js";
import {
  GINI_CATEGORY_GET_ATTEMPTS,
  GINI_DEFAULT_BASE_URL,
  getGiniConnectionPublic,
  giniCategoryRetryDelayMs,
  setGiniCategoryRetryScale,
  setGiniFetch,
} from "./services/giniConnection.js";
import { invalidateCatalogBlockCache } from "./utils/catalogBlocks.js";
import { encryptApiKey } from "./utils/partnerAuth.js";
import { previewGiniSyncOne, setGiniMediaFetch } from "./services/giniSyncOne.js";
import { GINI_PRODUCTS_PATH, giniSkuKey, isAllowedMediaUrl } from "./utils/giniSyncOnePlan.js";
import { classifyConfirmedSend, giniPayloadHash } from "./utils/giniSyncEvaluate.js";
import { classifyOfficialFieldChange, localConfirmedCatalogDecision } from "./utils/giniCatalogSync.js";
import {
  categoryOptions,
  GINI_CATEGORY_PAGE_LIMIT,
  normalizeGiniCategories,
  summarizeGiniMappingCoverage,
} from "./utils/giniCategoryTree.js";
import {
  ensureGiniSyncRunner,
  getLatestGiniSyncJob,
  giniBulkBatchSizes,
  giniBulkRemoteLookups,
  giniBulkSkuIndexScans,
  giniBulkWritesEnabled,
  canonicalGiniSignatureTree,
  catalogSignature,
  pauseGiniSyncAll,
  resetGiniBulkForTests,
  resumeGiniSyncAll,
  runGiniSyncPreview,
  setGiniBulkAfterProduct,
  setGiniBulkBatchSize,
  setGiniBulkBeforeSend,
  startGiniSyncAll,
  stopGiniSyncAll,
  waitForGiniBulkIdle,
} from "./services/giniSyncAll.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "gini-sync-all-test-secret";

const CLIENT_ID = "gini-sync-all-client";
const SECRET = "gini-sync-all-secret-not-for-the-browser";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]);
const LIVE_TREE = {
  data: [
    {
      id: 1,
      name: "Home",
      slug: "home",
      is_active: 1,
      subcategories: [
        { id: 10, name: "Blenders", slug: "blenders", is_active: 1 },
        { id: 11, name: "Retired blades", slug: "retired", is_active: 0 },
      ],
    },
    {
      id: 2,
      name: "Hidden",
      slug: "hidden",
      is_active: 0,
      subcategories: [{ id: 20, name: "Archived", slug: "archived", is_active: 1 }],
    },
  ],
};

let memory;
let server;
let token;
let calls;
let mediaCalls;
let allowPost;
let remote;
let lookupMode;
let uncertainSkus;
let rateBudget;
let postMode;
let recoverOnLose;
let invalidImage;
let hugeImage;
let createdSeq;
let allowPut = false;
let categoryMode = "";
let categoryFailuresLeft = 0;
let categoryReads = 0;

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

function mockResponse(status, body, contentType = "application/json", extraHeaders = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = {
    "content-type": contentType,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([key, value]) => [String(key).toLowerCase(), value])),
  };
  return {
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    async text() {
      return text;
    },
  };
}

function skuFromProductUrl(target) {
  const path = String(target).split("?")[0];
  const marker = "/products/";
  const index = path.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(path.slice(index + marker.length));
}

function formFields(options) {
  const fields = {};
  if (!options?.body?.entries) return fields;
  for (const [key, value] of options.body.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

function headerNames(options) {
  return Object.keys(options?.headers || {}).map((key) => key.toLowerCase());
}

function categoryResponse(target) {
  categoryReads += 1;
  const page = Number(new URL(target).searchParams.get("page") || "1");
  if (categoryMode === "edge") {
    return mockResponse(
      403,
      `<HTML><TITLE>ERROR</TITLE><BODY>Request blocked. ${SECRET} Generated by cloudfront</BODY></HTML>`,
      "text/html",
      { "retry-after": "0" }
    );
  }
  if (categoryMode === "forbidden") return mockResponse(403, { message: `unauthorized ${SECRET}` });
  if (categoryMode === "rate" && categoryFailuresLeft > 0) {
    categoryFailuresLeft -= 1;
    return mockResponse(429, { message: `slow down ${SECRET}` }, "application/json", { "retry-after": "0" });
  }
  if (categoryMode === "server" || (categoryMode === "flaky" && categoryFailuresLeft > 0)) {
    if (categoryMode === "flaky") categoryFailuresLeft -= 1;
    return mockResponse(500, { message: `unavailable ${SECRET}` });
  }
  if (categoryMode === "fail-after-first" && categoryReads > 1) {
    return mockResponse(500, { message: `unavailable ${SECRET}` });
  }
  if (categoryMode === "invalid") return mockResponse(200, { message: `not a tree ${SECRET}` });
  if (categoryMode === "incomplete") {
    return mockResponse(200, {
      data: [
        {
          id: page,
          name: "Page",
          slug: "page",
          is_active: 1,
          subcategories: [{ id: page * 100, name: "Sub", slug: "sub", is_active: 1 }],
        },
      ],
      meta: { last_page: GINI_CATEGORY_PAGE_LIMIT + 1 },
    });
  }
  if (categoryMode === "reordered") return mockResponse(200, reorderedLiveTree());
  if (categoryMode === "reordered-subs") return mockResponse(200, reorderedSubcategoriesTree());
  if (categoryMode === "inactive-home") {
    return mockResponse(200, {
      data: LIVE_TREE.data.map((category) => (category.id === 1 ? { ...category, is_active: 0 } : category)),
    });
  }
  if (categoryMode === "replaced-id") {
    return mockResponse(200, {
      data: LIVE_TREE.data.map((category) => (category.id === 2 ? { ...category, id: 3 } : category)),
    });
  }
  if (categoryMode === "shifted") {
    return mockResponse(200, {
      data: [
        ...LIVE_TREE.data,
        {
          id: 99,
          name: "Extra",
          slug: "extra",
          is_active: 1,
          subcategories: [{ id: 990, name: "Extra sub", slug: "extra-sub", is_active: 1 }],
        },
      ],
    });
  }
  if (categoryMode === "timeout") {
    const error = new Error("The operation was aborted");
    error.name = "AbortError";
    throw error;
  }
  return mockResponse(200, LIVE_TREE);
}

function installFetch() {
  calls = [];
  setGiniFetch(async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    const target = String(url);
    calls.push({ method, url: target, options });
    if (method === "PUT") {
      if (!allowPut) throw new Error(`GINI write attempted: PUT ${target}`);
      return handlePut(target, options);
    }
    if (method !== "GET" && method !== "POST") throw new Error(`unexpected ${method} ${target}`);
    if (method === "POST" && !allowPost) throw new Error(`GINI write attempted: ${method} ${target}`);
    if (target.endsWith(GINI_PING_PATH)) return mockResponse(200, { data: { ok: true } });
    if (target.split("?")[0].endsWith(GINI_CATEGORIES_PATH)) return categoryResponse(target);
    if (method === "POST" && target.split("?")[0].endsWith(GINI_PRODUCTS_PATH)) return handlePost(options);
    if (method === "GET" && target.includes("/products/")) return handleLookup(skuFromProductUrl(target));
    if (method === "GET" && target.includes("/products?")) {
      if (lookupMode === "incomplete") return mockResponse(200, { data: [], meta: {} });
      return mockResponse(200, { data: [], meta: { last_page: 1, total: 0 } });
    }
    throw new Error(`unexpected ${target}`);
  });
}

function handleLookup(sku) {
  if (uncertainSkus?.has(giniSkuKey(sku))) return mockResponse(500, { message: "upstream" });
  if (lookupMode === "auth") return mockResponse(401, { message: "unauthorized" });
  if (lookupMode === "edge") {
    return mockResponse(
      403,
      `<HTML><TITLE>ERROR</TITLE><BODY>Request blocked. ${SECRET} Generated by cloudfront</BODY></HTML>`,
      "text/html"
    );
  }
  if (lookupMode === "error") return mockResponse(500, { message: "upstream" });
  if (lookupMode === "rate" && rateBudget > 0) {
    rateBudget -= 1;
    return mockResponse(429, { message: "slow down" }, "application/json", { "retry-after": "0" });
  }
  const found = remote.get(giniSkuKey(sku));
  if (found) return mockResponse(200, { data: { id: found.id, sku: found.sku, name: "Already there" } });
  return mockResponse(404, { message: "Product not found." });
}

function puts() {
  return calls.filter((item) => item.method === "PUT" && item.url.includes("/products/"));
}

function handlePut(target, options) {
  const sku = skuFromProductUrl(target);
  const body = JSON.parse(String(options.body || "{}"));
  const keys = Object.keys(body);
  if (keys.some((key) => key !== "price" && key !== "quantity")) return mockResponse(422, { message: "unexpected field" });
  const found = remote.get(giniSkuKey(sku));
  if (!found) return mockResponse(404, { message: "missing" });
  return mockResponse(200, {
    data: {
      id: found.id,
      sku: found.sku,
      price: body.price == null ? found.price : body.price,
      quantity: body.quantity == null ? found.quantity : body.quantity,
    },
  });
}

function handlePost(options) {
  const fields = formFields(options);
  if (postMode === "lose") {
    postMode = "";
    if (recoverOnLose && fields.sku) remote.set(giniSkuKey(fields.sku), { id: "77", sku: fields.sku });
    throw new Error("connection lost before a GINI response");
  }
  if (postMode === "edge") {
    return mockResponse(
      403,
      `<HTML><TITLE>ERROR</TITLE><BODY>Request blocked. ${SECRET} Generated by cloudfront</BODY></HTML>`,
      "text/html",
      { "x-request-id": "edge-req-1" }
    );
  }
  if (postMode === "auth") return mockResponse(401, { message: `unauthorized ${SECRET}` });
  if (postMode === "rate") {
    return mockResponse(429, { message: "slow down" }, "application/json", { "retry-after": "0" });
  }
  createdSeq += 1;
  const id = String(createdSeq);
  if (fields.sku) remote.set(giniSkuKey(fields.sku), { id, sku: fields.sku });
  return mockResponse(201, { data: { id, sku: fields.sku } });
}

function installMedia() {
  mediaCalls = [];
  setGiniMediaFetch(async (url) => {
    mediaCalls.push(String(url));
    if (invalidImage) {
      return {
        status: 200,
        headers: { get: () => "text/html" },
        async arrayBuffer() {
          return Buffer.from("<html>not an image</html>");
        },
      };
    }
    return {
      status: 200,
      headers: {
        get(name) {
          const key = String(name).toLowerCase();
          if (key === "content-length" && hugeImage) return String(6 * 1024 * 1024);
          if (key === "content-type") return "image/png";
          return null;
        },
      },
      async arrayBuffer() {
        return PNG;
      },
    };
  });
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
  return { status: response.status, json };
}

function catalogId(index) {
  return index.toString(16).padStart(24, "0");
}

function reorderedLiveTree() {
  return {
    data: [...LIVE_TREE.data].reverse().map((category) => ({
      ...category,
      subcategories: [...category.subcategories].reverse(),
    })),
  };
}

function reorderedSubcategoriesTree() {
  return {
    data: LIVE_TREE.data.map((category) => ({
      ...category,
      subcategories: [...category.subcategories].reverse(),
    })),
  };
}

function simpleVariant(stock = 5, extra = {}) {
  return [
    {
      color: { en: "white", ar: "", ku: "" },
      images: [{ url: "/uploads/products/patch.webp", isMain: true }],
      sizes: [{ size: "medium", stockQuantity: stock }],
      ...extra,
    },
  ];
}

async function makeProduct(overrides = {}) {
  const variants = overrides.variants || simpleVariant(overrides.stock ?? 5);
  return Product.create({
    ...(overrides._id ? { _id: overrides._id } : {}),
    ibsherId: overrides.ibsherId || `ibs-${crypto.randomBytes(4).toString("hex")}`,
    itemCode: overrides.itemCode === undefined ? "BS-SYNC-1" : overrides.itemCode,
    name: overrides.name || { en: "Adhesive Patches", ar: "Adhesive Patches", ku: "Adhesive Patches" },
    description: overrides.description || {
      en: "Covers a blemish.",
      ar: "لصقات للبثور من كوزركس",
      ku: "پەچە",
    },
    price: overrides.price === undefined ? 6500 : overrides.price,
    discountPrice: overrides.discountPrice || 0,
    brand: overrides.brand || { _id: overrides.brandId || "brand-cosrx", name: overrides.brandName ?? "COSRX" },
    category: { _id: overrides.categoryId || "cat-beauty", name: { en: "Beauty & Personal Care" } },
    subCategory: { _id: overrides.subCategoryId || "sub-skin", name: { en: "Skin Care" } },
    collectionName: { _id: overrides.collectionId || "col-acne", name: { en: "Acne Patches" } },
    isActive: overrides.isActive !== false,
    createdBy: overrides.createdBy,
    variants,
  });
}

async function mapCollection(values, collectionId = "col-acne") {
  await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner: "gini", brownCollectionId: collectionId },
    {
      $set: {
        values: values || {
          categoryId: "1",
          categoryName: "Home",
          subcategoryId: "10",
          subcategoryName: "Blenders",
        },
      },
    },
    { upsert: true }
  );
}

async function connectGini() {
  allowPost = false;
  installFetch();
  await call("PUT", "/api/admin/platforms/gini/connection", {
    body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
  });
  const tested = await call("POST", "/api/admin/platforms/gini/connection/test", {
    body: { baseUrl: GINI_DEFAULT_BASE_URL, clientId: CLIENT_ID, clientSecret: SECRET },
  });
  assert.equal(tested.json.status, "connected");
  calls = [];
}

async function ensureConnected() {
  const current = await getGiniConnectionPublic();
  if (current.status === "connected") return;
  await connectGini();
}

function posts() {
  return calls.filter((item) => item.method === "POST" && item.url.includes(GINI_PRODUCTS_PATH));
}

function productGets() {
  return calls.filter((item) => item.method === "GET" && item.url.includes("/products/"));
}

function categoryGets() {
  return calls.filter((item) => item.method === "GET" && item.url.split("?")[0].endsWith(GINI_CATEGORIES_PATH));
}

async function startPreview() {
  const started = await runGiniSyncPreview();
  assert.equal(started.dryRun, true);
  assert.equal(started.sentToGini, 0);
  await waitForGiniBulkIdle();
  return (await getLatestGiniSyncJob()).job;
}

function assertNoPreviewCreates(job) {
  assert.equal(giniBulkWritesEnabled(), false);
  assert.equal(posts().length, 0);
  assert.equal(job.created || 0, 0);
}

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.toLowerCase().includes("clientsecret"), false);
  assert.equal(text.includes("X-SIGNATURE"), false);
}

function assertNoIdempotency(items = posts()) {
  for (const item of items) assert.equal(headerNames(item.options).includes("idempotency-key"), false);
}

async function previewAll() {
  const started = await runGiniSyncPreview();
  assert.equal(started.dryRun, true);
  assert.equal(started.sentToGini, 0);
  await waitForGiniBulkIdle(240000);
  const latest = await getLatestGiniSyncJob();
  const job = latest.job;
  if (!job || (job.status !== "preview" && job.status !== "stale")) {
    throw new Error(`preview ended ${job?.status || "missing"}: ${job?.lastError || ""}`);
  }
  return job;
}

function enableWrites() {
  process.env.GINI_BULK_WRITES_ENABLED = "true";
  process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
  allowPost = true;
}

async function runSync(job, { scope = "full", limit } = {}) {
  enableWrites();
  await startGiniSyncAll({
    confirm: true,
    previewJobId: job.id,
    catalogSignature: job.catalogSignature,
    expectedReady: job.readyCreate,
    scope,
    limit,
    approveFullRun: scope === "full",
  });
  await waitForGiniBulkIdle(120000);
  return (await getLatestGiniSyncJob()).job;
}

async function rejectsCode(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.code, code);
    return true;
  });
}

async function rowsFor(job) {
  return GiniSyncProductResult.find({ jobId: job.id }).lean();
}

async function pausePreviewAfterFirst(itemCode) {
  await makeProduct({ itemCode, ibsherId: `pause-${itemCode}` });
  await mapCollection();
  setGiniBulkBatchSize(1);
  setGiniBulkAfterProduct(async ({ processed }) => {
    if (processed === 1) await pauseGiniSyncAll();
  });
  const paused = await startPreview();
  setGiniBulkAfterProduct(null);
  assert.equal(paused.status, "paused");
  assert.equal(paused.processed, 1);
  return paused;
}

async function assertResumeStale(paused) {
  calls = [];
  await resumeGiniSyncAll();
  await waitForGiniBulkIdle();
  const stale = (await getLatestGiniSyncJob()).job;
  assert.equal(stale.id, paused.id);
  assert.equal(stale.status, "stale");
  assert.equal(stale.errorCode, "preview_stale");
  assert.equal(stale.lastError, "The catalog changed during Full Preview. Run Full Preview again.");
  assert.equal(stale.catalogSignature, paused.catalogSignature);
  assert.equal(stale.processed, paused.processed);
  assert.equal(stale.created, 0);
  assert.equal(posts().length, 0);
  assert.equal(giniBulkWritesEnabled(), false);
  return stale;
}

describe("GINI sync all contract", () => {
  it("keeps both live write gates off unless each one is exactly true", () => {
    const previousEnabled = process.env.GINI_BULK_WRITES_ENABLED;
    const previousAllow = process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    assert.equal(giniBulkWritesEnabled(), false);
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    assert.equal(giniBulkWritesEnabled(), false);
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "TRUE";
    assert.equal(giniBulkWritesEnabled(), false);
    process.env.GINI_ALLOW_LIVE_BULK_WRITES = "true";
    assert.equal(giniBulkWritesEnabled(), true);
    if (previousEnabled == null) delete process.env.GINI_BULK_WRITES_ENABLED;
    else process.env.GINI_BULK_WRITES_ENABLED = previousEnabled;
    if (previousAllow == null) delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    else process.env.GINI_ALLOW_LIVE_BULK_WRITES = previousAllow;
  });

  it("does not change Sync One eligibility, other platforms, or committed write flags", () => {
    const root = new URL("../", import.meta.url);
    const syncOne = fs.readFileSync(new URL("./services/giniSyncOne.js", import.meta.url), "utf8");
    const syncAll = fs.readFileSync(new URL("./services/giniSyncAll.js", import.meta.url), "utf8");
    const page = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniSyncAll.jsx", import.meta.url), "utf8");
    const sidebar = fs.readFileSync(new URL("../../client/src/components/admin/platform/PlatformSidebar.jsx", import.meta.url), "utf8");
    assert.equal(syncOne.includes("evaluatePlatformEligibility"), false);
    assert.equal(syncAll.includes("evaluatePlatformEligibility"), true);
    assert.equal(/miswag|elryan|ibsher/i.test(syncAll), false);
    assert.equal(/Product\.(update|updateOne|updateMany|findOneAndUpdate|delete|deleteMany)/.test(syncAll), false);
    assert.equal(page.includes('confirm: true'), true);
    assert.equal(page.includes('scope: "limited"'), true);
    assert.equal(page.includes('scope: "full"'), true);
    assert.equal(page.includes("approveFullRun: true"), true);
    assert.equal(page.includes("process.env"), false);
    assert.equal(page.includes("data-gini-sync-all"), true);
    assert.equal(page.includes("selectGiniSyncDisplay"), true);
    assert.equal(page.includes("confirmedCreateCount"), true);
    assert.equal(page.includes("active ? job : approved || job"), false);
    assert.equal(page.includes("data-gini-sync-mode"), true);
    assert.equal(page.includes("data-gini-created"), true);
    assert.equal(page.includes("data-gini-preview-summary"), true);
    assert.equal(page.includes("data-gini-reconcile"), true);
    assert.equal(page.includes("data-gini-job-error"), true);
    assert.equal(page.includes("current.lastError"), true);
    assert.equal(page.includes("current.errorCode"), true);
    assert.equal(page.includes("progressbar"), true);
    assert.equal(sidebar.includes('["syncAll", "giniSyncAllTitle"]'), true);
    for (const language of ["ku", "en", "ar"]) {
      assert.equal(typeof translations[language].giniSyncAllTitle, "string");
      assert.equal(typeof translations[language].giniStartFullSync, "string");
      assert.equal(typeof translations[language].giniSyncBlocked, "string");
      assert.equal(typeof translations[language].giniSyncJobError, "string");
      assert.equal(typeof translations[language].giniSyncPreviewSeparate, "string");
      assert.equal(typeof translations[language].giniSyncReconcileMissing, "string");
      assert.equal(typeof translations[language].giniSyncReconcileUnverified, "string");
    }
    for (const name of [".env", ".env.local", ".env.example", "server/.env", "server/.env.local", "server/.env.example"]) {
      const path = new URL(name, root);
      if (!fs.existsSync(path)) continue;
      const text = fs.readFileSync(path, "utf8");
      assert.equal(/GINI_BULK_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_BULK_WRITES\s*=\s*true/.test(text), false);
      assert.equal(/GINI_SKU_CREATE_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_SKU_CREATE\s*=\s*true/.test(text), false);
      assert.equal(/GINI_SYNC_ONE_WRITES_ENABLED\s*=\s*true/.test(text), false);
      assert.equal(/GINI_ALLOW_LIVE_SYNC_ONE_WRITES\s*=\s*true/.test(text), false);
    }
  });

  it("waits out temporary category reads and keeps blocked reads from retrying", () => {
    assert.equal(giniCategoryRetryDelayMs(0, null, 1), 1000);
    assert.equal(giniCategoryRetryDelayMs(1, null, 1), 2000);
    assert.equal(giniCategoryRetryDelayMs(2, null, 1), 4000);
    assert.equal(giniCategoryRetryDelayMs(8, null, 1), 30000);
    assert.equal(giniCategoryRetryDelayMs(0, 2, 1), 2000);
    assert.equal(giniCategoryRetryDelayMs(0, 9999, 1), 120000);
    assert.equal(giniCategoryRetryDelayMs(4, 0, 1), 0);
  });

  it("keeps a completed full sync separate from preview counters", () => {
    const status = {
      job: {
        id: "sync-job",
        status: "completed",
        mode: "sync",
        runScope: "full",
        created: 57,
        failed: 0,
        createUncertain: 0,
        finishedAt: "2026-11-02T11:35:20.425Z",
      },
      preview: {
        id: "preview-job",
        status: "preview",
        mode: "preview",
        readyCreate: 57,
        created: 0,
        finishedAt: "2026-11-02T11:30:45.136Z",
      },
      reconciliation: [{ code: "confirmed_send_missing", sku: "LP-ID141232", giniProductId: "521043" }],
    };
    const shown = selectGiniSyncDisplay(status);
    const reloaded = selectGiniSyncDisplay(JSON.parse(JSON.stringify(status)));
    assert.equal(shown.current.status, "completed");
    assert.equal(shown.current.mode, "sync");
    assert.equal(shown.current.runScope, "full");
    assert.equal(confirmedCreateCount(shown.current), 57);
    assert.equal(shown.preview.mode, "preview");
    assert.equal(shown.preview.readyCreate, 57);
    assert.equal(confirmedCreateCount(shown.preview), 0);
    assert.equal(reloaded.current.id, "sync-job");
    assert.equal(reloaded.current.status, "completed");
    assert.equal(confirmedCreateCount(reloaded.current), 57);
    assert.deepEqual(reconciliationWarnings(status, shown.current), status.reconciliation);
  });

  it("does not classify an unverified saved send as currently on GINI", () => {
    const plan = { sku: "E6310221", blockers: [], lookupState: "absent" };
    const localSend = { giniProductId: "522091" };
    const missing = classifyConfirmedSend({ plan, localSend, found: { exists: false } });
    const unverified = classifyConfirmedSend({ plan, localSend, found: { error: true, status: 500 } });
    const matched = classifyConfirmedSend({ plan, localSend, found: { exists: true, giniProductId: "522091" } });
    const mismatch = classifyConfirmedSend({ plan, localSend, found: { exists: true, giniProductId: "999" } });
    assert.equal(missing.classification, "RECONCILE");
    assert.equal(missing.errorCode, "confirmed_send_missing");
    assert.equal(missing.giniProductId, "522091");
    assert.equal(unverified.classification, "RECONCILE");
    assert.equal(unverified.errorCode, "confirmed_send_unverified");
    assert.equal(unverified.giniProductId, "522091");
    assert.equal(matched.classification, "ALREADY_EXISTS");
    assert.equal(matched.giniProductId, "522091");
    assert.equal(mismatch.classification, "RECONCILE");
    assert.equal(mismatch.errorCode, "confirmed_send_id_mismatch");
    assert.equal(mismatch.giniProductId, "522091");
  });

  it("counts every collection mapping and does not treat a mapped collection as sendable", () => {
    const coverage = summarizeGiniMappingCoverage([
      { id: "a", name: "Mapped A", status: "configured", productCount: 10, activeProductCount: 8 },
      { id: "b", name: "Mapped B", status: "configured", productCount: 4, activeProductCount: 4 },
      { id: "c", name: "Open C", status: "missing", productCount: 3, activeProductCount: 3 },
      { id: "d", name: "Open D", status: "missing", productCount: 2, activeProductCount: 1 },
      { id: "e", name: "Open E", status: "missing", productCount: 1, activeProductCount: 1 },
      { id: "f", name: "Bad F", status: "invalid", productCount: 5, activeProductCount: 5 },
      { id: "g", name: "Quiet G", status: "inactive", productCount: 6, activeProductCount: 0 },
    ]);
    assert.equal(coverage.total, 7);
    assert.equal(coverage.configured, 2);
    assert.equal(coverage.unmapped, 3);
    assert.equal(coverage.invalid, 1);
    assert.equal(coverage.inactive, 1);
    assert.equal(coverage.unmappedProductCount, 6);
    assert.equal(coverage.configuredActiveProductCount, 12);
    assert.equal(coverage.mappedIsNotSendEligibility, true);
    assert.deepEqual(
      coverage.unmappedCollections.map((row) => row.id),
      ["c", "d", "e"]
    );
    const plan = {
      sku: "KEEP-1",
      payloadPreview: { sku: "KEEP-1", price: 10, quantity: 1, name: "Keep", description: "Keep", security_stock: 1, category_id: 1, subcategory_id: 10, is_visible: 1, images: [] },
      giniPrice: 10,
      quantity: 1,
      imageCount: 1,
    };
    const hash = giniPayloadHash(plan.payloadPreview);
    const skip = localConfirmedCatalogDecision({
      plan,
      localSend: { sku: "KEEP-1", giniProductId: "55", payloadHash: hash },
    });
    assert.equal(skip.action, "store");
    assert.equal(skip.result.classification, "UNCHANGED");
    assert.equal(skip.result.giniProductId, "55");
    const verify = localConfirmedCatalogDecision({
      plan,
      localSend: { sku: "KEEP-1", giniProductId: "55", payloadHash: "other" },
    });
    assert.equal(verify.action, "verify_remote");
    const held = classifyOfficialFieldChange({
      plan: { ...plan, sku: "HA0449" },
      localSend: { sku: "HA0449", giniProductId: "1", payloadHash: "other" },
      snapshot: { giniPrice: 9, quantity: 1 },
    });
    assert.equal(held.classification, "RECONCILE");
    assert.equal(held.errorCode, "historical_sku_hold");
    const syncAll = fs.readFileSync(new URL("./services/giniSyncAll.js", import.meta.url), "utf8");
    assert.equal(syncAll.includes("giniResync"), false);
    assert.equal(syncAll.includes("summarizeGiniMappingCoverage"), true);
    assert.equal(syncAll.includes('from "./giniResync.js"'), false);
  });
});

describe("GINI sync all", { concurrency: 1, timeout: 360000 }, () => {
  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-sync-all"));
    const user = await User.create({
      email: "gini-sync-all@brownstore.test",
      passwordHash: "hash",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await Partner.create({ slug: "gini", name: "Gini", isActive: true });
    server = await listen(app());
    setGiniCategoryRetryScale(0);
    installFetch();
    installMedia();
    await connectGini();
  });

  after(async () => {
    await waitForGiniBulkIdle(30000).catch(() => {});
    resetGiniBulkForTests();
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    setGiniCategoryRetryScale(1);
    setGiniFetch(null);
    setGiniMediaFetch(null);
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    if (memory) await memory.stop();
  });

  beforeEach(async () => {
    await waitForGiniBulkIdle(30000).catch(() => {});
    resetGiniBulkForTests();
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    allowPost = false;
    allowPut = false;
    delete process.env.GINI_UPDATE_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_UPDATE_WRITES;
    remote = new Map();
    lookupMode = "";
    uncertainSkus = null;
    rateBudget = 0;
    postMode = "";
    recoverOnLose = false;
    invalidImage = false;
    hugeImage = false;
    createdSeq = 500;
    categoryMode = "";
    categoryFailuresLeft = 0;
    categoryReads = 0;
    setGiniCategoryRetryScale(0);
    installFetch();
    installMedia();
    await Promise.all([
      Product.deleteMany({}),
      Commission.deleteMany({}),
      PlatformTaxonomyConfig.deleteMany({ partner: "gini" }),
      PlatformVisibilityRule.deleteMany({ partner: "gini" }),
      GiniSyncJob.deleteMany({}),
      GiniSyncProductResult.deleteMany({}),
      GiniSyncSendState.deleteMany({}),
      GiniProductUpdateAudit.deleteMany({}),
      Partner.updateOne({ slug: "gini" }, { $set: { isActive: true } }),
    ]);
    await ensureConnected();
    calls = [];
    mediaCalls = [];
    categoryReads = 0;
  });

  it("previews a ready simple product with no writes and reports real counts", async () => {
    const product = await makeProduct();
    await mapCollection();
    const before = await Product.findById(product._id).lean();
    const job = await previewAll();
    const rows = await rowsFor(job);
    assert.equal(job.status, "preview");
    assert.equal(job.mode, "preview");
    assert.equal(job.total, 1);
    assert.equal(job.processed, 1);
    assert.equal(job.percent, 100);
    assert.equal(job.eligible, 1);
    assert.equal(job.readyCreate, 1);
    assert.equal(job.created, 0);
    assert.equal(job.updatesSupported, false);
    assert.equal(job.idempotencyKeySupported, false);
    assert.equal(job.endpoint, GINI_PRODUCTS_PATH);
    assert.equal(job.createMethod, "POST");
    assert.equal(rows[0].classification, "READY_CREATE");
    assert.equal(rows[0].giniPrice, 6500);
    assert.equal(rows[0].quantity, 5);
    assert.equal(rows[0].giniProductId, "");
    assert.equal(posts().length, 0);
    assert.equal(calls.every((item) => item.method === "GET"), true);
    assert.equal(mediaCalls.length, 0);
    assert.equal(productGets().length, 1);
    const after = await Product.findById(product._id).lean();
    assert.equal(after.price, before.price);
    assert.equal(JSON.stringify(after.variants), JSON.stringify(before.variants));
    assertNoSecret(job);
  });

  it("prices from the regular BrownStore price and the GINI commission, then creates once", async () => {
    const product = await makeProduct({ price: 1000, discountPrice: 400, itemCode: "PRICE-1000" });
    await mapCollection();
    await Commission.create({ partner: "gini", scope: "all", targetId: "*", percentage: 10, isActive: true });
    const preview = await previewAll();
    const previewRow = (await rowsFor(preview))[0];
    assert.equal(previewRow.classification, "READY_CREATE");
    assert.equal(previewRow.giniPrice, 1250);
    assert.equal((await Product.findById(product._id).lean()).price, 1000);
    assert.equal((await Product.findById(product._id).lean()).discountPrice, 400);
    assert.equal((await Commission.findOne({ partner: "gini" }).lean()).percentage, 10);
    const sync = await runSync(preview);
    const created = (await rowsFor(sync)).find((row) => row.classification === "CREATED");
    const sent = posts();
    assert.equal(sync.status, "completed");
    assert.equal(sync.created, 1);
    assert.equal(sync.failed, 0);
    assert.equal(sent.length, 1);
    const fields = formFields(sent[0].options);
    assert.equal(fields.price, "1250");
    assert.equal(fields.sku, "PRICE-1000");
    assert.equal(fields.security_stock, "1");
    assert.equal(fields.category_id, "1");
    assert.equal(fields.subcategory_id, "10");
    assert.equal(fields.description, "لصقات للبثور من كوزركس");
    assert.equal(fields.name, "| COSRX | Adhesive Patches / Adhesive Patches");
    assert.equal(fields.quantity, "5");
    assert.equal(created.giniProductId, "501");
    assertNoIdempotency(sent);
    const state = await GiniSyncSendState.findOne({ skuKey: giniSkuKey("PRICE-1000") }).lean();
    assert.equal(state.giniProductId, "501");
    assert.equal((await Product.findById(product._id).lean()).price, 1000);
    calls = [];
    const again = await previewAll();
    const againRow = (await rowsFor(again))[0];
    assert.equal(againRow.classification, "UNCHANGED");
    assert.equal(againRow.errorCode, "");
    assert.equal(againRow.giniProductId, "501");
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
    assert.equal(productGets().some((item) => decodeURIComponent(item.url).includes("PRICE-1000")), false);
    assert.equal((await GiniSyncSendState.findOne({ skuKey: giniSkuKey("PRICE-1000") }).lean()).giniProductId, "501");
  });

  it("blocks missing, inactive, and invalid category mappings without a create", async () => {
    const missing = await makeProduct({ itemCode: "MAP-MISSING" });
    const inactiveSub = await makeProduct({ itemCode: "MAP-SUB", collectionId: "col-sub" });
    const inactiveCategory = await makeProduct({ itemCode: "MAP-CAT", collectionId: "col-cat" });
    const invalid = await makeProduct({ itemCode: "MAP-BAD", collectionId: "col-bad" });
    await mapCollection(
      { categoryId: "1", categoryName: "Home", subcategoryId: "11", subcategoryName: "Retired" },
      "col-sub"
    );
    await mapCollection(
      { categoryId: "2", categoryName: "Hidden", subcategoryId: "20", subcategoryName: "Archived" },
      "col-cat"
    );
    await mapCollection(
      { categoryId: "1", categoryName: "Home", subcategoryId: "999", subcategoryName: "Missing" },
      "col-bad"
    );
    const job = await previewAll();
    const rows = await rowsFor(job);
    const byCode = Object.fromEntries(rows.map((row) => [row.sku, row]));
    assert.equal(byCode["MAP-MISSING"].classification, "BLOCKED");
    assert.equal(byCode["MAP-MISSING"].blockers.includes("missing_mapping"), true);
    assert.equal(byCode["MAP-SUB"].blockers.includes("inactive_mapping"), true);
    assert.equal(byCode["MAP-CAT"].blockers.includes("inactive_mapping"), true);
    assert.equal(byCode["MAP-BAD"].blockers.includes("invalid_mapping"), true);
    assert.equal(job.readyCreate, 0);
    assert.equal(job.blocked, 4);
    assert.equal(job.eligible, 3);
    assert.equal(posts().length, 0);
    assert.equal(productGets().length, 0);
    assert.ok(job.blockerExamples.some((item) => item.code === "missing_mapping" && item.productId === String(missing._id)));
    assert.ok(inactiveSub._id);
    assert.ok(inactiveCategory._id);
    assert.ok(invalid._id);
  });

  it("keeps inactive and excluded products out of the create set", async () => {
    const inactive = await makeProduct({ itemCode: "OFF-1", isActive: false });
    const branded = await makeProduct({
      itemCode: "OFF-BRAND",
      brand: { _id: "brand-off", name: "Hidden Brand" },
    });
    const vended = await makeProduct({
      itemCode: "OFF-VENDOR",
      createdBy: { _id: "vendor-off" },
    });
    await mapCollection();
    await PlatformVisibilityRule.create([
      { partner: "gini", scope: "brand", targetId: "brand-off", isActive: false },
      { partner: "gini", scope: "vendor", targetId: "vendor-off", isActive: false },
    ]);
    const one = await previewGiniSyncOne({ productId: String(inactive._id) });
    assert.equal(one.action, "CREATE");
    assert.equal(one.blockers.includes("product_inactive"), false);
    calls = [];
    const job = await previewAll();
    const rows = await rowsFor(job);
    const byCode = Object.fromEntries(rows.map((row) => [row.sku, row]));
    assert.equal(byCode["OFF-1"].classification, "INACTIVE");
    assert.equal(byCode["OFF-1"].blockers.includes("product_inactive"), true);
    assert.equal(byCode["OFF-BRAND"].classification, "INACTIVE");
    assert.equal(byCode["OFF-BRAND"].blockers.includes("brand_inactive"), true);
    assert.equal(byCode["OFF-VENDOR"].classification, "INACTIVE");
    assert.equal(byCode["OFF-VENDOR"].blockers.includes("vendor_inactive"), true);
    assert.equal(job.inactive, 3);
    assert.equal(job.readyCreate, 0);
    assert.equal(job.eligible, 0);
    assert.equal(posts().length, 0);
    assert.equal(productGets().length, 0);
    assert.ok(branded._id);
    assert.ok(vended._id);
  });

  it("blocks duplicate BrownStore SKUs and does not look them up", async () => {
    await makeProduct({ ibsherId: "dup-a", itemCode: "1053" });
    await makeProduct({ ibsherId: "dup-b", itemCode: "1053" });
    await makeProduct({ ibsherId: "space-a", itemCode: "AB C" });
    await makeProduct({ ibsherId: "space-b", itemCode: "ab-c" });
    await mapCollection();
    const job = await previewAll();
    const rows = await rowsFor(job);
    assert.equal(rows.length, 4);
    assert.equal(rows.every((row) => row.classification === "BLOCKED"), true);
    assert.equal(rows.every((row) => row.blockers.includes("duplicate_brownstore_sku")), true);
    assert.equal(job.readyCreate, 0);
    assert.equal(posts().length, 0);
    assert.equal(productGets().length, 0);
  });

  it("marks a SKU that already exists on GINI and refuses to post it", async () => {
    remote.set(giniSkuKey("BS-SYNC-1"), { id: "77", sku: "BS-SYNC-1" });
    await makeProduct();
    await mapCollection();
    const job = await previewAll();
    const row = (await rowsFor(job))[0];
    assert.equal(row.classification, "ALREADY_EXISTS");
    assert.equal(row.giniProductId, "77");
    assert.equal(job.alreadyExists, 1);
    assert.equal(job.readyCreate, 0);
    assert.equal(posts().length, 0);
    enableWrites();
    await rejectsCode(
      () =>
        startGiniSyncAll({
          confirm: true,
          previewJobId: job.id,
          catalogSignature: job.catalogSignature,
          expectedReady: job.readyCreate,
          scope: "full",
          approveFullRun: true,
        }),
      "nothing_to_send"
    );
    assert.equal(posts().length, 0);
  });

  it("holds historical SKUs and the Sync One SKU out of Full Sync when GINI verifies them missing", async () => {
    await makeProduct({ itemCode: "HA0449" });
    await makeProduct({ itemCode: "HB-632" });
    await makeProduct({ itemCode: "ZJP00.000BK" });
    await mapCollection();
    const job = await previewAll();
    const rows = await rowsFor(job);
    const held = rows.filter((row) => row.sku === "HA0449" || row.sku === "HB-632");
    assert.equal(held.length, 2);
    assert.equal(held.every((row) => row.classification === "BLOCKED"), true);
    assert.equal(held.every((row) => row.blockers.includes("historical_sku_hold")), true);
    assert.equal(rows.find((row) => row.sku === "ZJP00.000BK")?.classification, "READY_CREATE");
    assert.equal(job.readyCreate, 1);
    const sync = await runSync(job);
    const posted = posts().map((item) => formFields(item.options).sku);
    assert.deepEqual(posted, ["ZJP00.000BK"]);
    assert.equal(sync.created, 1);
    assert.equal(await GiniSyncSendState.countDocuments({ sku: { $in: ["HA0449", "HB-632"] } }), 0);
  });

  it("does not treat a failed SKU lookup as available", async () => {
    lookupMode = "error";
    await makeProduct({ itemCode: "LOOK-ERR" });
    await mapCollection();
    const job = await previewAll();
    const row = (await rowsFor(job))[0];
    const latest = await getLatestGiniSyncJob();
    assert.equal(row.classification, "LOOKUP_UNCERTAIN");
    assert.equal(row.blockers.includes("gini_lookup_failed"), true);
    assert.equal(job.readyCreate, 0);
    assert.equal(job.alreadyExists, 0);
    assert.equal(job.lookupUncertain, 1);
    assert.equal(latest.job.recentFailures[0].sku, "LOOK-ERR");
    assert.equal(posts().length, 0);
  });

  it("blocks complex variants and sends only the simple product", async () => {
    await makeProduct({ itemCode: "SIMPLE-1" });
    await makeProduct({
      itemCode: "COMPLEX-SIZE",
      variants: [
        {
          color: { en: "white" },
          images: [{ url: "/uploads/products/patch.webp", isMain: true }],
          sizes: [
            { size: "small", stockQuantity: 1 },
            { size: "medium", stockQuantity: 2 },
          ],
        },
      ],
    });
    await makeProduct({
      itemCode: "COMPLEX-COLOR",
      variants: [
        {
          color: { en: "white" },
          images: [{ url: "/uploads/products/patch.webp", isMain: true }],
          sizes: [{ size: "medium", stockQuantity: 1, color: { en: "black" } }],
        },
      ],
    });
    await mapCollection();
    const preview = await previewAll();
    const previewRows = await rowsFor(preview);
    const byCode = Object.fromEntries(previewRows.map((row) => [row.sku, row]));
    assert.equal(byCode["SIMPLE-1"].classification, "READY_CREATE");
    assert.equal(byCode["COMPLEX-SIZE"].classification, "BLOCKED");
    assert.equal(byCode["COMPLEX-SIZE"].blockers.includes("gini_variant_mapping_required"), true);
    assert.equal(byCode["COMPLEX-COLOR"].blockers.includes("gini_variant_mapping_required"), true);
    const sync = await runSync(preview);
    const sent = posts();
    assert.equal(sync.created, 1);
    assert.equal(sent.length, 1);
    assert.equal(formFields(sent[0].options).sku, "SIMPLE-1");
  });

  it("blocks missing Arabic text, a bad image URL, and a zero price", async () => {
    await makeProduct({
      itemCode: "NO-AR-DESC",
      description: { en: "English only", ar: "", ku: "کوردی" },
    });
    await makeProduct({
      itemCode: "NO-AR-NAME",
      name: { en: "English name", ar: "", ku: "ناو" },
    });
    await makeProduct({
      itemCode: "NO-IMAGE",
      variants: [{ color: { en: "white" }, images: [], sizes: [{ size: "medium", stockQuantity: 5 }] }],
    });
    await makeProduct({ itemCode: "ZERO-PRICE", price: 0 });
    await makeProduct({ itemCode: "ZERO-STOCK", stock: 0 });
    await mapCollection();
    const job = await previewAll();
    const byCode = Object.fromEntries((await rowsFor(job)).map((row) => [row.sku, row]));
    assert.equal(byCode["NO-AR-DESC"].classification, "BLOCKED");
    assert.equal(byCode["NO-AR-DESC"].blockers.includes("missing_description"), true);
    assert.equal(byCode["NO-AR-NAME"].blockers.includes("missing_name"), true);
    assert.equal(byCode["NO-IMAGE"].blockers.includes("missing_image"), true);
    assert.equal(isAllowedMediaUrl("http://api.brownstore.net/api/media/a.webp"), false);
    assert.equal(isAllowedMediaUrl("https://evil.example/api/media/a.webp"), false);
    assert.equal(isAllowedMediaUrl("https://user:pass@api.brownstore.net/api/media/a.webp"), false);
    assert.equal(isAllowedMediaUrl("https://api.brownstore.net/api/media/../secret.webp"), false);
    assert.equal(byCode["ZERO-PRICE"].classification, "NEEDS_REVIEW");
    assert.deepEqual(byCode["ZERO-PRICE"].blockers, ["price_needs_review"]);
    assert.equal(byCode["ZERO-STOCK"].classification, "READY_CREATE");
    assert.equal(byCode["ZERO-STOCK"].quantity, 0);
    assert.equal(job.needsReview, 1);
    assert.equal(job.readyCreate, 1);
    assert.equal(posts().length, 0);
    assert.equal(mediaCalls.length, 0);
  });

  it("rejects a downloaded file that is not an image and does not post", async () => {
    invalidImage = true;
    await makeProduct({ itemCode: "HTML-IMG" });
    await mapCollection();
    const preview = await previewAll();
    assert.equal(preview.readyCreate, 1);
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    assert.equal(row.classification, "FAILED");
    assert.equal(row.errorCode, "invalid_image");
    assert.equal(sync.created, 0);
    assert.equal(posts().length, 0);
    assert.equal(mediaCalls.length, 1);
    assert.equal(await GiniSyncSendState.countDocuments(), 0);
  });

  it("fails an oversized image at send time and does not post", async () => {
    hugeImage = true;
    await makeProduct({ itemCode: "HUGE-IMG" });
    await mapCollection();
    const preview = await previewAll();
    assert.equal(preview.readyCreate, 1);
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    assert.equal(row.classification, "FAILED");
    assert.equal(row.blockers.includes("invalid_image"), true);
    assert.equal(sync.created, 0);
    assert.equal(posts().length, 0);
    assert.equal(mediaCalls.length, 1);
    assert.equal(await GiniSyncSendState.countDocuments(), 0);
  });

  it("pauses, resumes, and stops without skipping or repeating products", async () => {
    await makeProduct({ itemCode: "PAUSE-1" });
    await makeProduct({ itemCode: "PAUSE-2" });
    await makeProduct({ itemCode: "PAUSE-3" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    let pauses = 0;
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1 && pauses === 0) {
        pauses += 1;
        await pauseGiniSyncAll();
      }
    });
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const paused = (await getLatestGiniSyncJob()).job;
    assert.equal(paused.status, "paused");
    assert.equal(paused.processed, 1);
    assert.equal(posts().length, 0);
    await rejectsCode(runGiniSyncPreview, "sync_active");
    setGiniBulkAfterProduct(null);
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    const ids = (await rowsFor(done)).map((row) => row.productId);
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 3);
    assert.equal(new Set(ids).size, 3);
    assert.equal(posts().length, 0);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await stopGiniSyncAll();
    });
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const stopped = (await getLatestGiniSyncJob()).job;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.processed, 1);
    await rejectsCode(resumeGiniSyncAll, "not_paused");
  });

  it("requires confirmation, both gates, a matching preview, and a separate full-run approval", async () => {
    await makeProduct({ itemCode: "GATE-1" });
    await mapCollection();
    const job = await previewAll();
    const start = {
      confirm: true,
      previewJobId: job.id,
      catalogSignature: job.catalogSignature,
      expectedReady: job.readyCreate,
      scope: "full",
      approveFullRun: true,
    };
    await rejectsCode(() => startGiniSyncAll({ ...start, confirm: false }), "confirm_required");
    await rejectsCode(() => startGiniSyncAll(start), "bulk_writes_disabled");
    process.env.GINI_BULK_WRITES_ENABLED = "true";
    await rejectsCode(() => startGiniSyncAll(start), "bulk_writes_disabled");
    enableWrites();
    await rejectsCode(() => startGiniSyncAll({ ...start, approveFullRun: false }), "full_run_approval_required");
    await rejectsCode(() => startGiniSyncAll({ ...start, scope: "limited", limit: 0 }), "invalid_limit");
    await rejectsCode(() => startGiniSyncAll({ ...start, scope: "limited", limit: 26 }), "invalid_limit");
    await rejectsCode(() => startGiniSyncAll({ ...start, expectedReady: job.readyCreate + 1 }), "preview_mismatch");
    await rejectsCode(() => startGiniSyncAll({ ...start, catalogSignature: "other-preview" }), "preview_stale");
    await rejectsCode(() => startGiniSyncAll({ ...start, previewJobId: new mongoose.Types.ObjectId().toString() }), "preview_required");
    await makeProduct({ itemCode: "GATE-2" });
    await rejectsCode(() => startGiniSyncAll(start), "preview_stale");
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncJob.countDocuments({ mode: "sync" }), 0);
  });

  it("sends only an approved limited count, then a later full run skips confirmed products", async () => {
    await makeProduct({ itemCode: "LIM-1" });
    await makeProduct({ itemCode: "LIM-2" });
    await makeProduct({ itemCode: "LIM-3" });
    await mapCollection();
    const preview = await previewAll();
    assert.equal(preview.readyCreate, 3);
    const limited = await runSync(preview, { scope: "limited", limit: 1 });
    assert.equal(limited.status, "completed");
    assert.equal(limited.limitReached, true);
    assert.equal(limited.created, 1);
    assert.equal(limited.runScope, "limited");
    assert.equal(posts().length, 1);
    assert.equal(formFields(posts()[0].options).sku, "LIM-1");
    const full = await runSync(preview, { scope: "full" });
    const fullRows = await rowsFor(full);
    const createdSkus = fullRows.filter((row) => row.classification === "CREATED").map((row) => row.sku).sort();
    const existing = fullRows.find((row) => row.sku === "LIM-1");
    assert.equal(full.status, "completed");
    assert.deepEqual(createdSkus, ["LIM-2", "LIM-3"]);
    assert.equal(existing.classification, "UNCHANGED");
    assert.equal(existing.giniProductId, "501");
    assert.equal(posts().length, 3);
    assert.equal(await GiniSyncSendState.countDocuments(), 3);
  });

  it("does not post a SKU that appears on GINI after the preview", async () => {
    await makeProduct({ itemCode: "LATE-EXISTS" });
    await mapCollection();
    const preview = await previewAll();
    assert.equal(preview.readyCreate, 1);
    remote.set(giniSkuKey("LATE-EXISTS"), { id: "88", sku: "LATE-EXISTS" });
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    assert.equal(row.classification, "ALREADY_EXISTS");
    assert.equal(row.giniProductId, "88");
    assert.equal(sync.created, 0);
    assert.equal(posts().length, 0);
    const state = await GiniSyncSendState.findOne({ skuKey: giniSkuKey("LATE-EXISTS") }).lean();
    assert.equal(state.giniProductId, "88");
  });

  it("reconciles a lost create response and does not post that SKU again in the job", async () => {
    await makeProduct({ itemCode: "LOST-1" });
    await mapCollection();
    const preview = await previewAll();
    postMode = "lose";
    recoverOnLose = true;
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    assert.equal(posts().length, 1);
    assert.equal(row.classification, "CREATED");
    assert.equal(row.giniProductId, "77");
    assert.equal(row.errorCode, "create_recovered_by_sku");
    assert.equal((await GiniSyncSendState.findOne({ skuKey: giniSkuKey("LOST-1") }).lean()).giniProductId, "77");
    assertNoIdempotency();
  });

  it("keeps a lost create uncertain when GINI still does not show the SKU", async () => {
    await makeProduct({ itemCode: "LOST-2" });
    await mapCollection();
    const preview = await previewAll();
    postMode = "lose";
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    const latest = await getLatestGiniSyncJob();
    assert.equal(posts().length, 1);
    assert.equal(row.classification, "CREATE_UNCERTAIN");
    assert.equal(row.giniProductId, "");
    assert.equal(sync.created, 0);
    assert.equal(sync.createUncertain, 1);
    assert.equal(latest.job.recentFailures[0].errorCode, "create_uncertain");
    assert.equal(await GiniSyncSendState.countDocuments(), 0);
    assertNoSecret(row);
  });

  it("pauses on rate limits, authentication failures, and edge blocks without another create", async () => {
    await makeProduct({ itemCode: "RATE-LOOK" });
    await mapCollection();
    lookupMode = "rate";
    rateBudget = 1;
    const retried = await previewAll();
    assert.equal(retried.readyCreate, 1);
    assert.equal(retried.status, "preview");
    assert.equal(posts().length, 0);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    lookupMode = "rate";
    rateBudget = 20;
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const limited = (await getLatestGiniSyncJob()).job;
    assert.equal(limited.status, "rate_limited");
    assert.equal(limited.processed, 0);
    assert.equal(posts().length, 0);
    assertNoSecret(limited);

    await GiniSyncJob.deleteMany({});
    lookupMode = "auth";
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    assert.equal((await getLatestGiniSyncJob()).job.status, "auth_failed");
    assert.equal(posts().length, 0);

    await GiniSyncJob.deleteMany({});
    lookupMode = "edge";
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const edged = (await getLatestGiniSyncJob()).job;
    assert.equal(edged.status, "edge_blocked");
    assertNoSecret(edged);
    assert.equal(posts().length, 0);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    lookupMode = "";
    const preview = await previewAll();
    postMode = "rate";
    const ratedPost = await runSync(preview);
    assert.equal(ratedPost.status, "rate_limited");
    assert.equal(ratedPost.createUncertain, 1);
    assert.equal(posts().length, 1);
    assert.equal(await GiniSyncSendState.countDocuments(), 0);

    await GiniSyncJob.deleteMany({ mode: "sync" });
    await GiniSyncProductResult.deleteMany({ classification: { $ne: "READY_CREATE" } });
    postMode = "auth";
    const authPost = await runSync(preview);
    assert.equal(authPost.status, "auth_failed");
    assert.equal((await rowsFor(authPost))[0].classification, "FAILED");
    assert.equal(posts().length, 2);
    assertNoSecret(authPost);

    await GiniSyncJob.deleteMany({ mode: "sync" });
    await GiniSyncProductResult.deleteMany({ classification: { $ne: "READY_CREATE" } });
    postMode = "edge";
    const edgePost = await runSync(preview);
    assert.equal(edgePost.status, "edge_blocked");
    assert.equal((await rowsFor(edgePost))[0].classification, "FAILED");
    assert.equal((await rowsFor(edgePost))[0].errorCode, "gini_edge_blocked");
    assert.equal(posts().length, 3);
    assertNoSecret(edgePost);
    assertNoSecret(await rowsFor(edgePost));
  });

  it("pauses after repeated uncertain lookups", async () => {
    lookupMode = "error";
    for (let index = 0; index < 5; index += 1) {
      await makeProduct({ itemCode: `ERR-${index}` });
    }
    await mapCollection();
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const job = (await getLatestGiniSyncJob()).job;
    assert.equal(job.status, "paused");
    assert.equal(job.lookupUncertain, 5);
    assert.equal(job.readyCreate, 0);
    assert.equal(posts().length, 0);
  });

  it("continues a preview when five LOOKUP_UNCERTAIN results are separated by valid outcomes", async () => {
    const keep = await makeProduct({ _id: catalogId(5), itemCode: "KEEP-1", ibsherId: "keep-1" });
    await mapCollection();
    const seeded = await previewAll();
    const seededRow = (await rowsFor(seeded))[0];
    assert.equal(seededRow.classification, "READY_CREATE");
    assert.ok(seededRow.payloadHash);
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(keep._id),
      sku: "KEEP-1",
      skuKey: giniSkuKey("KEEP-1"),
      giniProductId: "901",
      payloadHash: seededRow.payloadHash,
      jobId: seeded.id,
    });
    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    calls = [];

    const specs = [
      { sku: "OK-A", id: 1 },
      { sku: "MISS-1", id: 2, uncertain: true },
      { sku: "EXISTS-1", id: 3, exists: "77" },
      { sku: "MISS-2", id: 4, uncertain: true },
      { sku: "MISS-3", id: 6, uncertain: true },
      { sku: "OFF-1", id: 7, inactive: true },
      { sku: "MISS-4", id: 8, uncertain: true },
      { sku: "NO-IMAGE", id: 9, noImage: true },
      { sku: "MISS-5", id: 10, uncertain: true },
      { sku: "REVIEW-1", id: 11, price: 0 },
      { sku: "OK-B", id: 12 },
    ];
    uncertainSkus = new Set();
    for (const spec of specs) {
      if (spec.uncertain) uncertainSkus.add(giniSkuKey(spec.sku));
      if (spec.exists) remote.set(giniSkuKey(spec.sku), { id: spec.exists, sku: spec.sku });
      await makeProduct({
        _id: catalogId(spec.id),
        itemCode: spec.sku,
        ibsherId: `streak-${spec.sku}`,
        isActive: !spec.inactive,
        price: spec.price,
        variants: spec.noImage
          ? [{ color: { en: "white" }, images: [], sizes: [{ size: "medium", stockQuantity: 5 }] }]
          : undefined,
      });
    }

    const job = await previewAll();
    const rows = await rowsFor(job);
    const bySku = Object.fromEntries(rows.map((row) => [row.sku, row]));
    assert.equal(job.status, "preview");
    assert.equal(job.processed, 12);
    assert.equal(job.total, 12);
    assert.equal(job.lookupUncertain, 5);
    assert.equal(job.readyCreate, 2);
    assert.equal(job.alreadyExists, 1);
    assert.equal(job.unchanged, 1);
    assert.equal(job.inactive, 1);
    assert.equal(job.blocked, 1);
    assert.equal(job.needsReview, 1);
    assert.equal(job.created, 0);
    assert.equal(rows.length, 12);
    assert.equal(bySku["OK-A"].classification, "READY_CREATE");
    assert.equal(bySku["OK-B"].classification, "READY_CREATE");
    assert.equal(bySku["EXISTS-1"].classification, "ALREADY_EXISTS");
    assert.equal(bySku["KEEP-1"].classification, "UNCHANGED");
    assert.equal(bySku["OFF-1"].classification, "INACTIVE");
    assert.equal(bySku["NO-IMAGE"].classification, "BLOCKED");
    assert.equal(bySku["NO-IMAGE"].blockers.includes("missing_image"), true);
    assert.equal(bySku["REVIEW-1"].classification, "NEEDS_REVIEW");
    for (const sku of ["MISS-1", "MISS-2", "MISS-3", "MISS-4", "MISS-5"]) {
      assert.equal(bySku[sku].classification, "LOOKUP_UNCERTAIN");
      assert.equal(bySku[sku].blockers.includes("gini_lookup_failed"), true);
      assert.equal(bySku[sku].giniProductId, "");
    }
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncSendState.countDocuments({ sku: { $in: ["MISS-1", "MISS-2", "MISS-3", "MISS-4", "MISS-5"] } }), 0);
  });

  it("pauses on five consecutive lookup failures and resumes the same preview from its cursor", async () => {
    const skus = ["OK-A", "OK-B", "E-1", "E-2", "E-3", "E-4", "E-5", "OK-C", "OK-D"];
    uncertainSkus = new Set(["E-1", "E-2", "E-3", "E-4", "E-5"].map((sku) => giniSkuKey(sku)));
    for (let index = 0; index < skus.length; index += 1) {
      await makeProduct({ _id: catalogId(index + 1), itemCode: skus[index], ibsherId: `run-${skus[index]}` });
    }
    await mapCollection();
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const paused = (await getLatestGiniSyncJob()).job;
    const products = await Product.find().sort({ _id: 1 }).select("_id itemCode").lean();
    assert.deepEqual(
      products.map((item) => item.itemCode),
      skus
    );
    const fifthUncertain = String(products[6]._id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.processed, 7);
    assert.equal(paused.total, 9);
    assert.equal(paused.readyCreate, 2);
    assert.equal(paused.lookupUncertain, 5);
    assert.equal(paused.created, 0);
    assert.equal(paused.cursorProductId, fifthUncertain);
    assert.equal(posts().length, 0);
    const pausedRows = await GiniSyncProductResult.find({ jobId: paused.id }).lean();
    assert.equal(pausedRows.length, 7);
    const pausedBySku = Object.fromEntries(pausedRows.map((row) => [row.sku, row]));
    assert.equal(pausedBySku["OK-A"].classification, "READY_CREATE");
    assert.equal(pausedBySku["OK-B"].classification, "READY_CREATE");
    for (const sku of ["E-1", "E-2", "E-3", "E-4", "E-5"]) {
      assert.equal(pausedBySku[sku].classification, "LOOKUP_UNCERTAIN");
      assert.equal(pausedBySku[sku].blockers.includes("gini_lookup_failed"), true);
      assert.equal(pausedBySku[sku].giniProductId, "");
    }
    assert.equal(pausedRows.some((row) => row.sku === "OK-C" || row.sku === "OK-D"), false);
    const savedIds = new Map(pausedRows.map((row) => [row.productId, String(row._id)]));
    await rejectsCode(runGiniSyncPreview, "sync_active");
    await rejectsCode(
      () =>
        startGiniSyncAll({
          confirm: true,
          previewJobId: paused.id,
          catalogSignature: paused.catalogSignature,
          expectedReady: paused.readyCreate,
          scope: "full",
          approveFullRun: true,
        }),
      "preview_required"
    );

    const signature = paused.catalogSignature;
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    const doneRows = await rowsFor(done);
    const doneBySku = Object.fromEntries(doneRows.map((row) => [row.sku, row]));
    assert.equal(done.id, paused.id);
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 9);
    assert.equal(done.total, 9);
    assert.equal(done.readyCreate, 4);
    assert.equal(done.lookupUncertain, 5);
    assert.equal(done.created, 0);
    assert.equal(done.catalogSignature, signature);
    assert.equal(done.cursorProductId, String(products[8]._id));
    assert.equal(doneRows.length, 9);
    assert.equal(new Set(doneRows.map((row) => row.productId)).size, 9);
    for (const [productId, id] of savedIds) {
      assert.equal(String(doneBySku[pausedRows.find((row) => row.productId === productId).sku]._id), id);
    }
    for (const sku of ["E-1", "E-2", "E-3", "E-4", "E-5"]) {
      assert.equal(doneBySku[sku].classification, "LOOKUP_UNCERTAIN");
      assert.equal(doneBySku[sku].blockers.includes("gini_lookup_failed"), true);
      assert.equal(doneBySku[sku].giniProductId, "");
    }
    assert.equal(doneBySku["OK-A"].classification, "READY_CREATE");
    assert.equal(doneBySku["OK-B"].classification, "READY_CREATE");
    assert.equal(doneBySku["OK-C"].classification, "READY_CREATE");
    assert.equal(doneBySku["OK-D"].classification, "READY_CREATE");
    for (const product of products.slice(7)) {
      assert.equal(String(product._id) > fifthUncertain, true);
      assert.equal(doneBySku[product.itemCode].classification, "READY_CREATE");
    }
    const lookedUp = productGets().map((item) => skuFromProductUrl(item.url));
    assert.deepEqual(lookedUp.filter((sku) => skus.includes(sku)).sort(), ["OK-C", "OK-D"]);
    assert.equal(posts().length, 0);

    calls = [];
    const synced = await runSync(done);
    const sent = posts().map((item) => formFields(item.options).sku);
    assert.deepEqual(sent, ["OK-A", "OK-B", "OK-C", "OK-D"]);
    assert.equal(synced.created, 4);
    const syncedBySku = Object.fromEntries((await rowsFor(synced)).map((row) => [row.sku, row]));
    for (const sku of ["E-1", "E-2", "E-3", "E-4", "E-5"]) {
      assert.equal(syncedBySku[sku].classification, "BLOCKED");
      assert.equal(syncedBySku[sku].errorCode, "not_in_approved_preview");
    }
    const preserved = await GiniSyncProductResult.find({ jobId: done.id }).lean();
    const preservedBySku = Object.fromEntries(preserved.map((row) => [row.sku, row]));
    for (const sku of ["E-1", "E-2", "E-3", "E-4", "E-5"]) {
      assert.equal(preservedBySku[sku].classification, "LOOKUP_UNCERTAIN");
      assert.equal(preservedBySku[sku].blockers.includes("gini_lookup_failed"), true);
      assert.equal(String(preservedBySku[sku]._id), savedIds.get(preservedBySku[sku].productId));
    }
    assert.equal(await GiniSyncSendState.countDocuments({ sku: { $in: ["E-1", "E-2", "E-3", "E-4", "E-5"] } }), 0);
  });

  it("recovers a stale runner without creating an accepted SKU again", async () => {
    await makeProduct({ itemCode: "RECOVER-1" });
    await makeProduct({ itemCode: "RECOVER-2" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    const preview = await previewAll();
    let paused = false;
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1 && !paused) {
        paused = true;
        await pauseGiniSyncAll();
      }
    });
    enableWrites();
    await startGiniSyncAll({
      confirm: true,
      previewJobId: preview.id,
      catalogSignature: preview.catalogSignature,
      expectedReady: preview.readyCreate,
      scope: "full",
      approveFullRun: true,
    });
    await waitForGiniBulkIdle();
    const job = await GiniSyncJob.findOne({ mode: "sync" });
    assert.equal(job.status, "paused");
    assert.equal(job.created, 1);
    assert.equal(posts().length, 1);
    await GiniSyncJob.updateOne(
      { _id: job._id },
      {
        $set: {
          status: "running",
          runnerToken: "dead",
          heartbeatAt: new Date(Date.now() - 60000),
        },
      }
    );
    await ensureGiniSyncRunner();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    const sentSkus = posts().map((item) => formFields(item.options).sku);
    assert.equal(done.status, "completed");
    assert.equal(done.created, 2);
    assert.deepEqual(sentSkus, ["RECOVER-1", "RECOVER-2"]);
    assert.equal(await GiniSyncSendState.countDocuments(), 2);
  });

  it("does not run two bulk senders at once", async () => {
    await makeProduct({ itemCode: "ONCE-1" });
    await mapCollection();
    const preview = await previewAll();
    let release;
    let entered;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const seen = new Promise((resolve) => {
      entered = resolve;
    });
    setGiniBulkBeforeSend(async () => {
      entered();
      await gate;
    });
    enableWrites();
    await startGiniSyncAll({
      confirm: true,
      previewJobId: preview.id,
      catalogSignature: preview.catalogSignature,
      expectedReady: preview.readyCreate,
      scope: "limited",
      limit: 1,
    });
    await seen;
    await rejectsCode(
      () =>
        startGiniSyncAll({
          confirm: true,
          previewJobId: preview.id,
          catalogSignature: preview.catalogSignature,
          expectedReady: preview.readyCreate,
          scope: "full",
          approveFullRun: true,
        }),
      "sync_active"
    );
    await getLatestGiniSyncJob();
    release();
    await waitForGiniBulkIdle();
    assert.equal(posts().length, 1);
    assert.equal((await getLatestGiniSyncJob()).job.created, 1);
  });

  it("serves the admin sync routes and does not start a send by itself", async () => {
    const hidden = await call("GET", "/api/admin/platforms/gini/sync-all", { auth: false });
    assert.equal(hidden.status, 401);
    await makeProduct({ itemCode: "HTTP-1" });
    await mapCollection();
    const started = await call("POST", "/api/admin/platforms/gini/sync-all/preview");
    assert.equal(started.status, 200);
    assert.equal(started.json.dryRun, true);
    assert.equal(started.json.sentToGini, 0);
    await waitForGiniBulkIdle();
    const status = await call("GET", "/api/admin/platforms/gini/sync-all");
    assert.equal(status.json.job.status, "preview");
    assert.equal(status.json.writesEnabled, false);
    assert.equal(status.json.updatesSupported, false);
    assert.equal(status.json.sentToGini, 0);
    assert.equal(status.json.job.readyCreate, 1);
    const denied = await call("POST", "/api/admin/platforms/gini/sync-all/start", {
      body: {
        confirm: true,
        previewJobId: status.json.job.id,
        catalogSignature: status.json.job.catalogSignature,
        expectedReady: status.json.job.readyCreate,
        scope: "full",
        approveFullRun: true,
      },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.json.code, "bulk_writes_disabled");
    assert.equal(posts().length, 0);
    assertNoSecret(status.json);
  });

  it("refuses Full Preview before any batch when the saved GINI secret cannot be read", async () => {
    await makeProduct({ itemCode: "UNREADABLE-1" });
    const previous = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "gini-sync-all-other-seal";
    const sealed = encryptApiKey("temporary-unread-secret");
    process.env.JWT_SECRET = previous;
    await GiniConnection.updateOne(
      { singletonKey: "default" },
      { $set: { clientSecretEnc: sealed, hasSecret: true, lastStatus: "connected" } }
    );
    try {
      const response = await call("POST", "/api/admin/platforms/gini/sync-all/preview");
      assert.equal(response.status, 409);
      assert.equal(response.json.code, "secret_unreadable");
      assert.match(response.json.message, /could not be read/);
      assert.equal(response.json.message.includes(sealed), false);
      assert.equal(await GiniSyncJob.countDocuments(), 0);
      assert.equal(calls.length, 0);
      assert.equal(posts().length, 0);
    } finally {
      await connectGini();
    }
  });

  it("shows a failed preview error code and message without secrets", async () => {
    const job = await GiniSyncJob.create({
      partner: "gini",
      status: "failed",
      mode: "preview",
      runScope: "preview",
      total: 42317,
      processed: 0,
      lastError: "The saved GINI client secret could not be read. Save the GINI API connection again.",
      errorCode: "secret_unreadable",
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    const status = await call("GET", "/api/admin/platforms/gini/sync-all");
    assert.equal(status.status, 200);
    assert.equal(status.json.job.id, String(job._id));
    assert.equal(status.json.job.status, "failed");
    assert.equal(status.json.job.processed, 0);
    assert.equal(status.json.job.errorCode, "secret_unreadable");
    assert.match(status.json.job.lastError, /could not be read/);
    assert.equal(status.json.writesEnabled, false);
    assert.equal(posts().length, 0);
    assertNoSecret(status.json);
  });

  it("returns a completed full sync on refresh and reload without starting another send", async () => {
    const preview = await GiniSyncJob.create({
      partner: "gini",
      status: "preview",
      mode: "preview",
      runScope: "preview",
      total: 42316,
      processed: 42316,
      readyCreate: 57,
      created: 0,
      finishedAt: new Date("2026-11-02T11:30:45.136Z"),
    });
    const sync = await GiniSyncJob.create({
      partner: "gini",
      status: "completed",
      mode: "sync",
      runScope: "full",
      previewJobId: String(preview._id),
      total: 42316,
      processed: 42316,
      created: 57,
      failed: 0,
      createUncertain: 0,
      approveFullRun: true,
      finishedAt: new Date("2026-11-02T11:35:20.425Z"),
    });
    const first = await call("GET", "/api/admin/platforms/gini/sync-all");
    const second = await call("GET", "/api/admin/platforms/gini/sync-all");
    const shown = selectGiniSyncDisplay(first.json);
    assert.equal(first.status, 200);
    assert.equal(first.json.job.id, String(sync._id));
    assert.equal(first.json.job.status, "completed");
    assert.equal(first.json.job.mode, "sync");
    assert.equal(first.json.job.created, 57);
    assert.equal(first.json.job.failed, 0);
    assert.equal(first.json.job.createUncertain, 0);
    assert.equal(first.json.preview.id, String(preview._id));
    assert.equal(first.json.preview.mode, "preview");
    assert.equal(first.json.preview.readyCreate, 57);
    assert.equal(first.json.preview.created, 0);
    assert.equal(first.json.sentToGini, 57);
    assert.equal(second.json.job.id, first.json.job.id);
    assert.equal(second.json.job.status, "completed");
    assert.equal(second.json.job.created, 57);
    assert.equal(shown.current.status, "completed");
    assert.equal(confirmedCreateCount(shown.current), 57);
    assert.equal(shown.preview.readyCreate, 57);
    assert.equal(confirmedCreateCount(shown.preview), 0);
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncJob.countDocuments({ status: { $in: ["running", "preview_running"] } }), 0);
    assertNoSecret(first.json);
  });

  it("keeps a missing historical send out of the create set and does not overwrite it", async () => {
    const product = await makeProduct({ itemCode: "LP-ID141232" });
    await mapCollection();
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(product._id),
      sku: "LP-ID141232",
      skuKey: giniSkuKey("LP-ID141232"),
      giniProductId: "521043",
      jobId: "historical-preview",
    });
    const preview = await previewAll();
    const row = (await rowsFor(preview))[0];
    assert.equal(row.classification, "RECONCILE");
    assert.equal(row.errorCode, "confirmed_send_missing");
    assert.equal(row.giniProductId, "521043");
    assert.equal(preview.readyCreate, 0);
    assert.equal(preview.alreadyExists, 0);
    assert.equal(preview.reconcile, 1);
    assert.equal(posts().length, 0);
    enableWrites();
    await rejectsCode(
      () =>
        startGiniSyncAll({
          confirm: true,
          previewJobId: preview.id,
          catalogSignature: preview.catalogSignature,
          expectedReady: preview.readyCreate,
          scope: "full",
          approveFullRun: true,
        }),
      "nothing_to_send"
    );
    assert.equal(posts().length, 0);
    const kept = await GiniSyncSendState.findOne({ skuKey: giniSkuKey("LP-ID141232") }).lean();
    assert.equal(kept.giniProductId, "521043");
    assert.equal(kept.sku, "LP-ID141232");
    assert.equal(kept.jobId, "historical-preview");
    const status = await call("GET", "/api/admin/platforms/gini/sync-all");
    const warnings = reconciliationWarnings(status.json, status.json.job);
    assert.equal(
      warnings.some((item) => item.sku === "LP-ID141232" && item.code === "confirmed_send_missing" && item.giniProductId === "521043"),
      true
    );
    assert.equal((await Product.findById(product._id).lean()).price, 6500);
    assert.equal(posts().length, 0);
  });

  it("keeps confirmed sends out of a mixed ready set and posts only the new SKU", async () => {
    const confirmed = await makeProduct({ itemCode: "CONFIRMED-KEEP" });
    const historical = await makeProduct({ itemCode: "LP-ID141232" });
    const fresh = await makeProduct({ itemCode: "NEW-READY" });
    await mapCollection();
    const confirmedAt = new Date("2026-11-02T11:35:20.425Z");
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(confirmed._id),
      sku: "CONFIRMED-KEEP",
      skuKey: giniSkuKey("CONFIRMED-KEEP"),
      giniProductId: "566640",
      payloadHash: "saved-hash",
      jobId: "confirmed-full-sync",
      confirmedAt,
    });
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(historical._id),
      sku: "LP-ID141232",
      skuKey: giniSkuKey("LP-ID141232"),
      giniProductId: "521043",
      jobId: "historical-preview",
      confirmedAt,
    });
    const preview = await previewAll();
    const rows = await rowsFor(preview);
    const ready = rows.filter((row) => row.classification === "READY_CREATE").map((row) => row.sku);
    assert.deepEqual(ready, ["NEW-READY"]);
    assert.equal(rows.find((row) => row.sku === "CONFIRMED-KEEP")?.classification, "RECONCILE");
    assert.equal(rows.find((row) => row.sku === "CONFIRMED-KEEP")?.errorCode, "confirmed_send_missing");
    assert.equal(rows.find((row) => row.sku === "LP-ID141232")?.classification, "RECONCILE");
    assert.equal(rows.find((row) => row.sku === "LP-ID141232")?.giniProductId, "521043");
    assert.equal(preview.readyCreate, 1);
    assert.equal(preview.alreadyExists, 0);
    const sync = await runSync(preview);
    const posted = posts().map((item) => formFields(item.options).sku);
    assert.deepEqual(posted, ["NEW-READY"]);
    assert.equal(sync.created, 1);
    const kept = await GiniSyncSendState.findOne({ sku: "CONFIRMED-KEEP" }).lean();
    assert.equal(kept.giniProductId, "566640");
    assert.equal(kept.jobId, "confirmed-full-sync");
    assert.equal(kept.payloadHash, "saved-hash");
    assert.equal(kept.confirmedAt.toISOString(), "2026-11-02T11:35:20.425Z");
    assert.equal(kept.resyncHistory?.length || 0, 0);
    const historicalKept = await GiniSyncSendState.findOne({ sku: "LP-ID141232" }).lean();
    assert.equal(historicalKept.giniProductId, "521043");
    assert.equal(historicalKept.jobId, "historical-preview");
    assert.equal((await Product.findById(confirmed._id).lean()).price, 6500);
    assert.equal((await Product.findById(fresh._id).lean()).price, 6500);
  });

  it("does not resend a saved product after GINI stops returning it", async () => {
    const product = await makeProduct({ itemCode: "SAVED-GONE" });
    await mapCollection();
    const preview = await previewAll();
    assert.equal(preview.readyCreate, 1);
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(product._id),
      sku: "SAVED-GONE",
      skuKey: giniSkuKey("SAVED-GONE"),
      giniProductId: "522091",
      jobId: "historical-preview",
    });
    const sync = await runSync(preview);
    const row = (await rowsFor(sync))[0];
    assert.equal(sync.status, "completed");
    assert.equal(sync.created, 0);
    assert.equal(row.classification, "RECONCILE");
    assert.equal(row.errorCode, "confirmed_send_missing");
    assert.equal(posts().length, 0);
    const kept = await GiniSyncSendState.findOne({ skuKey: giniSkuKey("SAVED-GONE") }).lean();
    assert.equal(kept.giniProductId, "522091");
    assert.equal(kept.jobId, "historical-preview");
    assert.equal((await Product.findById(product._id).lean()).price, 6500);
  });

  it("does not adopt a different live id over a saved GINI id", async () => {
    const product = await makeProduct({ itemCode: "LP-ID141232" });
    await mapCollection();
    remote.set(giniSkuKey("LP-ID141232"), { id: "999", sku: "LP-ID141232" });
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(product._id),
      sku: "LP-ID141232",
      skuKey: giniSkuKey("LP-ID141232"),
      giniProductId: "521043",
      jobId: "historical-preview",
    });
    const preview = await previewAll();
    const row = (await rowsFor(preview))[0];
    assert.equal(row.classification, "RECONCILE");
    assert.equal(row.errorCode, "confirmed_send_id_mismatch");
    assert.equal(row.giniProductId, "521043");
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ skuKey: giniSkuKey("LP-ID141232") }).lean()).giniProductId, "521043");
  });

  it("does not count an unreadable saved send as a product currently on GINI", async () => {
    const product = await makeProduct({ itemCode: "E6310221" });
    await mapCollection();
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(product._id),
      sku: "E6310221",
      skuKey: giniSkuKey("E6310221"),
      giniProductId: "522091",
      jobId: "historical-preview",
    });
    lookupMode = "error";
    const preview = await previewAll();
    const row = (await rowsFor(preview))[0];
    assert.equal(preview.status, "preview");
    assert.equal(row.classification, "RECONCILE");
    assert.equal(row.errorCode, "confirmed_send_unverified");
    assert.equal(row.giniProductId, "522091");
    assert.equal(preview.alreadyExists, 0);
    assert.equal(preview.readyCreate, 0);
    assert.equal(posts().length, 0);
    assert.equal((await GiniSyncSendState.findOne({ skuKey: giniSkuKey("E6310221") }).lean()).giniProductId, "522091");
  });

  it("processes more than 30000 catalog rows in bounded batches without product lookups or writes", { timeout: 300000 }, async () => {
    const total = 30001;
    for (let offset = 0; offset < total; offset += 2000) {
      const chunk = [];
      const end = Math.min(total, offset + 2000);
      for (let index = offset; index < end; index += 1) {
        chunk.push({
          ibsherId: `bulk-${index}`,
          itemCode: "",
          price: 0,
          isActive: true,
          variants: [],
        });
      }
      await Product.insertMany(chunk, { ordered: false });
    }
    const job = await previewAll();
    const sizes = giniBulkBatchSizes();
    assert.equal(job.status, "preview");
    assert.equal(job.total, total);
    assert.equal(job.processed, total);
    assert.equal(job.blocked, total);
    assert.equal(job.eligible, 0);
    assert.equal(job.readyCreate, 0);
    assert.equal(job.inactive, 0);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), total);
    assert.equal(Math.max(...sizes) <= 100, true);
    assert.equal(giniBulkSkuIndexScans(), 1);
    assert.equal(giniBulkRemoteLookups(), 0);
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: job.id }), total);
    assert.equal(await Product.countDocuments(), total);
  });

  it("pauses a category edge block without retrying, then resumes without creating products", async () => {
    categoryMode = "edge";
    await makeProduct({ itemCode: "EDGE-CAT" });
    await mapCollection();
    const blocked = await startPreview();
    assert.equal(blocked.status, "edge_blocked");
    assert.equal(blocked.errorCode, "categories_unavailable");
    assert.equal(blocked.failureClass, "edge_blocked");
    assert.equal(blocked.lastHttpStatus, 403);
    assert.match(blocked.lastError, /HTTP 403, edge_blocked/);
    assertNoSecret(blocked);
    assert.equal(categoryGets().length, 1);
    assert.equal(blocked.processed, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: blocked.id }), 0);
    assertNoPreviewCreates(blocked);

    categoryMode = "";
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 1);
    assert.equal(done.created, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: done.id }), 1);
    assert.equal(posts().length, 0);
    assert.equal(giniBulkWritesEnabled(), false);
  });

  it("does not retry a category authentication failure", async () => {
    categoryMode = "forbidden";
    await makeProduct({ itemCode: "FORBID-CAT" });
    await mapCollection();
    const blocked = await startPreview();
    assert.equal(blocked.status, "auth_failed");
    assert.equal(blocked.failureClass, "auth_failed");
    assert.equal(blocked.lastHttpStatus, 403);
    assert.equal(blocked.errorCode, "categories_unavailable");
    assertNoSecret(blocked);
    assert.equal(categoryGets().length, 1);
    assert.equal(blocked.processed, 0);
    assertNoPreviewCreates(blocked);

    categoryMode = "";
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.status, "preview");
    assert.equal(done.created, 0);
    assert.equal(posts().length, 0);
  });

  it("retries a category 429 using Retry-After and still creates nothing", async () => {
    categoryMode = "rate";
    categoryFailuresLeft = 1;
    await makeProduct({ itemCode: "RATE-CAT" });
    await mapCollection();
    const job = await startPreview();
    assert.equal(job.status, "preview");
    assert.equal(job.processed, 1);
    assert.equal(job.created, 0);
    assert.equal(categoryGets().length, 3);
    assertNoPreviewCreates(job);
    assert.equal(await GiniSyncSendState.countDocuments(), 0);
  });

  it("pauses after repeated category 429 responses instead of failing the preview", async () => {
    categoryMode = "rate";
    categoryFailuresLeft = 10;
    await makeProduct({ itemCode: "RATE-EXHAUST" });
    await mapCollection();
    const paused = await startPreview();
    assert.equal(paused.status, "rate_limited");
    assert.equal(paused.failureClass, "rate_limited");
    assert.equal(paused.lastHttpStatus, 429);
    assert.equal(paused.errorCode, "categories_unavailable");
    assertNoSecret(paused);
    assert.equal(categoryGets().length, GINI_CATEGORY_GET_ATTEMPTS);
    assert.equal(paused.processed, 0);
    assertNoPreviewCreates(paused);

    categoryMode = "";
    categoryFailuresLeft = 0;
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 1);
    assert.equal(done.created, 0);
    assert.equal(posts().length, 0);
  });

  it("retries category 500 responses and pauses only after they stay unavailable", async () => {
    categoryMode = "flaky";
    categoryFailuresLeft = 2;
    await makeProduct({ itemCode: "FLAKY-CAT" });
    await mapCollection();
    const recovered = await startPreview();
    assert.equal(recovered.status, "preview");
    assert.equal(recovered.processed, 1);
    assert.equal(categoryGets().length, 4);
    assertNoPreviewCreates(recovered);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    calls = [];
    categoryMode = "server";
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.notEqual(paused.status, "failed");
    assert.equal(paused.failureClass, "temporary");
    assert.equal(paused.lastHttpStatus, 500);
    assert.equal(paused.errorCode, "categories_unavailable");
    assert.match(paused.lastError, /HTTP 500, temporary/);
    assertNoSecret(paused);
    assert.equal(categoryGets().length, GINI_CATEGORY_GET_ATTEMPTS);
    assert.equal(paused.processed, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: paused.id }), 0);
    assertNoPreviewCreates(paused);

    categoryMode = "";
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.status, "preview");
    assert.equal(done.created, 0);
    assert.equal(posts().length, 0);
  });

  it("pauses a category timeout without treating it as a usable tree", async () => {
    categoryMode = "timeout";
    await makeProduct({ itemCode: "TIMEOUT-CAT" });
    await mapCollection();
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.failureClass, "temporary");
    assert.equal(paused.lastHttpStatus, 0);
    assert.match(paused.lastError, /no HTTP response, temporary/);
    assert.equal(paused.lastError.includes("aborted"), false);
    assertNoSecret(paused);
    assert.equal(categoryGets().length, GINI_CATEGORY_GET_ATTEMPTS);
    assert.equal(paused.processed, 0);
    assertNoPreviewCreates(paused);
  });

  it("pauses an invalid category body and does not classify products with it", async () => {
    categoryMode = "invalid";
    await makeProduct({ itemCode: "BAD-CAT" });
    await mapCollection();
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.failureClass, "categories_invalid");
    assert.equal(paused.lastHttpStatus, 200);
    assert.match(paused.lastError, /categories_invalid/);
    assertNoSecret(paused);
    assert.equal(categoryGets().length, 1);
    assert.equal(paused.processed, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: paused.id }), 0);
    assertNoPreviewCreates(paused);
  });

  it("pauses when category pagination does not finish", async () => {
    categoryMode = "incomplete";
    await makeProduct({ itemCode: "PAGE-CAT" });
    await mapCollection();
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.failureClass, "categories_incomplete");
    assert.equal(paused.lastHttpStatus, 200);
    assert.match(paused.lastError, /pagination did not finish/);
    assert.equal(categoryGets().length, GINI_CATEGORY_PAGE_LIMIT);
    assert.equal(paused.processed, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: paused.id }), 0);
    assert.equal(productGets().length, 0);
    assertNoPreviewCreates(paused);
  });

  it("pauses instead of going stale when the closing category read fails", async () => {
    categoryMode = "fail-after-first";
    await makeProduct({ itemCode: "END-CAT" });
    await mapCollection();
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.notEqual(paused.status, "failed");
    assert.notEqual(paused.status, "stale");
    assert.equal(paused.failureClass, "temporary");
    assert.equal(paused.processed, 1);
    assert.equal(categoryGets().length, 1 + GINI_CATEGORY_GET_ATTEMPTS);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: paused.id }), 1);
    assertNoPreviewCreates(paused);

    categoryMode = "";
    categoryReads = 0;
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    const rows = await rowsFor(done);
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 1);
    assert.equal(rows.length, 1);
    assert.equal(done.created, 0);
    assert.equal(posts().length, 0);
  });

  it("keeps one signature for the same categories and subcategories in any order", async () => {
    const original = normalizeGiniCategories(LIVE_TREE).categories;
    const reversedParents = normalizeGiniCategories({ data: [...LIVE_TREE.data].reverse() }).categories;
    const reversedSubs = normalizeGiniCategories(reorderedSubcategoriesTree()).categories;
    const reversedBoth = normalizeGiniCategories(reorderedLiveTree()).categories;
    const baseline = await catalogSignature(original);
    assert.equal(await catalogSignature(reversedParents), baseline);
    assert.equal(await catalogSignature(reversedSubs), baseline);
    assert.equal(await catalogSignature(reversedBoth), baseline);
    assert.deepEqual(
      categoryOptions(reversedParents, "").map((row) => String(row.id)),
      reversedParents.map((row) => String(row.id))
    );

    const input = [
      {
        id: "2",
        isActive: true,
        name: "Later parent",
        subcategories: [
          { id: "10", isActive: true, name: "Ten" },
          { id: "2", isActive: false, name: "Two" },
        ],
      },
      { id: "10", isActive: false, name: "Earlier parent", subcategories: [] },
    ];
    const snapshot = JSON.stringify(input);
    assert.deepEqual(
      canonicalGiniSignatureTree(input).map((row) => ({
        id: row.id,
        active: row.active,
        subs: row.subcategories.map((sub) => sub.id),
      })),
      [
        { id: "10", active: false, subs: [] },
        { id: "2", active: true, subs: ["10", "2"] },
      ]
    );
    assert.equal(JSON.stringify(input), snapshot);

    const conflict = [
      {
        id: "9",
        isActive: true,
        subcategories: [
          { id: "4", isActive: true },
          { id: "4", isActive: false },
        ],
      },
      { id: "9", isActive: false, subcategories: [{ id: "4", isActive: true }] },
    ];
    const conflictAgain = [
      conflict[1],
      { ...conflict[0], subcategories: [...conflict[0].subcategories].reverse() },
    ];
    const canonicalConflict = [
      { id: "9", active: false, subcategories: [{ id: "4", active: true }] },
      {
        id: "9",
        active: true,
        subcategories: [
          { id: "4", active: false },
          { id: "4", active: true },
        ],
      },
    ];
    assert.deepEqual(canonicalGiniSignatureTree(conflict), canonicalConflict);
    assert.deepEqual(canonicalGiniSignatureTree(conflictAgain), canonicalConflict);
    assert.equal(await catalogSignature(conflict), await catalogSignature(conflictAgain));
    assert.notEqual(await catalogSignature(conflict), await catalogSignature([conflict[1]]));

    const activeFlip = original.map((category) =>
      String(category.id) === "1" ? { ...category, isActive: !category.isActive } : category
    );
    const idChange = original.map((category) => (String(category.id) === "2" ? { ...category, id: 3 } : category));
    assert.notEqual(await catalogSignature(activeFlip), baseline);
    assert.notEqual(await catalogSignature(idChange), baseline);

    await mapCollection();
    const mapped = await catalogSignature(original);
    await mapCollection({
      categoryId: "2",
      categoryName: "Hidden",
      subcategoryId: "20",
      subcategoryName: "Archived",
    });
    assert.notEqual(await catalogSignature(original), mapped);
    await mapCollection();
    assert.equal(await catalogSignature(original), mapped);

    await Commission.create({ partner: "gini", scope: "all", targetId: "*", percentage: 12, isActive: true });
    assert.notEqual(await catalogSignature(original), mapped);
    await Commission.deleteMany({ partner: "gini" });
    assert.equal(await catalogSignature(original), mapped);

    await makeProduct({ itemCode: "BOUND-HASH", ibsherId: "bound-hash" });
    assert.notEqual(await catalogSignature(original), mapped);
    await Product.deleteMany({ itemCode: "BOUND-HASH" });
    assert.equal(await catalogSignature(original), mapped);

    await PlatformVisibilityRule.create({
      partner: "gini",
      scope: "brand",
      targetId: "brand-order",
      isActive: false,
    });
    assert.notEqual(await catalogSignature(original), mapped);
    await PlatformVisibilityRule.deleteMany({ partner: "gini" });
    assert.equal(await catalogSignature(original), mapped);

    try {
      invalidateCatalogBlockCache();
      await CatalogBlock.create({ vendorId: "vendor-order", brandId: "brand-order" });
      invalidateCatalogBlockCache();
      assert.notEqual(await catalogSignature(original), mapped);
    } finally {
      await CatalogBlock.deleteMany({ vendorId: "vendor-order" });
      invalidateCatalogBlockCache();
    }
    assert.equal(await catalogSignature(original), mapped);
  });

  it("resumes a paused preview when only category and subcategory order changes", async () => {
    await makeProduct({ itemCode: "ORDER-1", ibsherId: "order-1" });
    await makeProduct({ itemCode: "ORDER-2", ibsherId: "order-2" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await pauseGiniSyncAll();
    });
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.processed, 1);
    setGiniBulkAfterProduct(null);
    categoryMode = "reordered";
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.id, paused.id);
    assert.equal(done.status, "preview");
    assert.equal(done.processed, 2);
    assert.equal(done.catalogSignature, paused.catalogSignature);
    assert.equal(await catalogSignature(normalizeGiniCategories(reorderedLiveTree()).categories), paused.catalogSignature);
    assert.equal(done.created, 0);
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: done.id }), 2);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    calls = [];
    categoryMode = "";
    await makeProduct({ itemCode: "ORDER-3", ibsherId: "order-3" });
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await pauseGiniSyncAll();
    });
    const subsPaused = await startPreview();
    setGiniBulkAfterProduct(null);
    categoryMode = "reordered-subs";
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const subsDone = (await getLatestGiniSyncJob()).job;
    assert.equal(subsDone.id, subsPaused.id);
    assert.equal(subsDone.status, "preview");
    assert.equal(subsDone.processed, 3);
    assert.equal(subsDone.catalogSignature, subsPaused.catalogSignature);
    assert.equal(
      await catalogSignature(normalizeGiniCategories(reorderedSubcategoriesTree()).categories),
      subsPaused.catalogSignature
    );
    assert.equal(subsDone.created, 0);
    assert.equal(posts().length, 0);
  });

  it("marks a preview stale when a category id or active flag changes", async () => {
    const activePaused = await pausePreviewAfterFirst("ACTIVE-STALE");
    categoryMode = "inactive-home";
    await assertResumeStale(activePaused);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    calls = [];
    categoryMode = "";
    const idPaused = await pausePreviewAfterFirst("ID-STALE");
    categoryMode = "replaced-id";
    await assertResumeStale(idPaused);
  });

  it("marks a preview stale when mappings, commission, or product bounds change", async () => {
    const mapped = await pausePreviewAfterFirst("MAP-STALE");
    await mapCollection({
      categoryId: "2",
      categoryName: "Hidden",
      subcategoryId: "20",
      subcategoryName: "Archived",
    });
    await assertResumeStale(mapped);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    await mapCollection();
    calls = [];
    const ruled = await pausePreviewAfterFirst("RULE-STALE");
    await Commission.create({ partner: "gini", scope: "all", targetId: "*", percentage: 12, isActive: true });
    await assertResumeStale(ruled);

    await GiniSyncJob.deleteMany({});
    await GiniSyncProductResult.deleteMany({});
    await Commission.deleteMany({ partner: "gini" });
    calls = [];
    const bounded = await pausePreviewAfterFirst("BOUND-STALE");
    await makeProduct({ itemCode: "BOUND-STALE-2", ibsherId: "bound-stale-2" });
    await assertResumeStale(bounded);
  });

  it("keeps the saved category signature when a resumed preview sees a different tree", async () => {
    await makeProduct({ itemCode: "SIG-1" });
    await makeProduct({ itemCode: "SIG-2" });
    await makeProduct({ itemCode: "SIG-3" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await pauseGiniSyncAll();
    });
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.processed, 1);
    const signature = paused.catalogSignature;
    setGiniBulkAfterProduct(null);
    categoryMode = "shifted";
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const stale = (await getLatestGiniSyncJob()).job;
    assert.equal(stale.status, "stale");
    assert.equal(stale.errorCode, "preview_stale");
    assert.equal(stale.lastError, "The catalog changed during Full Preview. Run Full Preview again.");
    assert.equal(stale.catalogSignature, signature);
    assert.equal(stale.processed, 1);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: stale.id }), 1);
    assert.equal(stale.created, 0);
    assert.equal(posts().length, 0);
    assert.equal(giniBulkWritesEnabled(), false);
  });

  it("reacquires a running preview and pauses on a category block instead of failing", async () => {
    await makeProduct({ itemCode: "REACQUIRE-1" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await pauseGiniSyncAll();
    });
    const paused = await startPreview();
    assert.equal(paused.status, "paused");
    assert.equal(paused.processed, 1);
    setGiniBulkAfterProduct(null);
    categoryMode = "edge";
    calls = [];
    await GiniSyncJob.updateOne(
      { _id: paused.id },
      { $set: { status: "preview_running", runnerToken: "dead", heartbeatAt: new Date(Date.now() - 60000) } }
    );
    await ensureGiniSyncRunner();
    await waitForGiniBulkIdle();
    const blocked = (await getLatestGiniSyncJob()).job;
    assert.equal(blocked.status, "edge_blocked");
    assert.notEqual(blocked.status, "failed");
    assert.equal(blocked.processed, 1);
    assert.equal(blocked.lastHttpStatus, 403);
    assert.equal(blocked.failureClass, "edge_blocked");
    assert.equal(categoryGets().length, 1);
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: blocked.id }), 1);
    assertNoPreviewCreates(blocked);
  });

  it("leaves an unexpected preview crash failed and not resumable", async () => {
    await makeProduct({ itemCode: "CRASH-1" });
    await mapCollection();
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async () => {
      throw new Error("preview worker crashed");
    });
    const failed = await startPreview();
    assert.equal(failed.status, "failed");
    assert.equal(failed.errorCode, "gini_sync_failed");
    assert.equal(failed.processed, 1);
    assertNoPreviewCreates(failed);
    await rejectsCode(resumeGiniSyncAll, "not_paused");
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: failed.id }), 1);
    assert.equal(posts().length, 0);
  });

  it("refuses to resume a failed preview whose cursor would skip products", async () => {
    const first = await makeProduct({ itemCode: "HOLE-1" });
    const second = await makeProduct({ itemCode: "HOLE-2" });
    await mapCollection();
    const [earlier, later] = [first, second].sort((left, right) => String(left._id).localeCompare(String(right._id)));
    const job = await GiniSyncJob.create({
      partner: "gini",
      status: "failed",
      mode: "preview",
      runScope: "preview",
      total: 2,
      processed: 1,
      cursorProductId: String(later._id),
      catalogSignature: "signature-without-a-complete-prefix",
      errorCode: "categories_unavailable",
      lastError: "Could not load GINI categories.",
      finishedAt: new Date(),
      created: 0,
    });
    await GiniSyncProductResult.create({
      jobId: job._id,
      partner: "gini",
      productId: String(later._id),
      sku: later.itemCode,
      classification: "READY_CREATE",
    });
    assert.notEqual(String(earlier._id), String(later._id));
    await rejectsCode(resumeGiniSyncAll, "preview_not_resumable");
    const fresh = await GiniSyncJob.findById(job._id).lean();
    assert.equal(fresh.status, "failed");
    assert.equal(await GiniSyncProductResult.countDocuments({ jobId: job._id }), 1);
    assert.equal(posts().length, 0);
    assert.equal(giniBulkWritesEnabled(), false);
  });

  it("refuses to resume a failed preview that has progress but no category signature", async () => {
    const product = await makeProduct({ itemCode: "NOSIG-1" });
    await mapCollection();
    const job = await GiniSyncJob.create({
      partner: "gini",
      status: "failed",
      mode: "preview",
      runScope: "preview",
      total: 1,
      processed: 1,
      cursorProductId: String(product._id),
      catalogSignature: "",
      errorCode: "categories_unavailable",
      lastError: "Could not load GINI categories.",
      finishedAt: new Date(),
      created: 0,
    });
    await GiniSyncProductResult.create({
      jobId: job._id,
      partner: "gini",
      productId: String(product._id),
      sku: "NOSIG-1",
      classification: "READY_CREATE",
    });
    await rejectsCode(resumeGiniSyncAll, "preview_not_resumable");
    assert.equal((await GiniSyncJob.findById(job._id).lean()).status, "failed");
    assert.equal(posts().length, 0);
  });

  it("resumes a failed 1113 of 40199 preview from its cursor without duplicating rows or creating products", async () => {
    const totalInFixture = 1116;
    const docs = [];
    for (let index = 0; index < totalInFixture; index += 1) {
      docs.push({
        ibsherId: `ibs-preview-${index}`,
        itemCode: `PREV-${index}`,
        name: { en: `Preview ${index}`, ar: `Preview ${index}`, ku: `Preview ${index}` },
        description: { en: "Covers a blemish.", ar: "لصقات", ku: "پەچە" },
        price: 6500,
        brand: { _id: "brand-cosrx", name: "COSRX" },
        category: { _id: "cat-beauty", name: { en: "Beauty & Personal Care" } },
        subCategory: { _id: "sub-skin", name: { en: "Skin Care" } },
        collectionName: { _id: "col-acne", name: { en: "Acne Patches" } },
        isActive: true,
        variants: simpleVariant(5),
      });
    }
    await Product.insertMany(docs);
    await mapCollection();
    setGiniBulkBatchSize(1);
    setGiniBulkAfterProduct(async ({ processed }) => {
      if (processed === 1) await pauseGiniSyncAll();
    });
    const started = await startPreview();
    assert.equal(started.status, "paused");
    assert.equal(started.processed, 1);
    setGiniBulkAfterProduct(null);

    const products = await Product.find().sort({ _id: 1 }).select("_id itemCode").lean();
    assert.equal(products.length, totalInFixture);
    const firstRow = await GiniSyncProductResult.findOne({ jobId: started.id }).lean();
    assert.equal(firstRow.productId, String(products[0]._id));
    assert.equal(firstRow.classification, "READY_CREATE");
    const rest = products.slice(1, 1113);
    assert.equal(rest.length, 1112);
    await GiniSyncProductResult.insertMany(
      rest.map((product, index) => {
        let classification = "READY_CREATE";
        let blockers = [];
        if (index === 1080) {
          classification = "ALREADY_EXISTS";
          blockers = ["existing_gini_product"];
        } else if (index > 1080) {
          classification = "BLOCKED";
          blockers = ["missing_mapping"];
        }
        return {
          jobId: started.id,
          partner: "gini",
          productId: String(product._id),
          sku: product.itemCode,
          classification,
          blockers,
        };
      })
    );
    const signature = started.catalogSignature;
    await GiniSyncJob.updateOne(
      { _id: started.id },
      {
        $set: {
          status: "failed",
          total: 40199,
          processed: 1113,
          readyCreate: 1081,
          alreadyExists: 1,
          blocked: 31,
          created: 0,
          cursorProductId: String(products[1112]._id),
          errorCode: "categories_unavailable",
          lastError: "Could not load GINI categories.",
          finishedAt: new Date(),
          runnerToken: "",
        },
      }
    );
    const failed = await GiniSyncJob.findById(started.id).lean();
    assert.equal(failed.status, "failed");
    assert.equal(failed.total, 40199);
    assert.equal(failed.processed, 1113);
    assert.equal(failed.readyCreate, 1081);
    assert.equal(failed.alreadyExists, 1);
    assert.equal(failed.created, 0);
    assert.equal(failed.readyCreate + failed.alreadyExists + failed.blocked, 1113);
    assert.equal(await Product.countDocuments(), totalInFixture);
    const seeded = await GiniSyncProductResult.find({ jobId: started.id }).select("productId classification").lean();
    assert.equal(seeded.length, 1113);
    const seededClass = new Map(seeded.map((row) => [row.productId, row.classification]));

    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    const rows = await rowsFor(done);
    assert.equal(done.status, "preview");
    assert.equal(done.total, 40199);
    assert.equal(done.processed, totalInFixture);
    assert.equal(done.created, 0);
    assert.equal(done.catalogSignature, signature);
    assert.equal(rows.length, totalInFixture);
    assert.equal(new Set(rows.map((row) => row.productId)).size, totalInFixture);
    for (const [productId, classification] of seededClass) {
      assert.equal(rows.find((row) => row.productId === productId).classification, classification);
    }
    for (const product of products.slice(1113)) {
      assert.equal(rows.some((row) => row.productId === String(product._id)), true);
    }
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncSendState.countDocuments(), 0);
    assert.equal(giniBulkWritesEnabled(), false);
  });

  it("does not start Full Sync or create a product when the pre-send category read is blocked", async () => {
    await makeProduct({ itemCode: "PRESEND-1" });
    await mapCollection();
    const preview = await previewAll();
    categoryMode = "edge";
    calls = [];
    enableWrites();
    await assert.rejects(
      () =>
        startGiniSyncAll({
          confirm: true,
          previewJobId: preview.id,
          catalogSignature: preview.catalogSignature,
          expectedReady: preview.readyCreate,
          scope: "full",
          approveFullRun: true,
        }),
      (err) => {
        assert.equal(err.code, "categories_unavailable");
        assert.equal(err.httpStatus, 403);
        assert.equal(err.failureClass, "edge_blocked");
        assertNoSecret({ message: err.message });
        return true;
      }
    );
    assert.equal(categoryGets().length, 1);
    assert.equal(posts().length, 0);
    assert.equal(await GiniSyncJob.countDocuments({ mode: "sync" }), 0);
    delete process.env.GINI_BULK_WRITES_ENABLED;
    delete process.env.GINI_ALLOW_LIVE_BULK_WRITES;
    allowPost = false;
  });

  it("blocks the three unmapped collections and does not send a mapped product that fails eligibility", async () => {
    await makeProduct({ itemCode: "MAPPED-OK", collectionId: "col-ok" });
    await makeProduct({ itemCode: "MAPPED-NOIMG", collectionId: "col-photo", variants: [{ color: { en: "white" }, images: [], sizes: [{ size: "medium", stockQuantity: 2 }] }] });
    await makeProduct({ itemCode: "UNMAP-1", collectionId: "col-u1" });
    await makeProduct({ itemCode: "UNMAP-2", collectionId: "col-u2" });
    await makeProduct({ itemCode: "UNMAP-3", collectionId: "col-u3" });
    await makeProduct({ itemCode: "MAP-BAD", collectionId: "col-bad" });
    await makeProduct({ itemCode: "MAP-OLD", collectionId: "col-old" });
    await mapCollection(undefined, "col-ok");
    await mapCollection(undefined, "col-photo");
    await mapCollection({ categoryId: "999", categoryName: "Missing", subcategoryId: "10", subcategoryName: "Blenders" }, "col-bad");
    await mapCollection({ categoryId: "1", categoryName: "Home", subcategoryId: "11", subcategoryName: "Retired blades" }, "col-old");
    const job = await previewAll();
    const rows = await rowsFor(job);
    const bySku = Object.fromEntries(rows.map((row) => [row.sku, row]));
    assert.equal(bySku["MAPPED-OK"].classification, "READY_CREATE");
    assert.equal(bySku["MAPPED-NOIMG"].classification, "BLOCKED");
    assert.equal(bySku["MAPPED-NOIMG"].blockers.includes("missing_image"), true);
    for (const sku of ["UNMAP-1", "UNMAP-2", "UNMAP-3"]) {
      assert.equal(bySku[sku].classification, "BLOCKED");
      assert.equal(bySku[sku].blockers.includes("missing_mapping"), true);
    }
    assert.equal(bySku["MAP-BAD"].blockers.includes("invalid_mapping"), true);
    assert.equal(bySku["MAP-OLD"].blockers.includes("inactive_mapping"), true);
    assert.equal(job.readyCreate, 1);
    assert.equal(job.mappingCoverage.unmapped, 3);
    assert.equal(job.mappingCoverage.configured, 2);
    assert.equal(job.mappingCoverage.invalid, 1);
    assert.equal(job.mappingCoverage.inactive, 1);
    assert.equal(job.mappingCoverage.mappedIsNotSendEligibility, true);
    assert.deepEqual(
      job.mappingCoverage.unmappedCollections.map((row) => row.id).sort(),
      ["col-u1", "col-u2", "col-u3"]
    );
    assert.equal(productGets().length, 1);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
  });

  it("pauses an edge-blocked product lookup without retrying, then resumes without creating", async () => {
    lookupMode = "edge";
    await makeProduct({ itemCode: "EDGE-SKU" });
    await mapCollection();
    await runGiniSyncPreview();
    await waitForGiniBulkIdle();
    const blocked = (await getLatestGiniSyncJob()).job;
    assert.equal(blocked.status, "edge_blocked");
    assert.equal(blocked.readyCreate, 0);
    assert.equal(productGets().length, 1);
    assert.equal(posts().length, 0);
    lookupMode = "";
    calls = [];
    await resumeGiniSyncAll();
    await waitForGiniBulkIdle();
    const done = (await getLatestGiniSyncJob()).job;
    assert.equal(done.status, "preview");
    assert.equal(done.readyCreate, 1);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
  });

  it("does not create a product when the SKU search page is incomplete", async () => {
    lookupMode = "incomplete";
    await makeProduct({ itemCode: "PAGE-GAP" });
    await mapCollection();
    const job = await previewAll();
    const row = (await rowsFor(job))[0];
    assert.equal(job.status, "preview");
    assert.equal(job.readyCreate, 0);
    assert.equal(job.lookupUncertain, 1);
    assert.equal(row.classification, "LOOKUP_UNCERTAIN");
    assert.equal(calls.filter((item) => item.method === "GET" && item.url.includes("/products?")).length, 1);
    assert.equal(posts().length, 0);
  });

  it("keeps product 570278 and a historical hold out of create, then updates only a real price change", async () => {
    const protectedProduct = await makeProduct({
      _id: "6aae476f023c0be610d48024",
      itemCode: "ZJP00.000BK",
    });
    const held = await makeProduct({ itemCode: "HA0449" });
    await mapCollection();
    const first = await previewAll();
    assert.equal(first.readyCreate, 1);
    assert.equal((await rowsFor(first)).find((row) => row.sku === "HA0449").classification, "BLOCKED");
    const created = await runSync(first);
    assert.equal(created.created, 1);
    assert.deepEqual(posts().map((item) => formFields(item.options).sku), ["ZJP00.000BK"]);
    const state = await GiniSyncSendState.findOne({ sku: "ZJP00.000BK" }).lean();
    assert.equal(state.giniProductId, "501");
    assert.equal(String(state.productId), "6aae476f023c0be610d48024");
    await GiniSyncSendState.updateOne({ sku: "ZJP00.000BK" }, { $set: { giniProductId: "570278" } });
    await GiniSyncProductResult.updateMany(
      { sku: "ZJP00.000BK", classification: "CREATED" },
      { $set: { giniProductId: "570278" } }
    );
    remote.set(giniSkuKey("ZJP00.000BK"), { id: "570278", sku: "ZJP00.000BK" });
    await GiniSyncSendState.create({
      partner: "gini",
      productId: String(held._id),
      sku: "HA0449",
      skuKey: giniSkuKey("HA0449"),
      giniProductId: "900",
      payloadHash: "not-the-live-hash",
      jobId: "historical-preview",
    });
    remote.set(giniSkuKey("HA0449"), { id: "900", sku: "HA0449" });
    calls = [];
    await Product.updateOne({ _id: protectedProduct._id }, { $set: { price: 7000 } });
    const changedPreview = await previewAll();
    const changedRows = await rowsFor(changedPreview);
    assert.equal(changedRows.find((row) => row.sku === "ZJP00.000BK").classification, "CHANGED");
    assert.equal(changedRows.find((row) => row.sku === "HA0449").classification, "RECONCILE");
    assert.equal(changedRows.find((row) => row.sku === "HA0449").errorCode, "historical_sku_hold");
    assert.equal(changedPreview.changed, 1);
    assert.equal(changedPreview.readyCreate, 0);
    assert.equal(posts().length, 0);
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    allowPut = true;
    enableWrites();
    calls = [];
    await startGiniSyncAll({
      confirm: true,
      previewJobId: changedPreview.id,
      catalogSignature: changedPreview.catalogSignature,
      expectedReady: 0,
      expectedChanged: 1,
      scope: "full",
      approveFullRun: true,
    });
    await waitForGiniBulkIdle();
    const synced = (await getLatestGiniSyncJob()).job;
    assert.equal(synced.status, "completed");
    assert.equal(synced.updated, 1);
    assert.equal(synced.created, 0);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 1);
    const body = JSON.parse(puts()[0].options.body);
    assert.deepEqual(Object.keys(body), ["price"]);
    assert.equal(body.price, 7000);
    const kept = await GiniSyncSendState.findOne({ sku: "ZJP00.000BK" }).lean();
    assert.equal(kept.giniProductId, "570278");
    assert.equal(String(kept.productId), "6aae476f023c0be610d48024");
    const heldState = await GiniSyncSendState.findOne({ sku: "HA0449" }).lean();
    assert.equal(heldState.giniProductId, "900");
    assert.equal(String(protectedProduct._id), "6aae476f023c0be610d48024");
  });

  it("creates only new products and updates only price changes on the next sync", async () => {
    const keep = await makeProduct({ itemCode: "DAY-KEEP" });
    const priced = await makeProduct({ itemCode: "DAY-PRICE" });
    await makeProduct({ itemCode: "DAY-STOCK" });
    await mapCollection();
    const first = await previewAll();
    assert.equal(first.readyCreate, 3);
    await runSync(first);
    assert.equal(posts().length, 3);
    calls = [];
    await Product.updateOne({ _id: priced._id }, { $set: { price: 9000 } });
    await makeProduct({ itemCode: "DAY-NEW" });
    const later = await previewAll();
    const laterRows = await rowsFor(later);
    const laterBySku = Object.fromEntries(laterRows.map((row) => [row.sku, row.classification]));
    assert.equal(laterBySku["DAY-KEEP"], "UNCHANGED");
    assert.equal(laterBySku["DAY-STOCK"], "UNCHANGED");
    assert.equal(laterBySku["DAY-PRICE"], "CHANGED");
    assert.equal(laterBySku["DAY-NEW"], "READY_CREATE");
    assert.equal(later.unchanged, 2);
    assert.equal(later.changed, 1);
    assert.equal(later.readyCreate, 1);
    assert.equal(productGets().filter((item) => decodeURIComponent(item.url).includes("DAY-KEEP")).length, 0);
    assert.equal(productGets().filter((item) => decodeURIComponent(item.url).includes("DAY-STOCK")).length, 0);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
    process.env.GINI_UPDATE_WRITES_ENABLED = "true";
    process.env.GINI_ALLOW_LIVE_UPDATE_WRITES = "true";
    allowPut = true;
    enableWrites();
    calls = [];
    await startGiniSyncAll({
      confirm: true,
      previewJobId: later.id,
      catalogSignature: later.catalogSignature,
      expectedReady: later.readyCreate,
      expectedChanged: later.changed,
      scope: "full",
      approveFullRun: true,
    });
    await waitForGiniBulkIdle();
    const sentSkus = posts().map((item) => formFields(item.options).sku);
    assert.deepEqual(sentSkus, ["DAY-NEW"]);
    assert.equal(puts().length, 1);
    assert.equal(JSON.parse(puts()[0].options.body).price, 9000);
    const priceState = await GiniSyncSendState.findOne({ sku: "DAY-PRICE" }).lean();
    assert.notEqual(priceState.giniProductId, "");
    calls = [];
    const quiet = await previewAll();
    const quietRows = await rowsFor(quiet);
    assert.equal(quietRows.every((row) => row.classification === "UNCHANGED"), true);
    assert.equal(quiet.readyCreate, 0);
    assert.equal(quiet.changed, 0);
    assert.equal(productGets().length, 0);
    assert.equal(posts().length, 0);
    assert.equal(puts().length, 0);
    assert.equal((await Product.findById(keep._id).lean()).price, 6500);
  });
});
