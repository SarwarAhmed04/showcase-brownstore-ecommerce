import crypto from "crypto";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniChangedPreviewSnapshot } from "../models/GiniChangedPreviewSnapshot.js";
import { GiniProductUpdateAudit } from "../models/GiniProductUpdateAudit.js";
import { GiniProductUpdateLock } from "../models/GiniProductUpdateLock.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncProductResult } from "../models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
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
  classifyGiniChangedPreview,
  giniChangedFieldDiffs,
  giniPayloadHash,
  mappingFromTree,
} from "../utils/giniSyncEvaluate.js";
import { GINI_PRODUCTS_PATH, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import {
  assessGiniImageChange,
  explainGiniPriceQuantityChange,
  giniChangedPreviewSignature,
  giniImageReplacementIsolation,
  giniImageWritesEnabled,
  giniPartialUpdateBody,
  giniProductUpdatePath,
  GINI_CHANGED_PREVIEW_TTL_MS,
  GINI_PRODUCT_UPDATE_CONTENT_TYPE,
  GINI_PRODUCT_UPDATE_METHOD,
} from "../utils/giniProductUpdateContract.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";
import {
  fetchGiniCategoryTree,
  getGiniConnectionPublic,
  GINI_SECRET_UNREADABLE_MESSAGE,
  performGiniJsonRequest,
  performGiniRequest,
  sanitizeGiniText,
} from "./giniConnection.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";
import { isGiniHistoricalHoldSku } from "../utils/giniHistoricalHold.js";
import { classifyOfficialFieldChange, localConfirmedCatalogDecision } from "../utils/giniCatalogSync.js";
import {
  canReuseLocalPreviewRow,
  localPreviewFingerprint,
  lookupOutcomeOf,
  storedLookupReusable,
} from "../utils/giniPreviewRecovery.js";
import { giniMappingStatus, summarizeGiniMappingCoverage } from "../utils/giniCategoryTree.js";
import { confirmedFieldSnapshotKey, loadConfirmedFieldSnapshots } from "../utils/giniConfirmedFields.js";
import { giniUpdateWritesEnabled } from "./giniProductUpdate.js";

export const GINI_SYNC_BATCH_SIZE = 100;
export const GINI_BULK_LIMIT_MAX = 25;
const LOCK_STALE_MS = 15000;
const SYSTEMATIC_FAILURES = 5;
const FAILURE_STREAK_CLASSIFICATIONS = new Set([
  "FAILED",
  "CREATE_UNCERTAIN",
  "LOOKUP_UNCERTAIN",
  "UPDATE_UNCERTAIN",
]);
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
  UNCHANGED: "unchanged",
  CHANGED: "changed",
  UPDATED: "updated",
  UPDATE_UNCERTAIN: "updateUncertain",
};

let activeRunner = null;
let paceOverride = null;
let batchOverride = null;
let afterProduct = null;
let beforePreviewSeal = null;
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
  constructor(pauseStatus, message, diagnostics = {}) {
    super(message);
    this.pauseStatus = pauseStatus;
    this.code = diagnostics.code || "";
    this.httpStatus = diagnostics.httpStatus == null ? null : Number(diagnostics.httpStatus) || 0;
    this.failureClass = diagnostics.failureClass || "";
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

/** Test hook. Runs between the two final catalog reads, before a preview can be approved. */
export function setGiniBulkBeforePreviewSeal(fn) {
  beforePreviewSeal = typeof fn === "function" ? fn : null;
}

export function resetGiniBulkForTests() {
  activeRunner = null;
  paceOverride = 0;
  batchOverride = null;
  afterProduct = null;
  beforeSend = null;
  beforePreviewSeal = null;
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
    unchanged: 0,
    changed: 0,
    updated: 0,
    updateUncertain: 0,
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
    unchanged: counters.unchanged,
    changed: counters.changed,
    updated: counters.updated,
    updateUncertain: counters.updateUncertain,
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

function compareCodeUnit(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalSignatureSubcategories(subcategories) {
  return (subcategories || [])
    .map((sub) => ({
      id: String(sub.id),
      active: sub.isActive === true,
    }))
    .sort((left, right) => compareCodeUnit(left.id, right.id) || Number(left.active) - Number(right.active));
}

/**
 * Signature projection only. Category pickers and GINI payloads keep API order.
 * Duplicate ids stay in the hash so conflicting active flags or children are not hidden.
 * Ordering is code-unit comparison, independent of locale.
 */
export function canonicalGiniSignatureTree(categories) {
  return (categories || [])
    .map((category) => ({
      id: String(category.id),
      active: category.isActive === true,
      subcategories: canonicalSignatureSubcategories(category.subcategories),
    }))
    .sort(
      (left, right) =>
        compareCodeUnit(left.id, right.id) ||
        Number(left.active) - Number(right.active) ||
        compareCodeUnit(JSON.stringify(left.subcategories), JSON.stringify(right.subcategories))
    );
}

async function signatureParts(categories) {
  const [bounds, rules, context] = await Promise.all([
    productBounds(),
    Commission.find({ partner: "gini" }).select("scope targetId percentage isActive filterPath").lean(),
    loadEligibilityContext("gini"),
  ]);
  const tree = canonicalGiniSignatureTree(categories);
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
  return {
    bounds,
    policy: {
      version: "policy-1",
      partnerActive: context.partnerActive === true,
      rules: ruleRows,
      mappings,
      inactive,
      vendorBrands: [...(context.blockedVendorBrands || [])].sort(),
      tree,
    },
  };
}

function hashSignature(body) {
  return crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Commission, mappings, visibility, and the GINI category policy. Product membership is not included. */
export async function policySignature(categories) {
  const { policy } = await signatureParts(categories);
  return hashSignature(policy);
}

/** Full catalog hash, including product count and id bounds. Membership changes do not invalidate a preview. */
export async function catalogSignature(categories) {
  const { bounds, policy } = await signatureParts(categories);
  return hashSignature({
    version: 1,
    total: bounds.total,
    min: bounds.min,
    max: bounds.max,
    partnerActive: policy.partnerActive,
    rules: policy.rules,
    mappings: policy.mappings,
    inactive: policy.inactive,
    vendorBrands: policy.vendorBrands,
    tree: policy.tree,
  });
}

export async function loadGiniPreviewAssessmentContext(categories) {
  const [rules, eligibility, skuOwners, sendState] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    buildSkuOwnerIndex(),
    loadSendState(),
  ]);
  return {
    rules,
    eligibility,
    categories: categories || [],
    skuOwners,
    policySignature: await policySignature(categories),
    mappingCache: new Map(),
    sendByProduct: sendState.byProduct,
    sendBySku: sendState.bySku,
    approvedIds: null,
  };
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

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Candidates for one giniSkuKey. Whitespace runs match a hyphen; callers confirm with giniSkuKey. */
function skuKeyCandidatePattern(skuKey) {
  const body = [...String(skuKey)].map((char) => (char === "-" ? "(?:-|\\s+)" : escapeRegex(char))).join("");
  return new RegExp(`^\\s*${body}\\s*$`, "i");
}

/** Current BrownStore ids that share this SKU. One query, not another full owner-index scan. */
async function loadFreshSkuOwnerIds(sku) {
  const skuKey = giniSkuKey(sku);
  if (!skuKey) return [];
  const docs = await Product.find({ itemCode: skuKeyCandidatePattern(skuKey) }).select("_id itemCode").lean();
  return docs.filter((doc) => giniSkuKey(doc.itemCode) === skuKey).map((doc) => String(doc._id));
}

async function loadSendState() {
  const bySku = new Map();
  const byProduct = new Map();
  const rows = [];
  const cursor = GiniSyncSendState.find({ partner: "gini" })
    .select("productId sku skuKey giniProductId payloadHash")
    .lean()
    .cursor();
  for await (const row of cursor) {
    rows.push(row);
    if (row.skuKey) bySku.set(row.skuKey, row);
    if (row.productId) byProduct.set(String(row.productId), row);
  }
  return { bySku, byProduct, rows };
}

async function loadApprovedIds(previewJobId, classification = "READY_CREATE") {
  const ids = new Set();
  if (!mongoose.isValidObjectId(previewJobId)) return ids;
  const cursor = GiniSyncProductResult.find({
    jobId: previewJobId,
    classification,
  })
    .select("productId")
    .lean()
    .cursor();
  for await (const row of cursor) ids.add(String(row.productId));
  return ids;
}

/** Approved create evidence. A product id alone does not authorize a later payload. */
async function loadApprovedCreates(previewJobId) {
  const rows = new Map();
  if (!mongoose.isValidObjectId(previewJobId)) return rows;
  const cursor = GiniSyncProductResult.find({
    jobId: previewJobId,
    classification: "READY_CREATE",
  })
    .select("productId skuKey payloadHash")
    .lean()
    .cursor();
  for await (const row of cursor) {
    rows.set(String(row.productId), {
      skuKey: String(row.skuKey || ""),
      payloadHash: String(row.payloadHash || ""),
    });
  }
  return rows;
}

function matchesApprovedCreate(evidence, evaluation) {
  if (!evidence || !evaluation) return false;
  const skuKey = String(evaluation.skuKey || "");
  const payloadHash = String(evaluation.payloadHash || "");
  return (
    Boolean(evidence.skuKey) &&
    evidence.skuKey === skuKey &&
    Boolean(evidence.payloadHash) &&
    evidence.payloadHash === payloadHash &&
    evaluation.classification === "READY_CREATE"
  );
}

function approvedCreateDrifted(evidence, assessed) {
  if (!evidence) return false;
  const skuKey = String(assessed?.skuKey || "");
  const payloadHash = String(assessed?.payloadHash || "");
  const stillEligible = assessed?.requiresLookup === true;
  return !(
    evidence.skuKey &&
    evidence.skuKey === skuKey &&
    evidence.payloadHash &&
    evidence.payloadHash === payloadHash &&
    stillEligible
  );
}

function blockUnapprovedCreate(doc, evaluation) {
  return withIdentity(doc, evaluation, {
    classification: "BLOCKED",
    blockers: ["approved_preview_mismatch"],
    reason: blockerMessage("approved_preview_mismatch"),
    errorCode: "approved_preview_mismatch",
    giniProductId: "",
    attemptedSend: false,
  });
}

function blockDuplicateSku(doc, evaluation) {
  return withIdentity(doc, evaluation, {
    classification: "BLOCKED",
    blockers: ["duplicate_brownstore_sku"],
    reason: blockerMessage("duplicate_brownstore_sku"),
    errorCode: "duplicate_brownstore_sku",
    giniProductId: "",
    attemptedSend: false,
  });
}

function approvedPreviewMismatch(doc, assessed) {
  return withIdentity(doc, {
    classification: "BLOCKED",
    blockers: ["approved_preview_mismatch"],
    reason: blockerMessage("approved_preview_mismatch"),
    errorCode: "approved_preview_mismatch",
    sku: assessed?.sku || "",
    skuKey: assessed?.skuKey || "",
    giniPrice: assessed?.localPlan?.giniPrice ?? null,
    quantity: assessed?.localPlan?.quantity ?? null,
    imageCount: assessed?.localPlan?.imageCount || 0,
    payloadHash: assessed?.payloadHash || "",
    payloadPreview: assessed?.localPlan?.payloadPreview || null,
    attemptedSend: false,
  });
}

async function pacedGiniRead(request) {
  await pace();
  return performGiniRequest(request);
}

function collectionLabel(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  return String(value.en || value.ar || value.ku || "").trim();
}

async function collectMappingCoverage(categories) {
  const [configs, grouped] = await Promise.all([
    PlatformTaxonomyConfig.find({ partner: "gini" }).select("brownCollectionId values").lean(),
    Product.aggregate([
      {
        $group: {
          _id: { $toString: { $ifNull: ["$collectionName._id", ""] } },
          name: { $first: "$collectionName.name" },
          productCount: { $sum: 1 },
          activeProductCount: { $sum: { $cond: [{ $ne: ["$isActive", false] }, 1, 0] } },
        },
      },
    ]),
  ]);
  const byId = new Map();
  for (const row of grouped) {
    const id = String(row?._id || "");
    byId.set(id, {
      id,
      name: collectionLabel(row?.name),
      productCount: Number(row?.productCount) || 0,
      activeProductCount: Number(row?.activeProductCount) || 0,
    });
  }
  for (const config of configs) {
    const id = String(config?.brownCollectionId || "").trim();
    if (!id || byId.has(id)) continue;
    byId.set(id, { id, name: "", productCount: 0, activeProductCount: 0 });
  }
  const valuesById = new Map(
    configs
      .map((config) => [String(config?.brownCollectionId || "").trim(), config?.values || null])
      .filter(([id]) => id)
  );
  const rows = [...byId.values()].map((row) => ({
    ...row,
    status: giniMappingStatus(valuesById.get(row.id) || {}, categories || []),
  }));
  const coverage = summarizeGiniMappingCoverage(rows);
  coverage.unmappedCollections = coverage.unmappedCollections.slice(0, 50);
  coverage.invalidCollections = coverage.invalidCollections.slice(0, 50);
  coverage.inactiveCollections = coverage.inactiveCollections.slice(0, 50);
  return coverage;
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
    shared.counters.remoteLookups += 1;
    remoteLookupCount += 1;
    try {
      found = await findExistingGiniProduct(sku, pacedGiniRead);
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

function stampPreviewEvidence(evaluation, assessed, lookupOutcome, lookupSkuKey = "") {
  return {
    ...evaluation,
    localFingerprint: assessed?.localFingerprint || "",
    policySignature: assessed?.policySignature || "",
    lookupOutcome: lookupOutcome || "",
    lookupSkuKey: lookupSkuKey || "",
  };
}

function inactivePreviewCodes(isActive, eligibility) {
  const codes = [];
  if (!isActive) codes.push("product_inactive");
  for (const reason of eligibility?.reasons || []) {
    if (reason.code && reason.code !== "taxonomy_config_missing") codes.push(reason.code);
  }
  return codes;
}

/** Local plan for one product. A lookup is still required before READY_CREATE. */
export function assessGiniPreviewProduct(doc, shared) {
  const resolved = toResolvedProduct(doc);
  const policy = shared?.policySignature || "";
  if (!resolved) {
    const evaluation = withIdentity(doc, {
      classification: "BLOCKED",
      blockers: ["product_not_found"],
      reason: blockerMessage("product_not_found"),
      errorCode: "product_not_found",
    });
    const localFingerprint = localPreviewFingerprint({
      blockers: evaluation.blockers,
      policySignature: policy,
    });
    return {
      requiresLookup: false,
      evaluation,
      localFingerprint,
      policySignature: policy,
      sku: "",
      skuKey: "",
      payloadHash: "",
      ownerIds: [],
      inactiveCodes: [],
    };
  }
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
  const inactiveCodes = inactivePreviewCodes(isActive, eligibility);
  const localFingerprint = localPreviewFingerprint({
    skuKey,
    payloadHash: giniPayloadHash(localPlan.payloadPreview),
    blockers: localPlan.blockers,
    ownerIds: owners,
    inactiveCodes,
    policySignature: policy,
  });
  const assessed = {
    requiresLookup: false,
    localFingerprint,
    policySignature: policy,
    sku,
    skuKey,
    payloadHash: giniPayloadHash(localPlan.payloadPreview),
    ownerIds: owners.map(String),
    inactiveCodes,
    localPlan,
    resolved,
    priced,
    owners,
    mapping,
  };
  const inactiveByRule = inactiveCodes.length > 0;
  if (!isActive || inactiveByRule) {
    return {
      ...assessed,
      evaluation: withIdentity(doc, classifyGiniBulk({ plan: localPlan, isActive, eligibility, localSend: null })),
    };
  }
  if (localPlan.blockers.length) {
    return {
      ...assessed,
      evaluation: withIdentity(doc, classifyGiniBulk({ plan: localPlan, isActive: true, eligibility, localSend: null })),
    };
  }
  return { ...assessed, requiresLookup: true, evaluation: null };
}

async function evaluateCatalogProduct(doc, shared, options = {}) {
  const assessed = assessGiniPreviewProduct(doc, shared);
  const productKey = String(doc._id);
  const approvedCreate = shared.approvedCreates?.get(productKey);
  if (approvedCreate && approvedCreateDrifted(approvedCreate, assessed)) {
    return stampPreviewEvidence(approvedPreviewMismatch(doc, assessed), assessed, "skipped");
  }
  const source = options.skipSourceReuse ? null : shared.sourceByProduct?.get(String(doc._id));
  if (source && !assessed.requiresLookup && canReuseLocalPreviewRow(source, assessed.evaluation)) {
    return stampPreviewEvidence(assessed.evaluation, assessed, "skipped");
  }
  if (!assessed.requiresLookup) return stampPreviewEvidence(assessed.evaluation, assessed, "skipped");
  const { localPlan, sku, skuKey, owners, mapping, resolved, priced } = assessed;
  const productId = String(doc._id);
  const localSend =
    shared.sendByProduct.get(productId) || (skuKey ? shared.sendBySku.get(skuKey) : null) || null;
  if (localSend?.giniProductId) {
    const decision = localConfirmedCatalogDecision({ plan: localPlan, localSend });
    if (decision.action === "store") return stampPreviewEvidence(withIdentity(doc, decision.result), assessed, "skipped");
    const found = await lookupSku(sku, shared, { fresh: true });
    const confirmed = classifyConfirmedSend({ plan: localPlan, localSend, found });
    if (confirmed.classification !== "ALREADY_EXISTS") {
      return stampPreviewEvidence(withIdentity(doc, confirmed), assessed, lookupOutcomeOf(found), skuKey);
    }
    const snapshot =
      shared.snapshots?.get(confirmedFieldSnapshotKey(localSend.skuKey || skuKey, localSend.giniProductId, localSend.payloadHash)) ||
      null;
    return stampPreviewEvidence(
      withIdentity(doc, classifyOfficialFieldChange({ plan: localPlan, localSend, snapshot })),
      assessed,
      "exists",
      skuKey
    );
  }
  const approved = !shared.approvedIds || shared.approvedIds.has(productId);
  if (!approved) {
    return stampPreviewEvidence(
      withIdentity(doc, {
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
      }),
      assessed,
      "skipped"
    );
  }
  const found = options.lookupOverride || (await lookupSku(sku, shared, { fresh: false }));
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced,
    duplicateProductIds: owners,
    mapping,
    existing: found,
  });
  return stampPreviewEvidence(
    withIdentity(doc, classifyGiniBulk({ plan, isActive: true, eligibility: null, localSend: null })),
    assessed,
    lookupOutcomeOf(found),
    skuKey
  );
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
  if (isGiniHistoricalHoldSku(evaluation?.sku)) {
    return withIdentity(doc, evaluation, {
      classification: "BLOCKED",
      blockers: ["historical_sku_hold"],
      reason: blockerMessage("historical_sku_hold"),
      errorCode: "historical_sku_hold",
      giniProductId: "",
      attemptedSend: false,
    });
  }
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
  const ownerIds = await loadFreshSkuOwnerIds(evaluation.sku);
  if (ownerIds.length !== 1 || !ownerIds.includes(String(doc._id))) return blockDuplicateSku(doc, evaluation);
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

function updateBodyIsOfficial(parsed) {
  const keys = Object.keys(parsed || {});
  return keys.length > 0 && keys.every((key) => key === "price" || key === "quantity");
}

function updateResponseAccepted(response, { skuKey, giniProductId, changes }) {
  if (!response || response.edgeBlocked || response.status !== 200) return false;
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const id = data.id == null ? "" : String(data.id).trim();
  if (!id || id !== String(giniProductId) || giniSkuKey(data.sku) !== skuKey) return false;
  for (const change of changes || []) {
    const actual = Number(data[change.field]);
    if (!Number.isFinite(actual) || actual !== Number(change.new)) return false;
  }
  return true;
}

async function storeCatalogUpdate(state, audit) {
  const patch = {
    lastUpdateConfirmedAt: new Date(),
    lastUpdateAuditId: String(audit._id),
  };
  if (audit.confirmsPayloadHash !== false && audit.nextPayloadHash) {
    patch.payloadHash = audit.nextPayloadHash;
    if (!state.createPayloadHash) patch.createPayloadHash = audit.previousPayloadHash;
  }
  const updated = await GiniSyncSendState.updateOne(
    {
      _id: state._id,
      payloadHash: state.payloadHash,
      giniProductId: state.giniProductId,
      skuKey: state.skuKey,
    },
    { $set: patch }
  );
  return updated.matchedCount > 0;
}

async function postCatalogUpdate(doc, evaluation, shared, { identityVerified = false } = {}) {
  if (isGiniHistoricalHoldSku(evaluation?.sku)) {
    return reconcileResult(doc, evaluation, "historical_sku_hold", evaluation.giniProductId);
  }
  if (!giniUpdateWritesEnabled()) {
    return withIdentity(doc, evaluation, {
      classification: "BLOCKED",
      blockers: ["update_writes_disabled"],
      reason: blockerMessage("update_writes_disabled"),
      errorCode: "update_writes_disabled",
      giniProductId: evaluation.giniProductId,
      attemptedSend: false,
    });
  }
  const state = await GiniSyncSendState.findOne({
    partner: "gini",
    skuKey: evaluation.skuKey,
    productId: evaluation.productId,
  });
  if (!state?.giniProductId || !state.payloadHash) {
    return reconcileResult(doc, evaluation, "confirmed_send_unverified", evaluation.giniProductId);
  }
  const openAudit = await GiniProductUpdateAudit.findOne({
    partner: "gini",
    skuKey: evaluation.skuKey,
    requestSent: true,
    status: { $in: ["pending", "uncertain", "rate_limited"] },
  }).lean();
  if (openAudit) {
    return withIdentity(doc, evaluation, {
      classification: "UPDATE_UNCERTAIN",
      blockers: ["update_uncertain"],
      reason: blockerMessage("update_uncertain"),
      errorCode: "update_uncertain",
      giniProductId: String(state.giniProductId),
      attemptedSend: false,
      pauseAfter: "paused",
    });
  }
  const lock = await GiniProductUpdateLock.findOne({ skuKey: evaluation.skuKey }).lean();
  if (lock) {
    return withIdentity(doc, evaluation, {
      classification: "BLOCKED",
      blockers: ["update_in_progress"],
      reason: blockerMessage("update_in_progress"),
      errorCode: "update_in_progress",
      giniProductId: String(state.giniProductId),
      attemptedSend: false,
    });
  }
  if (!identityVerified) {
    const found = await lookupSku(evaluation.sku, shared, { fresh: true });
    const confirmed = classifyConfirmedSend({ plan: evaluation, localSend: state, found });
    if (confirmed.classification !== "ALREADY_EXISTS") return withIdentity(doc, evaluation, confirmed);
  }
  const snapshot =
    shared.snapshots?.get(confirmedFieldSnapshotKey(state.skuKey, state.giniProductId, state.payloadHash)) || null;
  const official = classifyOfficialFieldChange({
    plan: { ...evaluation, payloadPreview: evaluation.payloadPreview, sku: evaluation.sku },
    localSend: state,
    snapshot,
  });
  if (official.classification !== "CHANGED" || !updateBodyIsOfficial(JSON.parse(giniPartialUpdateBody(official.updateChanges || [])))) {
    return withIdentity(doc, evaluation, official);
  }
  const rawBody = giniPartialUpdateBody(official.updateChanges);
  const parsed = JSON.parse(rawBody);
  if (!updateBodyIsOfficial(parsed)) return withIdentity(doc, evaluation, official);
  const path = giniProductUpdatePath(evaluation.sku);
  const audit = await GiniProductUpdateAudit.create({
    partner: "gini",
    jobId: String(shared.jobId || ""),
    productId: evaluation.productId,
    sku: evaluation.sku,
    skuKey: evaluation.skuKey,
    giniProductId: String(state.giniProductId),
    createJobId: state.jobId || "",
    kind: "json_put",
    method: "PUT",
    path,
    contentType: GINI_PRODUCT_UPDATE_CONTENT_TYPE,
    body: parsed,
    changes: official.updateChanges,
    previousPayloadHash: String(state.payloadHash),
    nextPayloadHash: "",
    confirmsPayloadHash: false,
    status: "pending",
    requestSent: true,
  });
  let response;
  try {
    await pace();
    response = await performGiniJsonRequest({ method: "PUT", path, rawBody });
  } catch (err) {
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "uncertain", errorCode: "update_uncertain", errorMessage: safeText(err?.message) } }
    );
    return withIdentity(doc, evaluation, {
      classification: "UPDATE_UNCERTAIN",
      blockers: ["update_uncertain"],
      reason: safeText(err?.message || blockerMessage("update_uncertain")),
      errorCode: "update_uncertain",
      giniProductId: String(state.giniProductId),
      attemptedSend: true,
      pauseAfter: "paused",
    });
  }
  if (updateResponseAccepted(response, { skuKey: evaluation.skuKey, giniProductId: state.giniProductId, changes: official.updateChanges })) {
    const confirmsPayloadHash = official.confirmFullHash === true && Boolean(official.nextPayloadHash);
    const fullHash = confirmsPayloadHash ? official.nextPayloadHash : "";
    audit.confirmsPayloadHash = confirmsPayloadHash;
    audit.nextPayloadHash = fullHash;
    const stored = await storeCatalogUpdate(state, audit);
    await GiniProductUpdateAudit.updateOne(
      { _id: audit._id },
      {
        $set: {
          status: stored ? "updated" : "uncertain",
          httpStatus: response.status,
          confirmsPayloadHash,
          nextPayloadHash: confirmsPayloadHash ? fullHash : "",
          responseGiniProductId: String(response.json?.data?.id || ""),
          responseSku: String(response.json?.data?.sku || ""),
          errorCode: stored ? "" : "hash_not_stored",
        },
      }
    );
    if (!stored) {
      return withIdentity(doc, evaluation, {
        classification: "UPDATE_UNCERTAIN",
        blockers: ["update_uncertain"],
        reason: blockerMessage("update_uncertain"),
        errorCode: "update_uncertain",
        giniProductId: String(state.giniProductId),
        httpStatus: response.status,
        attemptedSend: true,
        pauseAfter: "paused",
      });
    }
    if (confirmsPayloadHash) state.payloadHash = fullHash;
    return withIdentity(doc, evaluation, {
      classification: "UPDATED",
      blockers: [],
      reason: "",
      errorCode: "",
      giniProductId: String(state.giniProductId),
      httpStatus: response.status,
      payloadHash: confirmsPayloadHash ? fullHash : evaluation.payloadHash,
      attemptedSend: true,
    });
  }
  const pauseAfter = response.edgeBlocked
    ? "edge_blocked"
    : response.status === 429
      ? "rate_limited"
      : response.status === 401 || response.status === 403
        ? "auth_failed"
        : "paused";
  const errorCode = response.edgeBlocked
    ? "gini_edge_blocked"
    : response.status === 429
      ? "rate_limited"
      : response.status === 401 || response.status === 403
        ? "gini_access_forbidden"
        : "update_uncertain";
  await GiniProductUpdateAudit.updateOne(
    { _id: audit._id },
    {
      $set: {
        status: pauseAfter === "paused" ? "uncertain" : pauseAfter,
        httpStatus: response.status || 0,
        errorCode,
        errorMessage: safeText(response.safeErrorMessage),
      },
    }
  );
  return withIdentity(doc, evaluation, {
    classification: "UPDATE_UNCERTAIN",
    blockers: [errorCode],
    reason: safeText(response.safeErrorMessage || blockerMessage("update_uncertain")),
    errorCode,
    giniProductId: String(state.giniProductId),
    httpStatus: response.status || 0,
    attemptedSend: true,
    pauseAfter,
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

async function pauseJob(jobId, token, status, message, diagnostics = {}) {
  const patch = {
    status,
    pausedAt: new Date(),
    lastError: safeText(message),
    failureSummary: safeText(message),
  };
  if (diagnostics.code) {
    patch.errorCode = String(diagnostics.code)
      .replace(/[^a-z0-9_]/gi, "")
      .slice(0, 80);
  }
  if (diagnostics.httpStatus != null) patch.lastHttpStatus = Number(diagnostics.httpStatus) || 0;
  if (diagnostics.failureClass) {
    patch.failureClass = String(diagnostics.failureClass)
      .replace(/[^a-z0-9_]/gi, "")
      .slice(0, 40);
  }
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
  const patch = {
    status: "failed",
    finishedAt: new Date(),
    lastError,
    errorCode,
  };
  if (err?.httpStatus != null) patch.lastHttpStatus = Number(err.httpStatus) || 0;
  if (err?.failureClass) {
    patch.failureClass = String(err.failureClass)
      .replace(/[^a-z0-9_]/gi, "")
      .slice(0, 40);
  }
  await GiniSyncJob.updateOne(filter, { $set: patch });
}

async function runBody(id) {
  let token = "";
  try {
    token = await claim(id);
    if (!token) return;
    await execute(id, token);
  } catch (err) {
    if (err instanceof GiniBulkPause) {
      await pauseJob(id, token, err.pauseStatus, err.message, {
        code: err.code,
        httpStatus: err.httpStatus,
        failureClass: err.failureClass,
      });
    } else await failJob(id, token, err);
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

function pauseForCategoryError(err) {
  if (!err || err.code !== "categories_unavailable") return null;
  const failureClass = String(err.failureClass || "temporary")
    .replace(/[^a-z0-9_]/gi, "")
    .slice(0, 40) || "temporary";
  const pauseStatus =
    failureClass === "edge_blocked"
      ? "edge_blocked"
      : failureClass === "auth_failed"
        ? "auth_failed"
        : failureClass === "rate_limited"
          ? "rate_limited"
          : "paused";
  return new GiniBulkPause(pauseStatus, err.message, {
    code: "categories_unavailable",
    httpStatus: Number(err.httpStatus) || 0,
    failureClass,
  });
}

async function cursorPrefixIsComplete(job) {
  if (!job) return false;
  const cursor = String(job.cursorProductId || "");
  if (!cursor) return true;
  if (!mongoose.isValidObjectId(cursor)) return false;
  const ids = await Product.find({ _id: { $lte: new mongoose.Types.ObjectId(cursor) } }).select("_id").lean();
  if (!ids.some((doc) => String(doc._id) === cursor)) return false;
  const productIds = ids.map((doc) => String(doc._id));
  const classified = await GiniSyncProductResult.countDocuments({
    jobId: job._id,
    productId: { $in: productIds },
  });
  return classified === productIds.length;
}

async function previewStateCanPause(job) {
  if (!job) return false;
  if (!(await cursorPrefixIsComplete(job))) return false;
  if (job.mode === "preview" && (Number(job.processed) || 0) > 0 && !String(job.catalogSignature || "")) return false;
  return true;
}

function unsafePreviewError(pause) {
  const fatal = new GiniBulkError("Full Preview progress cannot be resumed safely. Run Full Preview again.", {
    status: 409,
    code: "preview_not_resumable",
  });
  fatal.httpStatus = Number(pause?.httpStatus) || 0;
  fatal.failureClass = pause?.failureClass || "";
  return fatal;
}

async function loadCategoryTree(jobId) {
  const job = await GiniSyncJob.findById(jobId).lean();
  let live;
  try {
    live = await fetchGiniCategoryTree();
  } catch (err) {
    const pause = pauseForCategoryError(err);
    if (!pause) throw err;
    if (!(await previewStateCanPause(job))) throw unsafePreviewError(pause);
    throw pause;
  }
  if (live.connectionRequired) {
    throw new GiniBulkError("Connect GINI API first.", { status: 409, code: "connection_required" });
  }
  return live;
}

async function execute(jobId, token) {
  const job = await GiniSyncJob.findById(jobId);
  if (!job || !RUNNING.includes(job.status)) return;
  if (job.mode === "sync") {
    const creates = Number(job.expectedReady) > 0;
    const updates = job.applyUpdates === true;
    if ((creates || (!creates && !updates)) && !giniBulkWritesEnabled()) {
      throw new GiniBulkPause("paused", "GINI bulk writes are disabled.");
    }
    if (updates && !giniUpdateWritesEnabled()) {
      throw new GiniBulkPause("paused", "GINI update writes are disabled.");
    }
  }
  const live = await loadCategoryTree(jobId);
  const policy = await policySignature(live.categories);
  const signature = await catalogSignature(live.categories);
  if (job.mode === "preview") {
    const savedPolicy = String(job.policySignature || "");
    const savedFull = String(job.catalogSignature || "");
    if (!savedPolicy && !savedFull) {
      const claimed = await GiniSyncJob.updateOne(
        { _id: jobId, runnerToken: token, status: { $in: RUNNING }, catalogSignature: { $in: ["", null] } },
        { $set: { catalogSignature: signature, policySignature: policy } }
      );
      if (!claimed.matchedCount) {
        const fresh = await GiniSyncJob.findById(jobId).select("status").lean();
        if (!fresh || !RUNNING.includes(fresh.status)) return;
      }
    }
  } else {
    const expectedPolicy = String(job.policySignature || "");
    const expected = expectedPolicy || String(job.catalogSignature || "");
    const actual = expectedPolicy ? policy : signature;
    if (expected && actual !== expected) {
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
  }
  const [rules, eligibility, skuOwners, sendState] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    buildSkuOwnerIndex(),
    loadSendState(),
  ]);
  const snapshots = await loadConfirmedFieldSnapshots(sendState.rows);
  const approvedCreates = job.mode === "sync" ? await loadApprovedCreates(job.previewJobId) : null;
  if (!job.mappingCoverage) {
    const coverage = await collectMappingCoverage(live.categories);
    await GiniSyncJob.updateOne({ _id: jobId, runnerToken: token }, { $set: { mappingCoverage: coverage } });
    job.mappingCoverage = coverage;
  }
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
    policySignature: policy,
    skuOwners,
    sendBySku: sendState.bySku,
    sendByProduct: sendState.byProduct,
    snapshots,
    jobId,
    runScope: job.runScope,
    applyUpdates: job.applyUpdates === true,
    approvedCreates,
    approvedIds: approvedCreates ? new Set(approvedCreates.keys()) : null,
    approvedChanged: job.mode === "sync" && job.applyUpdates === true ? await loadApprovedIds(job.previewJobId, "CHANGED") : null,
    sourceByProduct: job.mode === "preview" ? await loadSourcePreviewRows(job.sourceJobId) : null,
    mappingCache: new Map(),
    lookupCache: new Map(),
    counters,
    sendLimit: Number.isInteger(job.sendLimit) ? job.sendLimit : null,
  };
  if (job.mode === "preview") {
    const retryUncertain = job.retryUncertainLookups === true;
    if (retryUncertain) {
      await GiniSyncJob.updateOne(
        { _id: jobId, runnerToken: token, status: { $in: RUNNING } },
        { $set: { retryUncertainLookups: false } }
      );
    }
    await reconcilePreviewCheckpoint(jobId, shared, { retryUncertain });
    const refreshed = await countersFromDb(jobId);
    refreshed.remoteLookups = counters.remoteLookups;
    Object.assign(counters, refreshed);
    state.blockerCounts = await blockerCountsFromDb(jobId);
  }
  const batchSize = job.batchSize || currentBatchSize();
  let failureStreak = 0;
  while (await stillRunning(jobId)) {
    if (shared.mode === "sync" && shared.sendLimit && counters.created >= shared.sendLimit) {
      await finish(jobId, token, counters, state, "completed", { limitReached: true });
      return;
    }
    const batch = await Product.find(cursorFilter(state.cursor)).sort({ _id: 1 }).limit(batchSize).lean();
    if (!batch.length) {
      if (job.mode === "preview") await finishPreview(jobId, token, counters, state, shared);
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
      if (shared.mode === "sync" && evaluation.classification === "CHANGED") {
        if (!shared.applyUpdates || !shared.approvedChanged?.has(productId)) {
          const code = shared.applyUpdates ? "change_not_in_preview" : "update_writes_disabled";
          evaluation = withIdentity(doc, evaluation, {
            classification: "BLOCKED",
            blockers: [code],
            reason: blockerMessage(code),
            errorCode: code,
            giniProductId: evaluation.giniProductId,
            attemptedSend: false,
          });
        } else {
          const fresh = await Product.findById(doc._id).lean();
          if (!fresh) {
            evaluation = withIdentity(doc, evaluation, {
              classification: "BLOCKED",
              blockers: ["product_not_found"],
              reason: blockerMessage("product_not_found"),
              errorCode: "product_not_found",
            });
          } else {
            const again = await evaluateCatalogProduct(fresh, shared);
            evaluation =
              again.classification === "CHANGED"
                ? await postCatalogUpdate(fresh, again, shared, { identityVerified: true })
                : again;
          }
        }
      }
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
          const evidence = shared.approvedCreates?.get(String(fresh._id));
          evaluation =
            again.classification === "READY_CREATE" && matchesApprovedCreate(evidence, again)
              ? await postCreate(fresh, again, shared)
              : again.classification === "READY_CREATE"
                ? blockUnapprovedCreate(fresh, again)
                : again;
        }
      }
      const inserted = await insertResult(jobId, evaluation);
      if (inserted) {
        addCount(counters, evaluation.classification);
        if (catalogEligible(evaluation)) counters.eligible += 1;
        noteBlockers(state.blockerCounts, evaluation.blockers);
        pushExample(state.examples, evaluation);
        await rememberSend(evaluation, jobId);
        // Full Preview never creates products. Count only consecutive failed or
        // uncertain results, and clear the streak after every other stored outcome.
        if (FAILURE_STREAK_CLASSIFICATIONS.has(evaluation.classification)) failureStreak += 1;
        else failureStreak = 0;
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

function storedResultFields(evaluation) {
  return {
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
    localFingerprint: evaluation.localFingerprint || "",
    policySignature: evaluation.policySignature || "",
    lookupOutcome: evaluation.lookupOutcome || "",
    lookupSkuKey: evaluation.lookupSkuKey || "",
  };
}

async function insertResult(jobId, evaluation) {
  try {
    await GiniSyncProductResult.create({
      jobId,
      partner: "gini",
      productId: evaluation.productId,
      ...storedResultFields(evaluation),
    });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

async function updateStoredResult(jobId, evaluation) {
  const updated = await GiniSyncProductResult.updateOne(
    { jobId, productId: evaluation.productId },
    { $set: storedResultFields(evaluation) }
  );
  return updated.matchedCount > 0;
}

async function refreshPreviewShared(shared, categories) {
  const [rules, eligibility, skuOwners] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    buildSkuOwnerIndex(),
  ]);
  shared.rules = rules;
  shared.eligibility = eligibility;
  shared.skuOwners = skuOwners;
  shared.mappingCache = new Map();
  shared.categories = categories;
  shared.policySignature = await policySignature(categories);
}

async function loadSourcePreviewRows(sourceJobId) {
  const map = new Map();
  if (!mongoose.isValidObjectId(String(sourceJobId || ""))) return map;
  const cursor = GiniSyncProductResult.find({ jobId: sourceJobId })
    .select("productId sku skuKey classification blockers payloadHash")
    .lean()
    .cursor();
  for await (const row of cursor) map.set(String(row.productId), row);
  return map;
}

async function reconcilePreviewCheckpoint(jobId, shared, { retryUncertain = false } = {}) {
  const products = await Product.find().sort({ _id: 1 }).lean();
  const rows = await GiniSyncProductResult.find({ jobId }).lean();
  const rowById = new Map(rows.map((row) => [String(row.productId), row]));
  const liveIds = new Set(products.map((doc) => String(doc._id)));
  const orphanIds = rows.filter((row) => !liveIds.has(String(row.productId))).map((row) => row._id);
  if (orphanIds.length) await GiniSyncProductResult.deleteMany({ _id: { $in: orphanIds } });
  for (const doc of products) {
    const row = rowById.get(String(doc._id));
    if (!row) continue;
    const uncertain = row.classification === "LOOKUP_UNCERTAIN" || row.lookupOutcome === "uncertain";
    if (!row.localFingerprint && !(retryUncertain && uncertain)) continue;
    const assessed = assessGiniPreviewProduct(doc, shared);
    if (!uncertain && row.localFingerprint && row.localFingerprint === assessed.localFingerprint) continue;
    if (uncertain && !retryUncertain && row.localFingerprint === assessed.localFingerprint) continue;
    const localSend =
      shared.sendByProduct.get(String(doc._id)) || (assessed.skuKey ? shared.sendBySku.get(assessed.skuKey) : null) || null;
    const lookupOverride = localSend?.giniProductId ? null : storedLookupReusable(row, assessed.skuKey);
    const evaluation = await evaluateCatalogProduct(doc, shared, {
      lookupOverride: lookupOverride || undefined,
      skipSourceReuse: true,
    });
    await updateStoredResult(jobId, evaluation);
  }
  return products;
}

async function fillMissingPreviewProducts(jobId, token, shared, counters, state) {
  const products = await Product.find().sort({ _id: 1 }).select("_id").lean();
  const rows = await GiniSyncProductResult.find({ jobId }).select("productId").lean();
  const have = new Set(rows.map((row) => String(row.productId)));
  const missingIds = products.map((doc) => String(doc._id)).filter((id) => !have.has(id));
  if (!missingIds.length) {
    if (products.length) state.cursor = String(products[products.length - 1]._id);
    return;
  }
  const docs = await Product.find({ _id: { $in: missingIds } }).lean();
  docs.sort((left, right) => compareCodeUnit(String(left._id), String(right._id)));
  for (const doc of docs) {
    if (!(await stillRunning(jobId))) return;
    const evaluation = await evaluateCatalogProduct(doc, shared);
    const inserted = await insertResult(jobId, evaluation);
    if (inserted) {
      addCount(counters, evaluation.classification);
      if (catalogEligible(evaluation)) counters.eligible += 1;
      noteBlockers(state.blockerCounts, evaluation.blockers);
      pushExample(state.examples, evaluation);
      await rememberSend(evaluation, jobId);
    }
    state.cursor = String(doc._id);
    const kept = await flush(jobId, token, counters, state);
    if (!kept) return;
  }
  if (products.length) state.cursor = String(products[products.length - 1]._id);
}

const PREVIEW_SEAL_ATTEMPTS = 3;
const PREVIEW_SEAL_PAUSE =
  "The catalog changed while Full Preview was checking its final results. Resume to check again. Nothing was sent.";

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object") {
    if (typeof value.toHexString === "function") return value.toHexString();
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = stableJson(value[key]);
    }
    return out;
  }
  return value ?? null;
}

/**
 * Persisted product fields that can change GINI classification, payload, SKU identity, or eligibility.
 * lastSyncedAt and other sync timestamps are omitted so a refresh of those fields does not refuse the seal.
 */
const CATALOG_EPOCH_SELECT =
  "itemCode price discountPrice ibsherDiscountPrice isActive name description brand category subCategory collectionName createdBy variants overrides";

function catalogEpochMaterial(doc) {
  return JSON.stringify(
    stableJson({
      id: String(doc._id),
      itemCode: doc.itemCode || "",
      price: doc.price ?? null,
      discountPrice: doc.discountPrice ?? null,
      ibsherDiscountPrice: doc.ibsherDiscountPrice ?? null,
      isActive: doc.isActive !== false,
      name: doc.name || null,
      description: doc.description || null,
      brand: doc.brand || null,
      category: doc.category || null,
      subCategory: doc.subCategory || null,
      collectionName: doc.collectionName || null,
      createdBy: doc.createdBy || null,
      variants: doc.variants || null,
      overrides: doc.overrides ?? null,
    })
  );
}

async function catalogContentEpoch() {
  const hash = crypto.createHash("sha256");
  let count = 0;
  const cursor = Product.find().sort({ _id: 1 }).select(CATALOG_EPOCH_SELECT).lean().cursor();
  for await (const doc of cursor) {
    count += 1;
    hash.update(catalogEpochMaterial(doc));
  }
  hash.update(String(count));
  return hash.digest("hex");
}

async function previewCatalogRowsMatch(jobId, shared) {
  const rows = await GiniSyncProductResult.find({ jobId }).select("productId localFingerprint").lean();
  const pending = new Map(rows.map((row) => [String(row.productId), row]));
  let seen = 0;
  const cursor = Product.find().sort({ _id: 1 }).lean().cursor();
  for await (const doc of cursor) {
    seen += 1;
    const id = String(doc._id);
    const row = pending.get(id);
    if (!row) return false;
    if (row.localFingerprint) {
      const assessed = assessGiniPreviewProduct(doc, shared);
      if (assessed.localFingerprint !== row.localFingerprint) return false;
    }
    pending.delete(id);
  }
  return seen === rows.length && pending.size === 0;
}

async function pauseUnstablePreview(jobId, token) {
  await pauseJob(jobId, token, "paused", PREVIEW_SEAL_PAUSE, { code: "preview_catalog_moving" });
}

/**
 * Reconcile and fill, then require two identical local catalog reads.
 * A change between those reads pauses the preview instead of approving it.
 * The check is bounded and does not take a catalog write lock.
 */
async function sealFinishedPreview(jobId, token, shared, counters, state, categories) {
  for (let attempt = 0; attempt < PREVIEW_SEAL_ATTEMPTS; attempt += 1) {
    if (!(await stillRunning(jobId))) return "";
    if (attempt > 0) await refreshPreviewShared(shared, categories);
    await reconcilePreviewCheckpoint(jobId, shared, { retryUncertain: false });
    await fillMissingPreviewProducts(jobId, token, shared, counters, state);
    if (!(await stillRunning(jobId))) return "";
    const before = await catalogContentEpoch();
    const aligned = await previewCatalogRowsMatch(jobId, shared);
    if (beforePreviewSeal) await beforePreviewSeal({ attempt });
    if (!(await stillRunning(jobId))) return "";
    const after = await catalogContentEpoch();
    const policyNow = await policySignature(categories);
    if (aligned && before === after && policyNow === String(shared.policySignature || "")) return after;
  }
  await pauseUnstablePreview(jobId, token);
  return "";
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

async function finishPreview(jobId, token, counters, state, shared) {
  const kept = await flush(jobId, token, counters, state);
  if (!kept) return;
  let status = "preview";
  let staleReason = "";
  let signatures = null;
  try {
    const live = await fetchGiniCategoryTree();
    if (live.connectionRequired) status = "stale";
    else {
      await refreshPreviewShared(shared, live.categories);
      const sealedEpoch = await sealFinishedPreview(jobId, token, shared, counters, state, live.categories);
      if (!sealedEpoch) return;
      const confirmEpoch = await catalogContentEpoch();
      const confirmPolicy = await policySignature(live.categories);
      if (confirmEpoch !== sealedEpoch || confirmPolicy !== String(shared.policySignature || "")) {
        await pauseUnstablePreview(jobId, token);
        return;
      }
      const refreshed = await countersFromDb(jobId);
      refreshed.remoteLookups = counters.remoteLookups;
      Object.assign(counters, refreshed);
      state.blockerCounts = await blockerCountsFromDb(jobId);
      signatures = {
        catalogSignature: await catalogSignature(live.categories),
        policySignature: shared.policySignature,
      };
    }
  } catch (err) {
    const pause = pauseForCategoryError(err);
    if (pause) {
      const current = await GiniSyncJob.findById(jobId).lean();
      if (!(await previewStateCanPause(current))) throw unsafePreviewError(pause);
      throw pause;
    }
    if (err instanceof GiniBulkPause) throw err;
    status = "stale";
  }
  await finish(
    jobId,
    token,
    counters,
    state,
    status,
    status === "preview"
      ? { ...(signatures || {}), lastError: "", errorCode: "", failureClass: "", lastHttpStatus: 0 }
      : { ...(signatures || {}), ...(staleReason ? { lastError: staleReason, errorCode: "preview_stale" } : {}) }
  );
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
    policySignature: raw.policySignature || "",
    sourceJobId: raw.sourceJobId || "",
    expectedReady: raw.expectedReady || 0,
    expectedChanged: raw.expectedChanged || 0,
    applyUpdates: raw.applyUpdates === true,
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
    unchanged: raw.unchanged || 0,
    changed: raw.changed || 0,
    updated: raw.updated || 0,
    updateUncertain: raw.updateUncertain || 0,
    remoteLookups: raw.remoteLookups || 0,
    mappingCoverage: raw.mappingCoverage || null,
    skipped: raw.blocked || 0,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    blockerCounts: raw.blockerCounts || {},
    blockerExamples: Array.isArray(raw.blockerExamples) ? raw.blockerExamples : [],
    failureSummary: raw.failureSummary || "",
    lastError: raw.lastError || "",
    errorCode: raw.errorCode || "",
    lastHttpStatus: Number(raw.lastHttpStatus) || 0,
    failureClass: raw.failureClass || "",
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
  // Status polling used to look up every saved SKU. That extra GET traffic ran
  // beside Full Preview and could draw a CloudFront 403. Reconciliation now
  // comes from the stored preview rows, not from a live read on every refresh.
  return [];
}

export async function ensureGiniSyncRunner() {
  const job = await GiniSyncJob.findOne({ partner: "gini", status: { $in: RUNNING } }).sort({ createdAt: -1 });
  if (!job) return null;
  if (
    job.mode === "sync" &&
    job.status === "running" &&
    ((Number(job.expectedReady) > 0 && !giniBulkWritesEnabled()) || (job.applyUpdates === true && !giniUpdateWritesEnabled()))
  ) {
    await GiniSyncJob.updateOne(
      { _id: job._id, status: "running" },
      {
        $set: {
          status: "paused",
          pausedAt: new Date(),
          lastError:
            Number(job.expectedReady) > 0 && !giniBulkWritesEnabled()
              ? "GINI bulk writes are disabled."
              : "GINI update writes are disabled.",
          runnerToken: "",
        },
      }
    );
    return null;
  }
  launchGiniJob(job._id);
  return job;
}

function changedPreviewName(doc, plan) {
  const payloadName = String(plan?.payloadPreview?.name || "").trim();
  if (payloadName) return payloadName;
  const name = doc?.name;
  if (typeof name === "string") return name.trim();
  return String(name?.en || name?.ar || name?.ku || "").trim();
}

async function lookupForChangedPreview(sku, shared) {
  if (!sku) return { error: true, failure: "error", status: 0 };
  if (shared.apiDown) return { error: true, failure: shared.apiDown, status: 0 };
  const key = giniSkuKey(sku);
  if (key && shared.lookupCache.has(key)) return shared.lookupCache.get(key);
  let attempt = 0;
  let found = { error: true, failure: "error", status: 0 };
  while (attempt < 4) {
    await pace();
    remoteLookupCount += 1;
    try {
      found = await findExistingGiniProduct(sku);
    } catch (err) {
      found = {
        error: true,
        status: Number(err?.status) || 0,
        failure: err?.code === "connection_required" || err?.code === "secret_unreadable" ? "auth" : "error",
      };
    }
    if (found.failure === "auth" || found.failure === "edge") {
      shared.apiDown = found.failure;
      return found;
    }
    const retry = found.failure === "rate_limited" || (found.error && (found.status === 0 || found.status >= 500));
    if (!retry || attempt >= 3) break;
    await sleep(backoff(attempt, found.retryAfter));
    attempt += 1;
  }
  if (!found.error && key) shared.lookupCache.set(key, found);
  return found;
}

function changedUpdateContract() {
  return {
    updatesSupported: true,
    updateContractVerified: true,
    updateWritesEnabled: giniUpdateWritesEnabled(),
    updateMethod: GINI_PRODUCT_UPDATE_METHOD,
    updateContentType: GINI_PRODUCT_UPDATE_CONTENT_TYPE,
    updatePartial: true,
    imageContractVerified: true,
    imageWritesEnabled: giniImageWritesEnabled(),
    imageWriteSupported: false,
    imageOrderSupported: false,
    previewId: "",
    previewSignature: "",
    expiresAt: null,
  };
}

function emptyChangedPreview(message) {
  return {
    readOnly: true,
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniBulkWritesEnabled(),
    ...changedUpdateContract(),
    checked: 0,
    changed: 0,
    unchanged: 0,
    reconciliationNeeded: 0,
    blocked: 0,
    changedProducts: [],
    reconciliationProducts: [],
    blockedProducts: [],
    provesRemoteChange: false,
    message,
  };
}

/**
 * Rebuilds one BrownStore payload the same way Changed Preview does.
 * It only reads BrownStore, commission, and the GINI category tree.
 */
export async function rebuildGiniChangedPayload(productId) {
  if (!mongoose.isValidObjectId(String(productId || ""))) return null;
  const doc = await Product.findById(productId).lean();
  if (!doc) return null;
  const resolved = toResolvedProduct(doc);
  const [rules, eligibility, live, skuOwners] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    fetchGiniCategoryTree(),
    buildSkuOwnerIndex(),
  ]);
  if (!live?.categories) return null;
  const skuKey = giniSkuKey(doc.itemCode);
  const owners = skuKey ? skuOwners.get(skuKey) || [] : [];
  const mapping = mappingFromTree(taxonomyValuesForProduct(doc, eligibility), live.categories);
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced: partnerPricePreview(doc, rules),
    duplicateProductIds: owners,
    mapping,
    existing: null,
  });
  return {
    doc,
    payload: plan.payloadPreview,
    hash: giniPayloadHash(plan.payloadPreview),
    giniPrice: plan.giniPrice,
    quantity: plan.quantity,
    imageCount: plan.imageCount,
  };
}

/**
 * Read-only preview of confirmed GINI sends.
 * Rebuilds the current payload, compares it with the saved hash, and checks the live id and SKU with GET.
 * It does not write send history, BrownStore products, category mappings, or GINI.
 * It stores a preview snapshot so a later one-product update can prove the preview is still the one the operator saw.
 */
export async function runGiniChangedPreview() {
  const sends = await GiniSyncSendState.find({ partner: "gini" })
    .select("productId sku skuKey giniProductId payloadHash createPayloadHash")
    .lean();
  if (!sends.length) {
    return emptyChangedPreview("No confirmed GINI products to check. Nothing was sent or updated.");
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
  const [rules, eligibility, skuOwners, snapshots] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    buildSkuOwnerIndex(),
    loadConfirmedFieldSnapshots(sends),
  ]);
  const productIds = sends.map((row) => String(row.productId || "")).filter((id) => mongoose.isValidObjectId(id));
  const products = productIds.length ? await Product.find({ _id: { $in: productIds } }).lean() : [];
  const productsById = new Map(products.map((doc) => [String(doc._id), doc]));
  const shared = {
    rules,
    eligibility,
    categories: live.categories,
    skuOwners,
    mappingCache: new Map(),
    lookupCache: new Map(),
    apiDown: "",
  };
  const rows = [];
  for (const saved of sends) {
    const savedSku = normalizeGiniItemCode(saved.sku);
    const savedId = String(saved.giniProductId || "");
    const savedHash = String(saved.payloadHash || "");
    const doc = productsById.get(String(saved.productId || "")) || null;
    const resolved = doc ? toResolvedProduct(doc) : null;
    let plan = null;
    let inactive = false;
    let inactiveReasons = [];
    if (doc && resolved) {
      const priced = partnerPricePreview(doc, rules);
      const skuKey = giniSkuKey(doc.itemCode);
      const owners = skuKey ? skuOwners.get(skuKey) || [] : [];
      const collectionId = productScopeIds(doc).collection || "";
      let mapping = shared.mappingCache.get(collectionId);
      if (!mapping) {
        mapping = mappingFromTree(taxonomyValuesForProduct(doc, eligibility), live.categories);
        shared.mappingCache.set(collectionId, mapping);
      }
      plan = buildGiniPlanFromParts({
        doc,
        resolved,
        priced,
        duplicateProductIds: owners,
        mapping,
        existing: null,
      });
      const decision = evaluatePlatformEligibility(doc, eligibility);
      const reasons = (decision.reasons || []).filter((reason) => reason.code !== "taxonomy_config_missing");
      inactive = resolved.isActive === false || reasons.length > 0;
      if (resolved.isActive === false) inactiveReasons.push("product_inactive");
      inactiveReasons.push(...reasons.map((reason) => reason.code));
    }
    const found = await lookupForChangedPreview(savedSku, shared);
    const currentHash = plan ? giniPayloadHash(plan.payloadPreview) : "";
    const outcome = classifyGiniChangedPreview({
      savedSku,
      savedGiniProductId: savedId,
      savedHash,
      currentSku: plan?.sku || "",
      currentHash,
      planBlockers: plan?.blockers || [],
      inactive,
      inactiveReasons,
      productFound: Boolean(doc && resolved && plan),
      found,
    });
    const snapshot = snapshots.get(confirmedFieldSnapshotKey(saved.skuKey || savedSku, savedId, savedHash)) || null;
    const changes =
      outcome.classification === "CHANGED"
        ? giniChangedFieldDiffs(
            snapshot
              ? { price: snapshot.giniPrice, quantity: snapshot.quantity, imageCount: snapshot.imageCount }
              : null,
            {
              price: plan?.giniPrice ?? null,
              quantity: plan?.quantity ?? null,
              imageCount: plan?.imageCount ?? null,
            }
          )
        : [];
    const explained =
      outcome.classification === "CHANGED"
        ? explainGiniPriceQuantityChange({
            savedHash,
            currentPayload: plan?.payloadPreview,
            savedPrice: snapshot?.giniPrice,
            savedQuantity: snapshot?.quantity,
          })
        : { ok: false, code: "", changes: [], currentHash: currentHash };
    const identityMatched = outcome.classification === "CHANGED" || outcome.classification === "UNCHANGED";
    const imageIsolation =
      outcome.classification === "CHANGED" && plan?.payloadPreview
        ? giniImageReplacementIsolation({
            savedHash,
            currentPayload: plan.payloadPreview,
            savedPrice: snapshot?.giniPrice,
            savedQuantity: snapshot?.quantity,
            savedImageUrls: null,
          })
        : { block: false, code: "" };
    const images = assessGiniImageChange({
      savedImageCount: snapshot ? snapshot.imageCount : null,
      currentImageUrls: plan?.payloadPreview?.images || [],
      savedImageUrls: null,
      savedContentFingerprints: null,
      currentContentFingerprints: null,
      hashExplainedByPriceQuantity: explained.confirmFullHash === true,
      liveImageUrls: identityMatched && Array.isArray(found?.images) ? found.images : null,
    });
    rows.push({
      classification: outcome.classification,
      code: outcome.code,
      sku: savedSku,
      skuKey: giniSkuKey(savedSku),
      productId: String(saved.productId || ""),
      name: changedPreviewName(doc, plan),
      reason: outcome.reason,
      giniProductId: savedId,
      liveGiniProductId: outcome.liveGiniProductId || "",
      savedHash,
      currentHash,
      changes,
      updateChanges: explained.ok ? explained.changes : [],
      updateEligible: explained.ok === true,
      updateBlocker: explained.ok ? "" : explained.code || "",
      identityMatched,
      fieldsCompared: Boolean(snapshot),
      images,
      remoteImages: images.remoteImages || [],
      sourceImages: images.currentImages || [],
      imageSelectionRequired: images.selectionRequired === true,
      imageReplacementBlocked: imageIsolation.block === true,
      imageReplacementBlocker: imageIsolation.block ? imageIsolation.code : "",
      provesRemoteChange: false,
    });
  }
  const changedProducts = rows
    .filter((row) => row.classification === "CHANGED")
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const reconciliationProducts = rows
    .filter((row) => row.classification === "RECONCILIATION_NEEDED")
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const blockedProducts = rows
    .filter((row) => row.classification === "BLOCKED")
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const previewSignature = giniChangedPreviewSignature(rows);
  const expiresAt = new Date(Date.now() + GINI_CHANGED_PREVIEW_TTL_MS);
  const savedPreview = await GiniChangedPreviewSnapshot.create({
    partner: "gini",
    signature: previewSignature,
    expiresAt,
    rows: rows.map((row) => ({
      sku: row.sku,
      skuKey: row.skuKey,
      productId: row.productId,
      classification: row.classification,
      code: row.code,
      giniProductId: row.giniProductId,
      liveGiniProductId: row.liveGiniProductId,
      savedHash: row.savedHash,
      currentHash: row.currentHash,
      changes: row.changes,
      updateChanges: row.updateChanges,
      updateEligible: row.updateEligible,
      updateBlocker: row.updateBlocker,
      identityMatched: row.identityMatched,
      remoteImages: row.remoteImages || [],
      sourceImages: row.sourceImages || [],
      imageSelectionRequired: row.imageSelectionRequired === true,
    })),
  });
  const present = (row) => ({
    classification: row.classification,
    code: row.code,
    sku: row.sku,
    name: row.name,
    reason: row.reason,
    giniProductId: row.giniProductId,
    liveGiniProductId: row.liveGiniProductId,
    changes: row.changes,
    updateChanges: row.updateChanges,
    updateEligible: row.updateEligible,
    updateBlocker: row.updateBlocker,
    identityMatched: row.identityMatched,
    fieldsCompared: row.fieldsCompared,
    images: row.images,
    imageSelectionRequired: row.imageSelectionRequired === true,
    imageReplacementBlocked: row.imageReplacementBlocked === true,
    imageReplacementBlocker: row.imageReplacementBlocker || "",
    provesRemoteChange: false,
  });
  return {
    readOnly: true,
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniBulkWritesEnabled(),
    ...changedUpdateContract(),
    previewId: String(savedPreview._id),
    previewSignature,
    expiresAt,
    checked: rows.length,
    changed: changedProducts.length,
    unchanged: rows.filter((row) => row.classification === "UNCHANGED").length,
    reconciliationNeeded: reconciliationProducts.length,
    blocked: blockedProducts.length,
    imageVerificationNeeded: changedProducts.filter((row) => row.images?.verificationNeeded === true).length,
    changedProducts: changedProducts.map(present),
    reconciliationProducts: reconciliationProducts.map(present),
    blockedProducts: blockedProducts.map(present),
    provesRemoteChange: false,
    message: "Changed Preview finished. No GINI products were sent or updated.",
  };
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
    updateWritesEnabled: giniUpdateWritesEnabled(),
    imageWritesEnabled: giniImageWritesEnabled(),
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
    message: "Preview started for new and changed products. It does not create or update GINI products.",
  };
}

async function assertPreviewCanStart() {
  const active = await GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_JOB } }).sort({ createdAt: -1 });
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
}

/**
 * New preview job that reads a previous preview and reuses only local decisions
 * that still match. It never updates the source job. READY_CREATE still requires
 * a new verified-absence lookup.
 */
export async function runGiniSuccessorPreview({ sourceJobId } = {}) {
  if (!mongoose.isValidObjectId(String(sourceJobId || ""))) {
    throw new GiniBulkError("A finished or stale Full Preview is required.", { status: 409, code: "preview_required" });
  }
  const source = await GiniSyncJob.findById(sourceJobId).lean();
  if (!source || source.partner !== "gini" || source.mode !== "preview") {
    throw new GiniBulkError("A finished or stale Full Preview is required.", { status: 409, code: "preview_required" });
  }
  if (source.status !== "stale" && source.status !== "preview") {
    throw new GiniBulkError("Successor preview reads a stale or finished Full Preview.", {
      status: 409,
      code: "preview_required",
    });
  }
  await assertPreviewCanStart();
  const bounds = await productBounds();
  const job = await GiniSyncJob.create({
    partner: "gini",
    status: "preview_running",
    mode: "preview",
    runScope: "preview",
    batchSize: currentBatchSize(),
    sourceJobId: String(source._id),
    total: bounds.total,
    startedAt: new Date(),
    cursorProductId: "",
    runnerToken: "",
  });
  launchGiniJob(job._id);
  return {
    job: await decorate(job),
    sourceJobId: String(source._id),
    sourceUntouched: true,
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniBulkWritesEnabled(),
    message: "Successor preview started. The previous preview was not modified. Nothing is sent.",
  };
}

/** Re-check a finished preview after later catalog edits without discarding lookup checkpoints. */
export async function reconcileStoredGiniPreview(jobId) {
  if (!mongoose.isValidObjectId(String(jobId || ""))) {
    throw new GiniBulkError("Finish Full Preview before reconciling it.", { status: 409, code: "preview_required" });
  }
  const job = await GiniSyncJob.findById(jobId);
  if (!job || job.partner !== "gini" || job.mode !== "preview" || job.status !== "preview") {
    throw new GiniBulkError("Finish Full Preview before reconciling it.", { status: 409, code: "preview_required" });
  }
  await assertPreviewCanStart();
  await GiniSyncJob.updateOne(
    { _id: job._id, status: "preview" },
    {
      $set: {
        status: "preview_running",
        finishedAt: null,
        runnerToken: "",
        heartbeatAt: null,
        lastError: "",
        errorCode: "",
        retryUncertainLookups: true,
      },
    }
  );
  launchGiniJob(job._id);
  const fresh = await GiniSyncJob.findById(job._id);
  return {
    job: await decorate(fresh),
    dryRun: true,
    sentToGini: 0,
    writesEnabled: giniBulkWritesEnabled(),
    message: "Preview reconcile started. Completed absence checks are kept when the payload is unchanged.",
  };
}

export async function startGiniSyncAll({
  confirm = false,
  previewJobId,
  catalogSignature: suppliedSignature,
  expectedReady,
  expectedChanged = 0,
  scope,
  limit,
  approveFullRun = false,
} = {}) {
  if (confirm !== true) {
    throw new GiniBulkError("Confirm the create run after Full Preview.", { status: 400, code: "confirm_required" });
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
  const approvedPolicy = String(preview.policySignature || "");
  if (approvedPolicy) {
    if (suppliedSignature !== preview.catalogSignature && suppliedSignature !== approvedPolicy) {
      throw new GiniBulkError("This Full Preview does not match the current catalog.", {
        status: 409,
        code: "preview_stale",
      });
    }
  } else if (!preview.catalogSignature || suppliedSignature !== preview.catalogSignature) {
    throw new GiniBulkError("This Full Preview does not match the current catalog.", {
      status: 409,
      code: "preview_stale",
    });
  }
  const previewChanged = Number(preview.changed) || 0;
  if (runScope === "full" && previewChanged > 0) {
    if (!Number.isInteger(expectedChanged) || expectedChanged !== previewChanged) {
      throw new GiniBulkError("The confirmed changed count does not match this preview.", {
        status: 409,
        code: "preview_mismatch",
      });
    }
  }
  const sendUpdates = runScope === "full" && previewChanged > 0 && giniUpdateWritesEnabled();
  const sendCreates = preview.readyCreate > 0;
  if (sendCreates && !giniBulkWritesEnabled()) {
    throw new GiniBulkError("GINI bulk writes are disabled.", { status: 409, code: "bulk_writes_disabled" });
  }
  if (!sendCreates && previewChanged > 0 && !giniUpdateWritesEnabled()) {
    throw new GiniBulkError("GINI update writes are disabled.", { status: 409, code: "update_writes_disabled" });
  }
  if (!sendCreates && !sendUpdates) {
    throw new GiniBulkError("Full Preview found no products ready to create or update.", {
      status: 409,
      code: "nothing_to_send",
    });
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
  const freshPolicy = await policySignature(live.categories);
  if (approvedPolicy) {
    if (freshPolicy !== approvedPolicy) {
      throw new GiniBulkError("The catalog changed after Full Preview. Run Full Preview again.", {
        status: 409,
        code: "preview_stale",
      });
    }
  } else {
    const freshSignature = await catalogSignature(live.categories);
    if (freshSignature !== preview.catalogSignature) {
      throw new GiniBulkError("The catalog changed after Full Preview. Run Full Preview again.", {
        status: 409,
        code: "preview_stale",
      });
    }
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
    policySignature: preview.policySignature || "",
    expectedReady: preview.readyCreate,
    expectedChanged: sendUpdates ? previewChanged : 0,
    applyUpdates: sendUpdates,
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
    writesEnabled: giniBulkWritesEnabled(),
    updateWritesEnabled: giniUpdateWritesEnabled(),
    sentToGini: 0,
    message:
      runScope === "limited"
        ? "Limited GINI create run started."
        : sendUpdates && sendCreates
          ? "Sync started for new products and supported price or stock changes."
          : sendUpdates
            ? "Sync started for supported price or stock changes. No creates were started."
            : previewChanged > 0
              ? "Create run started. Price and stock updates were not sent because the update gates are off."
              : "Full GINI create run started.",
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
  let job = await GiniSyncJob.findOne({
    partner: "gini",
    status: { $in: ["paused", "auth_failed", "rate_limited", "edge_blocked"] },
  }).sort({ createdAt: -1 });
  if (!job) {
    const failed = await GiniSyncJob.findOne({
      partner: "gini",
      status: "failed",
      mode: "preview",
      errorCode: "categories_unavailable",
    }).sort({ createdAt: -1 });
    if (failed) {
      if (!(await previewStateCanPause(failed))) {
        throw new GiniBulkError("This Full Preview cannot be resumed safely. Run Full Preview again.", {
          status: 409,
          code: "preview_not_resumable",
        });
      }
      job = failed;
    }
  }
  if (!job) throw new GiniBulkError("No paused GINI sync job to resume.", { status: 404, code: "not_paused" });
  if (job.mode === "sync" && Number(job.expectedReady) > 0 && !giniBulkWritesEnabled()) {
    throw new GiniBulkError("GINI bulk writes are disabled.", { status: 409, code: "bulk_writes_disabled" });
  }
  if (job.mode === "sync" && job.applyUpdates === true && !giniUpdateWritesEnabled()) {
    throw new GiniBulkError("GINI update writes are disabled.", { status: 409, code: "update_writes_disabled" });
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
    {
      $set: {
        status: next,
        pausedAt: null,
        finishedAt: null,
        lastError: "",
        errorCode: "",
        failureClass: "",
        lastHttpStatus: 0,
        runnerToken: "",
        heartbeatAt: null,
      },
    }
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
