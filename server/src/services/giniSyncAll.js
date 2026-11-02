import crypto from "crypto";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncProductResult } from "../models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility, productScopeIds } from "../utils/platformEligibility.js";
import { taxonomyValuesForProduct, loadEligibilityContext } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  blockerMessage,
  buildGiniPlanFromParts,
  classifyConfirmedSend,
  classifyGiniBulk,
  giniPayloadHash,
  mappingFromTree,
} from "../utils/giniSyncEvaluate.js";
import { GINI_PRODUCTS_PATH, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";
import {
  fetchGiniCategoryTree,
  getGiniConnectionPublic,
  GINI_SECRET_UNREADABLE_MESSAGE,
  performGiniRequest,
  sanitizeGiniText,
} from "./giniConnection.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";

export const GINI_SYNC_BATCH_SIZE = 100;
export const GINI_BULK_LIMIT_MAX = 25;
const LOCK_STALE_MS = 15000;
const SYSTEMATIC_FAILURES = 5;
const ACTIVE_JOB = ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"];
const RUNNING = ["preview_running", "running"];
const CLASS_FIELDS = {
  READY_CREATE: "readyCreate",
  ALREADY_EXISTS: "alreadyExists",
  BLOCKED: "blocked",
  INACTIVE: "inactive",
  NEEDS_REVIEW: "needsReview",
  LOOKUP_UNCERTAIN: "lookupUncertain",
  CREATED: "created",
  FAILED: "failed",
  CREATE_UNCERTAIN: "createUncertain",
  RECONCILE: "reconcile",
};

let activeRunner = null;
let paceOverride = null;
let batchOverride = null;
let afterProduct = null;
let beforeSend = null;
let batchSizes = [];
let skuIndexScans = 0;
let remoteLookupCount = 0;
let reconcileCache = { key: "", at: 0, warnings: [] };
const RECONCILE_CACHE_MS = 30000;

export class GiniBulkError extends Error {
  constructor(message, { status = 400, code = "gini_bulk_error" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class GiniBulkPause extends Error {
  constructor(pauseStatus, message) {
    super(message);
    this.pauseStatus = pauseStatus;
  }
}

export function giniBulkWritesEnabled() {
  return process.env.GINI_BULK_WRITES_ENABLED === "true" && process.env.GINI_ALLOW_LIVE_BULK_WRITES === "true";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentPace() {
  if (paceOverride != null) return paceOverride;
  const raw = Number(process.env.GINI_BULK_PACE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 400;
  return Math.max(250, raw);
}

function currentBatchSize() {
  const size = Number.isInteger(batchOverride) ? batchOverride : GINI_SYNC_BATCH_SIZE;
  return Math.min(Math.max(size, 1), GINI_SYNC_BATCH_SIZE);
}

function safeText(value) {
  return sanitizeGiniText(value, [], 300)
    .replace(/x-signature\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/x-api-key\s*[:=]\s*\S+/gi, "[redacted]");
}

function backoff(attempt, retryAfterSeconds) {
  if (retryAfterSeconds != null && Number.isFinite(Number(retryAfterSeconds))) {
    return Math.min(Math.max(0, Number(retryAfterSeconds)) * 1000, 120000);
  }
  const fast = paceOverride === 0;
  return Math.min((fast ? 10 : 1000) * 2 ** attempt, fast ? 40 : 30000);
}

async function pace() {
  const ms = currentPace();
  if (ms > 0) await sleep(ms);
}

export function setGiniBulkPaceMs(ms) {
  paceOverride = ms == null ? null : Number(ms);
}

export function setGiniBulkBatchSize(size) {
  batchOverride = size == null ? null : Number(size);
}

export function setGiniBulkAfterProduct(fn) {
  afterProduct = typeof fn === "function" ? fn : null;
}

export function setGiniBulkBeforeSend(fn) {
  beforeSend = typeof fn === "function" ? fn : null;
}

export function resetGiniBulkForTests() {
  activeRunner = null;
  paceOverride = 0;
  batchOverride = null;
  afterProduct = null;
  beforeSend = null;
  batchSizes = [];
  skuIndexScans = 0;
  remoteLookupCount = 0;
  reconcileCache = { key: "", at: 0, warnings: [] };
}

export function giniBulkBatchSizes() {
  return batchSizes.slice();
}

export function giniBulkSkuIndexScans() {
  return skuIndexScans;
}

export function giniBulkRemoteLookups() {
  return remoteLookupCount;
}

export async function waitForGiniBulkIdle(timeoutMs = 60000) {
  const start = Date.now();
  while (activeRunner) {
    if (Date.now() - start > timeoutMs) throw new Error("GINI bulk runner timed out");
    await sleep(15);
  }
}

function emptyCounters() {
  return {
    processed: 0,
    eligible: 0,
    readyCreate: 0,
    alreadyExists: 0,
    blocked: 0,
    inactive: 0,
    needsReview: 0,
    lookupUncertain: 0,
    created: 0,
    failed: 0,
    createUncertain: 0,
    reconcile: 0,
    remoteLookups: 0,
  };
}

function catalogEligible(evaluation) {
  if (!evaluation || evaluation.classification === "INACTIVE") return false;
  const blockers = evaluation.blockers || [];
  return !blockers.includes("missing_mapping") && !blockers.includes("taxonomy_config_missing");
}

function counterPatch(counters, extras = {}) {
  return {
    processed: counters.processed,
    eligible: counters.eligible,
    readyCreate: counters.readyCreate,
    alreadyExists: counters.alreadyExists,
    blocked: counters.blocked,
    inactive: counters.inactive,
    needsReview: counters.needsReview,
    lookupUncertain: counters.lookupUncertain,
    created: counters.created,
    failed: counters.failed,
    createUncertain: counters.createUncertain,
    reconcile: counters.reconcile,
    remoteLookups: counters.remoteLookups,
    ...extras,
  };
}

function addCount(counters, classification) {
  counters.processed += 1;
  const field = CLASS_FIELDS[classification];
  if (field) counters[field] += 1;
}

async function countersFromDb(jobId) {
  const counters = emptyCounters();
  const grouped = await GiniSyncProductResult.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(String(jobId)) } },
    { $group: { _id: "$classification", n: { $sum: 1 } } },
  ]);
  for (const row of grouped) {
    const field = CLASS_FIELDS[row._id];
    if (field) counters[field] = row.n;
    counters.processed += row.n;
  }
  const unmapped = await GiniSyncProductResult.countDocuments({
    jobId,
    classification: { $ne: "INACTIVE" },
    blockers: { $in: ["missing_mapping", "taxonomy_config_missing"] },
  });
  counters.eligible = Math.max(0, counters.processed - counters.inactive - unmapped);
  return counters;
}

async function blockerCountsFromDb(jobId) {
  const rows = await GiniSyncProductResult.aggregate([
    { $match: { jobId: new mongoose.Types.ObjectId(String(jobId)) } },
    { $unwind: "$blockers" },
    { $group: { _id: "$blockers", n: { $sum: 1 } } },
  ]);
  return Object.fromEntries(rows.map((row) => [String(row._id), row.n]));
}

function summarize(blockerCounts) {
  return Object.entries(blockerCounts || {})
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([code, count]) => `${code}:${count}`)
    .join(", ")
    .slice(0, 300);
}

function pushExample(examples, row) {
  const code = row.errorCode || row.blockers?.[0] || "";
  if (!code || code === "READY_CREATE" || code === "CREATED") return;
  if (examples.filter((item) => item.code === code).length >= 3 || examples.length >= 40) return;
  examples.push({
    code,
    productId: row.productId,
    sku: row.sku || "",
    message: row.reason || blockerMessage(code),
  });
  for (const blocker of row.blockers || []) {
    if (examples.filter((item) => item.code === blocker).length >= 3 || examples.length >= 40) continue;
    if (examples.some((item) => item.code === blocker && item.productId === row.productId)) continue;
    examples.push({
      code: blocker,
      productId: row.productId,
      sku: row.sku || "",
      message: row.reason || blockerMessage(blocker),
    });
  }
}

function noteBlockers(blockerCounts, blockers) {
  for (const code of blockers || []) blockerCounts[code] = (blockerCounts[code] || 0) + 1;
}

async function productBounds() {
  const total = await Product.countDocuments();
  const first = await Product.findOne().sort({ _id: 1 }).select("_id").lean();
  const last = await Product.findOne().sort({ _id: -1 }).select("_id").lean();
  return {
    total,
    min: first ? String(first._id) : "",
    max: last ? String(last._id) : "",
  };
}

async function catalogSignature(categories) {
  const [bounds, rules, context] = await Promise.all([
    productBounds(),
    Commission.find({ partner: "gini" }).select("scope targetId percentage isActive filterPath").lean(),
    loadEligibilityContext("gini"),
  ]);
  const tree = (categories || []).map((category) => ({
    id: String(category.id),
    active: category.isActive === true,
    subcategories: (category.subcategories || []).map((sub) => ({
      id: String(sub.id),
      active: sub.isActive === true,
    })),
  }));
  const ruleRows = rules
    .map((rule) =>
      [rule.scope, rule.targetId, rule.percentage, rule.isActive !== false, JSON.stringify(rule.filterPath || null)].join(":")
    )
    .sort();
  const mappings = [...context.taxonomyByCollection.entries()]
    .map(([id, values]) => [id, values?.categoryId || "", values?.subcategoryId || ""].join(":"))
    .sort();
  const inactive = ["category", "subcategory", "collection", "brand", "vendor", "product"].map((scope) =>
    [...(context.inactive?.[scope] || [])].sort().join(",")
  );
  const body = JSON.stringify({
    version: 1,
    total: bounds.total,
    min: bounds.min,
    max: bounds.max,
    partnerActive: context.partnerActive === true,
    rules: ruleRows,
    mappings,
    inactive,
    vendorBrands: [...(context.blockedVendorBrands || [])].sort(),
    tree,
  });
  return crypto.createHash("sha256").update(body).digest("hex");
}

async function buildSkuOwnerIndex() {
  skuIndexScans += 1;
  const owners = new Map();
  const cursor = Product.find({ itemCode: { $type: "string", $ne: "" } }).select("_id itemCode").lean().cursor();
  for await (const doc of cursor) {
    const key = giniSkuKey(doc.itemCode);
    if (!key) continue;
    const id = String(doc._id);
    const list = owners.get(key);
    if (list) list.push(id);
    else owners.set(key, [id]);
  }
  return owners;
}

async function loadSendState() {
  const bySku = new Map();
  const byProduct = new Map();
  const cursor = GiniSyncSendState.find({ partner: "gini" })
    .select("productId skuKey giniProductId")
    .lean()
    .cursor();
  for await (const row of cursor) {
    if (row.skuKey) bySku.set(row.skuKey, row);
    if (row.productId) byProduct.set(String(row.productId), row);
  }
  return { bySku, byProduct };
}

async function loadApprovedIds(previewJobId) {
  const ids = new Set();
  if (!mongoose.isValidObjectId(previewJobId)) return ids;
  const cursor = GiniSyncProductResult.find({
    jobId: previewJobId,
    classification: "READY_CREATE",
  })
    .select("productId")
    .lean()
    .cursor();
  for await (const row of cursor) ids.add(String(row.productId));
  return ids;
}

function cursorFilter(cursorProductId) {
  if (!cursorProductId || !mongoose.isValidObjectId(cursorProductId)) return {};
  return { _id: { $gt: new mongoose.Types.ObjectId(cursorProductId) } };
}

async function lookupSku(sku, shared, { fresh = false } = {}) {
  const key = giniSkuKey(sku);
  if (!fresh && shared.lookupCache.has(key)) return shared.lookupCache.get(key);
  let attempt = 0;
  let found = { error: true, failure: "error", status: 0 };
  while (attempt < 4) {
    await pace();
    shared.counters.remoteLookups += 1;
    remoteLookupCount += 1;
    try {
      found = await findExistingGiniProduct(sku);
    } catch (err) {
      found = {
        error: true,
        status: Number(err?.status) || 0,
        failure: err?.code === "connection_required" ? "auth" : "error",
        message: safeText(err?.message),
      };
    }
    if (found.failure === "auth") {
      throw new GiniBulkPause("auth_failed", "GINI authentication failed. The sync paused before another request.");
    }
    if (found.failure === "edge") {
      throw new GiniBulkPause("edge_blocked", "GINI edge blocked the request. The sync paused.");
    }
    const retry = found.failure === "rate_limited" || (found.error && (found.status === 0 || found.status >= 500));
    if (!retry || attempt >= 3) break;
    await sleep(backoff(attempt, found.retryAfter));
    attempt += 1;
  }
  if (found.failure === "rate_limited") {
    throw new GiniBulkPause("rate_limited", "GINI rate limited the sync. No create was retried.");
  }
  if (!found.error) shared.lookupCache.set(key, found);
  return found;
}

function withIdentity(doc, evaluation, extras = {}) {
  return {
    httpStatus: 0,
    pauseAfter: "",
    attemptedSend: false,
    blockers: [],
    reason: "",
    errorCode: "",
    giniProductId: "",
    giniPrice: null,
    quantity: null,
    imageCount: 0,
    payloadHash: "",
    payloadPreview: null,
    ...evaluation,
    ...extras,
    productId: String(doc._id),
    sku: evaluation?.sku || normalizeGiniItemCode(doc.itemCode),
    skuKey: evaluation?.skuKey || giniSkuKey(doc.itemCode),
  };
}

async function evaluateCatalogProduct(doc, shared) {
  const resolved = toResolvedProduct(doc);
  if (!resolved) {
    return withIdentity(doc, {
      classification: "BLOCKED",
      blockers: ["product_not_found"],
      reason: blockerMessage("product_not_found"),
      errorCode: "product_not_found",
    });
  }
  const productId = String(doc._id);
  const priced = partnerPricePreview(doc, shared.rules);
  const sku = normalizeGiniItemCode(doc.itemCode);
  const skuKey = giniSkuKey(sku);
  const owners = skuKey ? shared.skuOwners.get(skuKey) || [] : [];
  const collectionId = productScopeIds(doc).collection || "";
  let mapping = shared.mappingCache.get(collectionId);
  if (!mapping) {
    mapping = mappingFromTree(taxonomyValuesForProduct(doc, shared.eligibility), shared.categories);
    shared.mappingCache.set(collectionId, mapping);
  }
  const eligibility = evaluatePlatformEligibility(doc, shared.eligibility);
  const localPlan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced,
    duplicateProductIds: owners,
    mapping,
    existing: null,
  });
  const isActive = resolved.isActive !== false;
  const inactiveByRule = (eligibility.reasons || []).some((reason) => reason.code !== "taxonomy_config_missing");
  if (!isActive || inactiveByRule) {
    return withIdentity(
      doc,
      classifyGiniBulk({ plan: localPlan, isActive, eligibility, localSend: null })
    );
  }
  if (localPlan.blockers.length) {
    return withIdentity(doc, classifyGiniBulk({ plan: localPlan, isActive: true, eligibility, localSend: null }));
  }
  const localSend =
    shared.sendByProduct.get(productId) || (skuKey ? shared.sendBySku.get(skuKey) : null) || null;
  if (localSend?.giniProductId) {
    const found = await lookupSku(sku, shared, { fresh: true });
    return withIdentity(doc, classifyConfirmedSend({ plan: localPlan, localSend, found }));
  }
  const approved = !shared.approvedIds || shared.approvedIds.has(productId);
  if (!approved) {
    return withIdentity(doc, {
      classification: "BLOCKED",
      blockers: ["not_in_approved_preview"],
      reason: blockerMessage("not_in_approved_preview"),
      errorCode: "not_in_approved_preview",
      sku,
      skuKey,
      giniPrice: localPlan.giniPrice,
      quantity: localPlan.quantity,
      imageCount: localPlan.imageCount,
      payloadHash: giniPayloadHash(localPlan.payloadPreview),
      payloadPreview: localPlan.payloadPreview,
    });
  }
  const found = await lookupSku(sku, shared, { fresh: false });
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced,
    duplicateProductIds: owners,
    mapping,
    existing: found,
  });
  return withIdentity(doc, classifyGiniBulk({ plan, isActive: true, eligibility: null, localSend: null }));
}

function confirmedCreateId(response, skuKey) {
  const data = response?.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const id = data.id == null ? "" : String(data.id).trim();
  if (!id) return "";
  if (data.sku != null && String(data.sku).trim() && giniSkuKey(data.sku) !== skuKey) return "";
  return id;
}

async function recoverSku(sku, shared) {
  try {
    return await lookupSku(sku, shared, { fresh: true });
  } catch (err) {
    if (err instanceof GiniBulkPause) return { pause: err, error: true };
    return { error: true, failure: "error", message: safeText(err?.message) };
  }
}

async function savedSend(evaluation) {
  return GiniSyncSendState.findOne({
    partner: "gini",
    $or: [{ skuKey: evaluation.skuKey }, { productId: evaluation.productId }],
  }).lean();
}

function reconcileResult(doc, evaluation, code, giniProductId, httpStatus = 0) {
  return withIdentity(doc, evaluation, {
    classification: "RECONCILE",
    blockers: [code],
    reason: blockerMessage(code),
    errorCode: code,
    giniProductId: String(giniProductId || ""),
    httpStatus,
    attemptedSend: false,
  });
}

async function postCreate(doc, evaluation, shared) {
  const prior = await savedSend(evaluation);
  const freshLookup = await lookupSku(evaluation.sku, shared, { fresh: true });
  if (freshLookup.exists) {
    const liveId = String(freshLookup.giniProductId || "");
    if (prior?.giniProductId && liveId && String(prior.giniProductId) !== liveId) {
      return reconcileResult(doc, evaluation, "confirmed_send_id_mismatch", prior.giniProductId, 200);
    }
    return withIdentity(doc, evaluation, {
      classification: "ALREADY_EXISTS",
      blockers: ["existing_gini_product"],
      reason: blockerMessage("existing_gini_product"),
      errorCode: "existing_gini_product",
      giniProductId: liveId,
      attemptedSend: false,
    });
  }
  if (freshLookup.error || freshLookup.exists !== false) {
    if (prior?.giniProductId) {
      return reconcileResult(doc, evaluation, "confirmed_send_unverified", prior.giniProductId, Number(freshLookup.status) || 0);
    }
    return withIdentity(doc, evaluation, {
      classification: "LOOKUP_UNCERTAIN",
      blockers: ["gini_lookup_failed"],
      reason: blockerMessage("gini_lookup_failed"),
      errorCode: "gini_lookup_failed",
      giniProductId: "",
      attemptedSend: false,
    });
  }
  if (prior?.giniProductId) {
    return reconcileResult(doc, evaluation, "confirmed_send_missing", prior.giniProductId, 404);
  }
  let files = [];
  try {
    const images = evaluation.payloadPreview?.images || [];
    for (let index = 0; index < images.length; index += 1) {
      files.push(await downloadGiniProductImage(images[index].url, index));
    }
  } catch (err) {
    return withIdentity(doc, evaluation, {
      classification: "FAILED",
      blockers: ["invalid_image"],
      reason: blockerMessage("invalid_image"),
      errorCode: err?.code || "invalid_image",
      giniProductId: "",
      attemptedSend: false,
    });
  }
  await pace();
  if (beforeSend) await beforeSend({ productId: evaluation.productId, sku: evaluation.sku });
  const form = buildGiniCreateForm(evaluation.payloadPreview, files);
  let response;
  try {
    // Verified GINI create signs an empty body and does not use an Idempotency-Key.
    response = await performGiniRequest({ method: "POST", path: GINI_PRODUCTS_PATH, form });
  } catch (err) {
    const recovered = await recoverSku(evaluation.sku, shared);
    if (recovered?.exists && recovered.giniProductId) {
      return withIdentity(doc, evaluation, {
        classification: "CREATED",
        blockers: [],
        reason: "The create response was not received, but this SKU now exists on GINI. No second create was sent.",
        errorCode: "create_recovered_by_sku",
        giniProductId: String(recovered.giniProductId),
        httpStatus: 0,
        attemptedSend: true,
        pauseAfter: recovered.pause?.pauseStatus || "",
      });
    }
    return withIdentity(doc, evaluation, {
      classification: "CREATE_UNCERTAIN",
      blockers: ["create_uncertain"],
      reason: safeText(err?.message || blockerMessage("create_uncertain")),
      errorCode: "create_uncertain",
      giniProductId: "",
      httpStatus: 0,
      attemptedSend: true,
      pauseAfter: recovered?.pause?.pauseStatus || "",
    });
  }
  files = [];
  const recoveredAfter = async () => recoverSku(evaluation.sku, shared);
  if (response.edgeBlocked || response.status === 401 || response.status === 403 || response.status === 429) {
    const recovered = await recoveredAfter();
    if (recovered?.exists && recovered.giniProductId) {
      return withIdentity(doc, evaluation, {
        classification: "CREATED",
        blockers: [],
        reason: "GINI already has this SKU. No second create was sent.",
        errorCode: "create_recovered_by_sku",
        giniProductId: String(recovered.giniProductId),
        httpStatus: response.status,
        attemptedSend: true,
      });
    }
    const pauseAfter = response.edgeBlocked
      ? "edge_blocked"
      : response.status === 429
        ? "rate_limited"
        : "auth_failed";
    const errorCode = response.edgeBlocked
      ? "gini_edge_blocked"
      : response.status === 429
        ? "rate_limited"
        : "gini_access_forbidden";
    return withIdentity(doc, evaluation, {
      classification: response.status === 429 ? "CREATE_UNCERTAIN" : "FAILED",
      blockers: [errorCode],
      reason: safeText(response.safeErrorMessage || blockerMessage(errorCode)),
      errorCode,
      giniProductId: "",
      httpStatus: response.status,
      attemptedSend: true,
      pauseAfter,
    });
  }
  const createdId = confirmedCreateId(response, evaluation.skuKey);
  if ((response.status === 200 || response.status === 201) && createdId) {
    shared.lookupCache.set(evaluation.skuKey, { exists: true, giniProductId: createdId, sku: evaluation.sku });
    return withIdentity(doc, evaluation, {
      classification: "CREATED",
      blockers: [],
      reason: "",
      errorCode: "",
      giniProductId: createdId,
      httpStatus: response.status,
      attemptedSend: true,
    });
  }
  const recovered = await recoveredAfter();
  if (recovered?.exists && recovered.giniProductId) {
    return withIdentity(doc, evaluation, {
      classification: "ALREADY_EXISTS",
      blockers: ["existing_gini_product"],
      reason: blockerMessage("existing_gini_product"),
      errorCode: "existing_gini_product",
      giniProductId: String(recovered.giniProductId),
      httpStatus: response.status,
      attemptedSend: true,
    });
  }
  return withIdentity(doc, evaluation, {
    classification: response.status ? "FAILED" : "CREATE_UNCERTAIN",
    blockers: [response.status ? "gini_create_failed" : "create_uncertain"],
    reason: safeText(response.safeErrorMessage || blockerMessage("gini_create_failed")),
    errorCode: response.status ? "gini_create_failed" : "create_uncertain",
    giniProductId: "",
    httpStatus: response.status,
    attemptedSend: true,
    pauseAfter: recovered?.pause?.pauseStatus || "",
  });
}

async function rememberSend(row, jobId) {
  if (!row?.giniProductId || !row.skuKey) return;
  if (row.classification !== "CREATED" && row.classification !== "ALREADY_EXISTS") return;
  try {
    await GiniSyncSendState.updateOne(
      { skuKey: row.skuKey },
      {
        $setOnInsert: {
          partner: "gini",
          productId: row.productId,
          sku: row.sku || "",
          skuKey: row.skuKey,
          giniProductId: String(row.giniProductId),
          payloadHash: row.payloadHash || "",
          jobId: String(jobId || ""),
          confirmedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    if (err?.code !== 11000) throw err;
  }
}

async function claim(jobId) {
  const token = crypto.randomBytes(12).toString("hex");
  const staleBefore = new Date(Date.now() - LOCK_STALE_MS);
  const job = await GiniSyncJob.findOneAndUpdate(
    {
      _id: jobId,
      status: { $in: RUNNING },
      $or: [
        { runnerToken: "" },
        { runnerToken: { $exists: false } },
        { heartbeatAt: null },
        { heartbeatAt: { $lt: staleBefore } },
      ],
    },
    { $set: { runnerToken: token, heartbeatAt: new Date() } },
    { new: true }
  );
  return job ? token : "";
}

function launchGiniJob(jobId) {
  const id = String(jobId);
  if (activeRunner?.jobId === id) return false;
  if (activeRunner) return false;
  activeRunner = { jobId: id };
  setImmediate(() => {
    void runBody(id);
  });
  return true;
}

async function pauseJob(jobId, token, status, message) {
  const patch = {
    status,
    pausedAt: new Date(),
    lastError: safeText(message),
    failureSummary: safeText(message),
  };
  const filter = { _id: jobId, status: { $in: RUNNING } };
  if (token) filter.runnerToken = token;
  await GiniSyncJob.updateOne(filter, { $set: patch });
}

async function failJob(jobId, token, err) {
  const filter = { _id: jobId, status: { $in: RUNNING } };
  if (token) filter.runnerToken = token;
  const lastError = safeText(err?.message || "GINI sync failed");
  const errorCode = String(err?.code || "gini_sync_failed")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 80) || "gini_sync_failed";
  console.error(`GINI sync job failed (${errorCode}): ${lastError}`);
  await GiniSyncJob.updateOne(filter, {
    $set: {
      status: "failed",
      finishedAt: new Date(),
      lastError,
      errorCode,
    },
  });
}

async function runBody(id) {
  let token = "";
  try {
    token = await claim(id);
    if (!token) return;
    await execute(id, token);
  } catch (err) {
    if (err instanceof GiniBulkPause) await pauseJob(id, token, err.pauseStatus, err.message);
    else await failJob(id, token, err);
  } finally {
    if (token) await GiniSyncJob.updateOne({ _id: id, runnerToken: token }, { $set: { runnerToken: "" } });
    if (activeRunner?.jobId === id) activeRunner = null;
  }
}

async function flush(jobId, token, counters, state) {
  const updated = await GiniSyncJob.updateOne(
    { _id: jobId, runnerToken: token },
    {
      $set: {
        ...counterPatch(counters),
        cursorProductId: state.cursor,
        blockerCounts: state.blockerCounts,
        blockerExamples: state.examples,
        failureSummary: summarize(state.blockerCounts),
        heartbeatAt: new Date(),
      },
    }
  );
  return updated.matchedCount > 0;
}

async function stillRunning(jobId) {
  const fresh = await GiniSyncJob.findById(jobId).select("status").lean();
  return Boolean(fresh && RUNNING.includes(fresh.status));
}

async function execute(jobId, token) {
  const job = await GiniSyncJob.findById(jobId);
  if (!job || !RUNNING.includes(job.status)) return;
  if (job.mode === "sync" && !giniBulkWritesEnabled()) {
    throw new GiniBulkPause("paused", "GINI bulk writes are disabled.");
  }
  const live = await fetchGiniCategoryTree();
  if (live.connectionRequired) {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  const signature = await catalogSignature(live.categories);
  if (job.mode === "preview") {
    await GiniSyncJob.updateOne({ _id: jobId, runnerToken: token }, { $set: { catalogSignature: signature } });
  } else if (signature !== job.catalogSignature) {
    await GiniSyncJob.updateOne(
      { _id: jobId, runnerToken: token, status: { $in: RUNNING } },
      {
        $set: {
          status: "stale",
          finishedAt: new Date(),
          lastError: "The catalog changed after Full Preview. Run Full Preview again.",
        },
      }
    );
    return;
  }
  const [rules, eligibility, skuOwners, sendState] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    buildSkuOwnerIndex(),
    loadSendState(),
  ]);
  const counters = await countersFromDb(jobId);
  const stored = await GiniSyncJob.findById(jobId).select("remoteLookups blockerExamples").lean();
  counters.remoteLookups = stored?.remoteLookups || 0;
  const state = {
    cursor: job.cursorProductId || "",
    blockerCounts: await blockerCountsFromDb(jobId),
    examples: Array.isArray(stored?.blockerExamples) ? stored.blockerExamples.slice(0, 40) : [],
  };
  const shared = {
    mode: job.mode,
    rules,
    eligibility,
    categories: live.categories,
    skuOwners,
    sendBySku: sendState.bySku,
    sendByProduct: sendState.byProduct,
    approvedIds: job.mode === "sync" ? await loadApprovedIds(job.previewJobId) : null,
    mappingCache: new Map(),
    lookupCache: new Map(),
    counters,
    sendLimit: Number.isInteger(job.sendLimit) ? job.sendLimit : null,
  };
  const batchSize = job.batchSize || currentBatchSize();
  let failureStreak = 0;
  while (await stillRunning(jobId)) {
    if (shared.mode === "sync" && shared.sendLimit && counters.created >= shared.sendLimit) {
      await finish(jobId, token, counters, state, "completed", { limitReached: true });
      return;
    }
    const batch = await Product.find(cursorFilter(state.cursor)).sort({ _id: 1 }).limit(batchSize).lean();
    if (!batch.length) {
      if (job.mode === "preview") await finishPreview(jobId, token, counters, state, signature);
      else await finish(jobId, token, counters, state, "completed", {});
      return;
    }
    batchSizes.push(batch.length);
    const ids = batch.map((doc) => String(doc._id));
    const existing = await GiniSyncProductResult.find({ jobId, productId: { $in: ids } }).select("productId").lean();
    const have = new Set(existing.map((row) => row.productId));
    for (const doc of batch) {
      if (!(await stillRunning(jobId))) return;
      const productId = String(doc._id);
      if (shared.mode === "sync" && shared.sendLimit && counters.created >= shared.sendLimit) {
        await finish(jobId, token, counters, state, "completed", { limitReached: true });
        return;
      }
      if (have.has(productId)) {
        state.cursor = productId;
        continue;
      }
      let evaluation = await evaluateCatalogProduct(doc, shared);
      if (shared.mode === "sync" && evaluation.classification === "READY_CREATE") {
        if (!giniBulkWritesEnabled()) throw new GiniBulkPause("paused", "GINI bulk writes are disabled.");
        const fresh = await Product.findById(doc._id).lean();
        if (!fresh) {
          evaluation = withIdentity(doc, {
            classification: "BLOCKED",
            blockers: ["product_not_found"],
            reason: blockerMessage("product_not_found"),
            errorCode: "product_not_found",
          });
        } else {
          const again = await evaluateCatalogProduct(fresh, shared);
          evaluation = again.classification === "READY_CREATE" ? await postCreate(fresh, again, shared) : again;
        }
      }
      const inserted = await insertResult(jobId, evaluation);
      if (inserted) {
        addCount(counters, evaluation.classification);
        if (catalogEligible(evaluation)) counters.eligible += 1;
        noteBlockers(state.blockerCounts, evaluation.blockers);
        pushExample(state.examples, evaluation);
        await rememberSend(evaluation, jobId);
        if (evaluation.classification === "CREATED") failureStreak = 0;
        if (["FAILED", "CREATE_UNCERTAIN", "LOOKUP_UNCERTAIN"].includes(evaluation.classification)) {
          failureStreak += 1;
        }
      }
      state.cursor = productId;
      state.sinceFlush = (state.sinceFlush || 0) + 1;
      const shouldFlush = state.sinceFlush >= 20 || batchSize === 1 || Boolean(evaluation.pauseAfter);
      if (shouldFlush) {
        state.sinceFlush = 0;
        const kept = await flush(jobId, token, counters, state);
        if (!kept) return;
      }
      if (afterProduct) await afterProduct({ processed: counters.processed, classification: evaluation.classification });
      if (evaluation.pauseAfter || failureStreak >= SYSTEMATIC_FAILURES) {
        await flush(jobId, token, counters, state);
        const pauseStatus = evaluation.pauseAfter || "paused";
        await pauseJob(jobId, token, pauseStatus, evaluation.reason || "GINI sync paused after repeated failures.");
        return;
      }
    }
  }
}

async function insertResult(jobId, evaluation) {
  try {
    await GiniSyncProductResult.create({
      jobId,
      partner: "gini",
      productId: evaluation.productId,
      sku: evaluation.sku || "",
      skuKey: evaluation.skuKey || "",
      classification: evaluation.classification,
      blockers: evaluation.blockers || [],
      reason: safeText(evaluation.reason || ""),
      errorCode: String(evaluation.errorCode || "").slice(0, 80),
      httpStatus: Number(evaluation.httpStatus) || 0,
      giniProductId: String(evaluation.giniProductId || ""),
      giniPrice: evaluation.giniPrice ?? null,
      quantity: evaluation.quantity ?? null,
      imageCount: evaluation.imageCount || 0,
      payloadHash: evaluation.payloadHash || "",
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function finish(jobId, token, counters, state, status, extras) {
  await GiniSyncJob.updateOne(
    { _id: jobId, runnerToken: token, status: { $in: RUNNING } },
    {
      $set: {
        ...counterPatch(counters),
        ...extras,
        status,
        cursorProductId: state.cursor,
        blockerCounts: state.blockerCounts,
        blockerExamples: state.examples,
        failureSummary: summarize(state.blockerCounts),
        finishedAt: new Date(),
      },
    }
  );
}

async function finishPreview(jobId, token, counters, state, startSignature) {
  let status = "preview";
  try {
    const live = await fetchGiniCategoryTree();
    if (live.connectionRequired) status = "stale";
    else {
      const end = await catalogSignature(live.categories);
      if (end !== startSignature) status = "stale";
    }
  } catch {
    status = "stale";
  }
  await finish(jobId, token, counters, state, status, {});
}

function publicJob(job, extras = {}) {
  const raw = typeof job?.toObject === "function" ? job.toObject() : job || {};
  const total = Number(raw.total) || 0;
  const processed = Number(raw.processed) || 0;
  return {
    id: String(raw._id || ""),
    status: raw.status,
    mode: raw.mode,
    runScope: raw.runScope,
    batchSize: raw.batchSize || GINI_SYNC_BATCH_SIZE,
    cursorProductId: raw.cursorProductId || "",
    previewJobId: raw.previewJobId || "",
    catalogSignature: raw.catalogSignature || "",
    expectedReady: raw.expectedReady || 0,
    sendLimit: raw.sendLimit ?? null,
    limitReached: Boolean(raw.limitReached),
    total,
    processed,
    eligible: raw.eligible || 0,
    readyCreate: raw.readyCreate || 0,
    alreadyExists: raw.alreadyExists || 0,
    blocked: raw.blocked || 0,
    inactive: raw.inactive || 0,
    needsReview: raw.needsReview || 0,
    lookupUncertain: raw.lookupUncertain || 0,
    created: raw.created || 0,
    failed: raw.failed || 0,
    createUncertain: raw.createUncertain || 0,
    reconcile: raw.reconcile || 0,
    remoteLookups: raw.remoteLookups || 0,
    skipped: raw.blocked || 0,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    blockerCounts: raw.blockerCounts || {},
    blockerExamples: Array.isArray(raw.blockerExamples) ? raw.blockerExamples : [],
    failureSummary: raw.failureSummary || "",
    lastError: raw.lastError || "",
    errorCode: raw.errorCode || "",
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    pausedAt: raw.pausedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    endpoint: GINI_PRODUCTS_PATH,
    createMethod: "POST",
    updatesSupported: false,
    idempotencyKeySupported: false,
    ...extras,
  };
}

function warningFromRow(row, code) {
  return {
    sku: row.sku || "",
    productId: row.productId || "",
    giniProductId: String(row.giniProductId || ""),
    liveGiniProductId: "",
    code,
    httpStatus: Number(row.httpStatus) || 0,
  };
}

async function decorate(job) {
  if (!job) return null;
  const failures = await GiniSyncProductResult.find({
    jobId: job._id,
    classification: { $in: ["FAILED", "CREATE_UNCERTAIN", "LOOKUP_UNCERTAIN"] },
  })
    .sort({ updatedAt: -1 })
    .limit(25)
    .lean();
  const reconcileRows = await GiniSyncProductResult.find({
    jobId: job._id,
    classification: "RECONCILE",
  })
    .sort({ updatedAt: -1 })
    .limit(25)
    .lean();
  return publicJob(job, {
    recentFailures: failures.map((row) => ({
      productId: row.productId,
      sku: row.sku,
      status: row.classification,
      reason: row.reason,
      errorCode: row.errorCode,
      httpStatus: row.httpStatus,
      giniProductId: row.giniProductId,
    })),
    reconciliation: reconcileRows.map((row) => warningFromRow(row, row.errorCode || "confirmed_send_unverified")),
  });
}

async function historicalSendWarnings() {
  const sends = await GiniSyncSendState.find({ partner: "gini" })
    .select("productId sku skuKey giniProductId")
    .lean();
  const ids = [...new Set(sends.map((row) => String(row.giniProductId || "")).filter(Boolean))];
  if (!ids.length) return [];
  const created = await GiniSyncProductResult.find({
    classification: "CREATED",
    giniProductId: { $in: ids },
  })
    .select("giniProductId")
    .lean();
  const createdIds = new Set(created.map((row) => String(row.giniProductId)));
  const pending = sends.filter((row) => row.giniProductId && !createdIds.has(String(row.giniProductId)));
  const key = pending
    .map((row) => `${row.skuKey || row.sku || ""}:${row.giniProductId}`)
    .sort()
    .join("|");
  if (reconcileCache.key === key && Date.now() - reconcileCache.at < RECONCILE_CACHE_MS) return reconcileCache.warnings;
  const warnings = [];
  for (const row of pending) {
    if (!row.sku) {
      warnings.push(warningFromRow(row, "confirmed_send_unverified"));
      continue;
    }
    try {
      const found = await findExistingGiniProduct(row.sku);
      const liveId = found?.giniProductId == null ? "" : String(found.giniProductId);
      if (found?.exists && liveId && liveId === String(row.giniProductId)) continue;
      if (found?.exists && liveId) {
        warnings.push({ ...warningFromRow(row, "confirmed_send_id_mismatch"), liveGiniProductId: liveId, httpStatus: 200 });
        continue;
      }
      if (found?.error || found?.exists !== false) {
        warnings.push(warningFromRow({ ...row, httpStatus: found?.status }, "confirmed_send_unverified"));
        continue;
      }
      warnings.push(warningFromRow({ ...row, httpStatus: 404 }, "confirmed_send_missing"));
    } catch {
      warnings.push(warningFromRow(row, "confirmed_send_unverified"));
    }
  }
  reconcileCache = { key, at: Date.now(), warnings };
  return warnings;
}

export async function ensureGiniSyncRunner() {
  const job = await GiniSyncJob.findOne({ partner: "gini", status: { $in: RUNNING } }).sort({ createdAt: -1 });
  if (!job) return null;
  if (job.mode === "sync" && job.status === "running" && !giniBulkWritesEnabled()) {
    await GiniSyncJob.updateOne(
      { _id: job._id, status: "running" },
      {
        $set: {
          status: "paused",
          pausedAt: new Date(),
          lastError: "GINI bulk writes are disabled.",
          runnerToken: "",
        },
      }
    );
    return null;
  }
  launchGiniJob(job._id);
  return job;
}

export async function getLatestGiniSyncJob() {
  await ensureGiniSyncRunner();
  const job = await GiniSyncJob.findOne({ partner: "gini" }).sort({ createdAt: -1 });
  let preview = null;
  if (job?.mode === "sync" && mongoose.isValidObjectId(job.previewJobId)) {
    preview = await GiniSyncJob.findById(job.previewJobId);
  }
  let reconciliation = [];
  try {
    reconciliation = await historicalSendWarnings();
  } catch {
    reconciliation = [];
  }
  return {
    job: job ? await decorate(job) : null,
    preview: preview ? await decorate(preview) : null,
    reconciliation,
    writesEnabled: giniBulkWritesEnabled(),
    limitedRunMax: GINI_BULK_LIMIT_MAX,
    updatesSupported: false,
    idempotencyKeySupported: false,
    endpoint: GINI_PRODUCTS_PATH,
    createMethod: "POST",
    dryRun: !job || job.mode === "preview",
    sentToGini: job?.mode === "sync" ? job.created || 0 : 0,
  };
}

export async function runGiniSyncPreview() {
  const active = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_JOB } }).sort({ createdAt: -1 });
  if (active?.status === "preview_running") {
    launchGiniJob(active._id);
    const decorated = await decorate(active);
    return { job: decorated, dryRun: true, sentToGini: 0, writesEnabled: giniBulkWritesEnabled() };
  }
  if (active) {
    throw new GiniBulkError("A GINI sync job is already active. Resume or stop it before starting another.", {
      status: 409,
      code: "sync_active",
    });
  }
  const connection = await getGiniConnectionPublic();
  if (connection.secretUnreadable) {
    throw new GiniBulkError(GINI_SECRET_UNREADABLE_MESSAGE, { status: 409, code: "secret_unreadable" });
  }
  if (connection.status !== "connected") {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  const bounds = await productBounds();
  const job = await GiniSyncJob.create({
    partner: "gini",
    status: "preview_running",
    mode: "preview",
    runScope: "preview",
    batchSize: currentBatchSize(),
    total: bounds.total,
    startedAt: new Date(),
    cursorProductId: "",
    runnerToken: "",
  });
  launchGiniJob(job._id);
  return {
    job: await decorate(job),
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniBulkWritesEnabled(),
    message: "Full Preview started. It does not create GINI products.",
  };
}

export async function startGiniSyncAll({
  confirm = false,
  previewJobId,
  catalogSignature: suppliedSignature,
  expectedReady,
  scope,
  limit,
  approveFullRun = false,
} = {}) {
  if (confirm !== true) {
    throw new GiniBulkError("Confirm the create run after Full Preview.", { status: 400, code: "confirm_required" });
  }
  if (!giniBulkWritesEnabled()) {
    throw new GiniBulkError("GINI bulk writes are disabled.", { status: 409, code: "bulk_writes_disabled" });
  }
  const runScope = scope === "full" ? "full" : scope === "limited" ? "limited" : "";
  if (!runScope) throw new GiniBulkError("Choose a limited run or a full run.", { status: 400, code: "invalid_scope" });
  if (runScope === "full" && approveFullRun !== true) {
    throw new GiniBulkError("Full Sync needs a separate full-run approval.", {
      status: 400,
      code: "full_run_approval_required",
    });
  }
  let sendLimit = null;
  if (runScope === "limited") {
    if (!Number.isInteger(limit) || limit < 1 || limit > GINI_BULK_LIMIT_MAX) {
      throw new GiniBulkError(`Limited run size must be a whole number from 1 to ${GINI_BULK_LIMIT_MAX}.`, {
        status: 400,
        code: "invalid_limit",
      });
    }
    sendLimit = limit;
  }
  if (!mongoose.isValidObjectId(String(previewJobId || ""))) {
    throw new GiniBulkError("Finish Full Preview before sending.", { status: 409, code: "preview_required" });
  }
  const preview = await GiniSyncJob.findById(previewJobId);
  if (!preview || preview.partner !== "gini" || preview.mode !== "preview" || preview.status !== "preview" || !preview.finishedAt) {
    throw new GiniBulkError("Finish Full Preview before sending.", { status: 409, code: "preview_required" });
  }
  if (!Number.isInteger(expectedReady) || expectedReady !== preview.readyCreate) {
    throw new GiniBulkError("The confirmed ready count does not match this Full Preview.", {
      status: 409,
      code: "preview_mismatch",
    });
  }
  if (!preview.catalogSignature || suppliedSignature !== preview.catalogSignature) {
    throw new GiniBulkError("This Full Preview does not match the current catalog.", {
      status: 409,
      code: "preview_stale",
    });
  }
  if (preview.readyCreate < 1) {
    throw new GiniBulkError("Full Preview found no products ready to create.", { status: 409, code: "nothing_to_send" });
  }
  const connection = await getGiniConnectionPublic();
  if (connection.secretUnreadable) {
    throw new GiniBulkError(GINI_SECRET_UNREADABLE_MESSAGE, { status: 409, code: "secret_unreadable" });
  }
  if (connection.status !== "connected") {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  const live = await fetchGiniCategoryTree();
  if (live.connectionRequired) {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  const freshSignature = await catalogSignature(live.categories);
  if (freshSignature !== preview.catalogSignature) {
    throw new GiniBulkError("The catalog changed after Full Preview. Run Full Preview again.", {
      status: 409,
      code: "preview_stale",
    });
  }
  const active = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_JOB } }).sort({ createdAt: -1 });
  if (active) {
    throw new GiniBulkError("A GINI sync job is already active. Resume or stop it before starting another.", {
      status: 409,
      code: "sync_active",
    });
  }
  const job = await GiniSyncJob.create({
    partner: "gini",
    status: "running",
    mode: "sync",
    runScope,
    batchSize: currentBatchSize(),
    previewJobId: String(preview._id),
    catalogSignature: preview.catalogSignature,
    expectedReady: preview.readyCreate,
    sendLimit,
    approveFullRun: runScope === "full",
    total: preview.total,
    startedAt: new Date(),
    cursorProductId: "",
    runnerToken: "",
  });
  launchGiniJob(job._id);
  return {
    job: await decorate(job),
    writesEnabled: true,
    sentToGini: 0,
    message: runScope === "limited" ? "Limited GINI create run started." : "Full GINI create run started.",
  };
}

export async function pauseGiniSyncAll() {
  const job = await GiniSyncJob.findOne({ partner: "gini", status: { $in: RUNNING } }).sort({ createdAt: -1 });
  if (!job) throw new GiniBulkError("No running GINI sync job to pause.", { status: 404, code: "not_running" });
  await GiniSyncJob.updateOne({ _id: job._id, status: job.status }, { $set: { status: "paused", pausedAt: new Date() } });
  const fresh = await GiniSyncJob.findById(job._id);
  return { job: await decorate(fresh) };
}

export async function resumeGiniSyncAll() {
  const job = await GiniSyncJob.findOne({
    partner: "gini",
    status: { $in: ["paused", "auth_failed", "rate_limited", "edge_blocked"] },
  }).sort({ createdAt: -1 });
  if (!job) throw new GiniBulkError("No paused GINI sync job to resume.", { status: 404, code: "not_paused" });
  if (job.mode === "sync" && !giniBulkWritesEnabled()) {
    throw new GiniBulkError("GINI bulk writes are disabled.", { status: 409, code: "bulk_writes_disabled" });
  }
  if (job.status === "auth_failed") {
    const connection = await getGiniConnectionPublic();
    if (connection.status !== "connected") {
      throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
    }
  }
  const next = job.mode === "preview" ? "preview_running" : "running";
  await GiniSyncJob.updateOne(
    { _id: job._id },
    { $set: { status: next, pausedAt: null, lastError: "", runnerToken: "", heartbeatAt: null } }
  );
  launchGiniJob(job._id);
  const fresh = await GiniSyncJob.findById(job._id);
  return { job: await decorate(fresh) };
}

export async function stopGiniSyncAll() {
  const job = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_JOB } }).sort({ createdAt: -1 });
  if (!job) throw new GiniBulkError("No active GINI sync job to stop.", { status: 404, code: "not_active" });
  await GiniSyncJob.updateOne(
    { _id: job._id, status: { $in: ACTIVE_JOB } },
    { $set: { status: "stopped", finishedAt: new Date() } }
  );
  const fresh = await GiniSyncJob.findById(job._id);
  return { job: await decorate(fresh) };
}
