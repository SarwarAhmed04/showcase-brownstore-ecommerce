import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { MiswagSyncJob } from "../models/MiswagSyncJob.js";
import { MiswagSyncProductResult } from "../models/MiswagSyncProductResult.js";
import { Product } from "../models/Product.js";
import { evaluatePlatformEligibility } from "../utils/platformEligibility.js";
import { loadEligibilityContext } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  MiswagError,
  assertMiswagSyncAllowed,
  createOrUpdateItem,
  logMiswagSafe,
  sanitizeMiswagText,
  sleep,
} from "./miswag.js";
import { createBrandResolverCache, resolveMiswagBrandForProduct } from "./miswagBrandResolve.js";
import {
  loadMiswagCategoryMappingMap,
  resolveMappedMiswagCategory,
} from "./miswagCategoryMapping.js";
import { ensureProductVariationBarcodes } from "./miswagTestBarcodes.js";
import { classifyMiswagPayload, loadMiswagSyncStateMap, saveMiswagAcceptedPayload } from "./miswagSyncState.js";
import {
  MISWAG_ITEM_CREATE_PATH,
  buildMiswagTestPayload,
  miswagItemExternalId,
} from "./miswagTestProduct.js";
import { loadMiswagBrandMappingMap, loadMiswagColorMappingMap } from "./miswagValueMapping.js";

/** Prior Miswag seller client processed docs in batches of 15 (one API call per item). */
export const MISWAG_SYNC_BATCH_SIZE = 15;
const MAX_TRANSIENT_RETRIES = 4;

let activeRunner = null;

function reasonFromErrors(errors = []) {
  if (errors.includes("missing_images")) return "Missing valid product image";
  if (errors.includes("missing_public_origin")) return "MEDIA_PUBLIC_ORIGIN is not set";
  if (errors.includes("missing_sku")) return "Missing SKU / item code";
  if (errors.includes("missing_name")) return "Missing English product name";
  if (errors.includes("missing_arabic_description")) return "Missing Arabic description";
  if (errors.includes("missing_arabic_name_for_highlight")) return "Missing Arabic name";
  if (errors.includes("missing_color_value")) return "Missing variation color";
  if (errors.includes("missing_color_name")) return "Missing variation color name";
  if (errors.includes("missing_variations")) return "Missing variations";
  if (errors.includes("inactive")) return "Product is inactive";
  return errors[0] ? String(errors[0]) : "Missing required product data";
}

function classifyBlocked(result) {
  if (result.status === "INACTIVE") return "inactive";
  if (
    result.code === "category_mapping_missing" ||
    result.code === "category_unresolved" ||
    result.code === "category_ambiguous" ||
    result.code === "category_index_empty"
  ) {
    return "missingCategory";
  }
  if (String(result.code || "").startsWith("brand_")) return "missingBrand";
  if (
    result.code === "missing_color_name" ||
    result.code === "missing_color_value" ||
    result.reason === "Missing variation color name" ||
    result.reason === "Missing variation color" ||
    (result.errors || []).includes("missing_color_name") ||
    (result.errors || []).includes("missing_color_value")
  ) {
    return "missingColor";
  }
  if (result.reason === "Missing valid product image" || (result.errors || []).includes("missing_images")) {
    return "missingData";
  }
  if (result.status === "SKIPPED" || result.status === "FAILED") return "missingData";
  return "otherBlocked";
}

const RESULT_FIELDS = [
  "productId",
  "ibsherId",
  "externalId",
  "sku",
  "status",
  "httpStatus",
  "reason",
  "miswagProductId",
  "changeType",
];

async function upsertResult(jobId, row) {
  const $set = { partner: "miswag" };
  for (const key of RESULT_FIELDS) {
    if (row?.[key] !== undefined) $set[key] = row[key];
  }
  if ($set.changeType && !["new", "changed", "unchanged"].includes($set.changeType)) {
    delete $set.changeType;
  }
  await MiswagSyncProductResult.findOneAndUpdate(
    { jobId, productId: row.productId },
    { $set },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

function publicJob(job, extras = {}) {
  const raw = typeof job?.toObject === "function" ? job.toObject() : job;
  const total = Number(raw.total) || 0;
  const processed = Number(raw.processed) || 0;
  return {
    id: String(raw._id),
    status: raw.status,
    mode: raw.mode,
    strategy: raw.strategy === "changed" ? "changed" : "full",
    batchSize: raw.batchSize || MISWAG_SYNC_BATCH_SIZE,
    cursorIbsherId: raw.cursorIbsherId || "",
    total,
    processed,
    success: raw.success || 0,
    failed: raw.failed || 0,
    skipped: raw.skipped || 0,
    inactive: raw.inactive || 0,
    ready: raw.ready || 0,
    newCount: raw.newCount || 0,
    changedCount: raw.changedCount || 0,
    unchangedCount: raw.unchangedCount || 0,
    scanned: processed,
    sent: raw.mode === "preview" ? 0 : raw.success || 0,
    missingCategory: raw.missingCategory || 0,
    missingBrand: raw.missingBrand || 0,
    missingColor: raw.missingColor || 0,
    missingImage: raw.missingImage || 0,
    missingData: raw.missingData || 0,
    otherBlocked: raw.otherBlocked || 0,
    categoryResolved: raw.categoryResolved || 0,
    categoryAttempted: raw.categoryAttempted || 0,
    brandResolved: raw.brandResolved || 0,
    brandAttempted: raw.brandAttempted || 0,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    failureSummary: raw.failureSummary || "",
    lastError: raw.lastError || "",
    startedAt: raw.startedAt,
    finishedAt: raw.finishedAt,
    pausedAt: raw.pausedAt,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    endpoint: MISWAG_ITEM_CREATE_PATH,
    ...extras,
  };
}

async function evaluateOneProduct(doc, context) {
  const productId = String(doc._id);
  const resolved = toResolvedProduct(doc);
  const externalId = miswagItemExternalId(resolved || doc);
  const sku = resolved?.sku || resolved?.itemCode || doc.itemCode || "";

  const eligibility = evaluatePlatformEligibility(doc, context.eligibility);
  if (!eligibility.eligible) {
    return {
      productId,
      ibsherId: doc.ibsherId || "",
      externalId,
      sku,
      status: "INACTIVE",
      reason: eligibility.reasons?.[0]?.message || "Inactive / excluded",
      code: "inactive",
      httpStatus: 0,
    };
  }

  context.stats.categoryAttempted += 1;
  // Sync All uses only saved Collection → Miswag category mappings (no fuzzy auto-resolve).
  const category = resolveMappedMiswagCategory(doc, context.mappingByCollection);
  if (!category.ok) {
    return {
      productId,
      ibsherId: doc.ibsherId || "",
      externalId,
      sku,
      status: "SKIPPED",
      reason: category.reason || "Miswag category mapping missing",
      code: category.code || "category_mapping_missing",
      httpStatus: 0,
    };
  }
  context.stats.categoryResolved += 1;

  context.stats.brandAttempted += 1;
  const brand = await resolveMiswagBrandForProduct(
    doc,
    context.brandCache,
    context.brandMappingMap || null
  );
  if (!brand.ok) {
    return {
      productId,
      ibsherId: doc.ibsherId || "",
      externalId,
      sku,
      status: "SKIPPED",
      reason: brand.reason,
      code: brand.code,
      httpStatus: 0,
    };
  }
  context.stats.brandResolved += 1;

  let barcodeAssignments;
  try {
    barcodeAssignments = await ensureProductVariationBarcodes(doc);
  } catch (err) {
    return {
      productId,
      ibsherId: doc.ibsherId || "",
      externalId,
      sku,
      status: "SKIPPED",
      reason: sanitizeMiswagText(err.message || "Barcode assignment failed"),
      code: "barcode_failed",
      httpStatus: 0,
    };
  }

  const built = buildMiswagTestPayload(doc, {
    rules: context.rules,
    categoryId: category.category.id,
    brandId: brand.brand.id,
    brandName: brand.brand.name,
    isLarge: category.category.isLarge === true,
    barcodeAssignments,
    colorMap: context.colorMap || null,
  });

  if (!built.ok) {
    return {
      productId,
      ibsherId: doc.ibsherId || "",
      externalId: built.externalId || externalId,
      sku,
      status: "SKIPPED",
      reason: reasonFromErrors(built.errors),
      code: built.errors[0] || "missing_data",
      errors: built.errors,
      httpStatus: 0,
    };
  }

  return {
    productId,
    ibsherId: doc.ibsherId || "",
    externalId: built.externalId,
    sku,
    status: "READY",
    reason: "",
    code: "ready",
    httpStatus: 0,
    payload: built.payload,
    platformPrice: built.platformPrice,
    categoryId: category.category.id,
    isLarge: built.payload?.is_large === true,
    brandId: brand.brand.id,
  };
}

async function sendWithRetry(payload) {
  let attempt = 0;
  while (true) {
    try {
      const response = await createOrUpdateItem(payload, { retries: 0 });
      return { ok: true, httpStatus: response.status, data: response.data, message: response.message };
    } catch (err) {
      const status = Number(err?.status) || 0;
      if (status === 401 || status === 403) {
        return { ok: false, httpStatus: status, authFailed: true, message: err.message };
      }
      if (status === 400 || status === 422 || status === 409) {
        return {
          ok: false,
          httpStatus: status,
          message: err.message,
          validationErrors: err.errors || [],
        };
      }
      const transient = status === 429 || status >= 500 || status === 0 || err?.transient;
      if (!transient || attempt >= MAX_TRANSIENT_RETRIES) {
        return { ok: false, httpStatus: status, message: err.message };
      }
      const retryAfter = Number(err?.retryAfter);
      const wait =
        status === 429
          ? Math.min(
              (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 60) * 1000,
              120000
            )
          : Math.min(1000 * 2 ** attempt, 30000);
      await sleep(wait);
      attempt += 1;
    }
  }
}

async function prepareContext() {
  await assertMiswagSyncAllowed();
  const [rules, eligibility, mappingByCollection, colorMap, brandMappingMap] = await Promise.all([
    Commission.find({ partner: "miswag", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("miswag"),
    loadMiswagCategoryMappingMap(),
    loadMiswagColorMappingMap(),
    loadMiswagBrandMappingMap(),
  ]);
  return {
    rules,
    eligibility,
    mappingByCollection,
    colorMap,
    brandMappingMap,
    brandCache: createBrandResolverCache(),
    mappingCount: mappingByCollection.size,
    stats: {
      categoryAttempted: 0,
      categoryResolved: 0,
      brandAttempted: 0,
      brandResolved: 0,
    },
  };
}

function normalizeStrategy(value) {
  return value === "changed" ? "changed" : "full";
}

function storedStrategy(job) {
  return job?.strategy === "changed" ? "changed" : "full";
}

const CHANGED_PREVIEW_REQUIRED_MESSAGE =
  "Run and complete Changed Preview before starting Changed Sync.";

function changedPreviewRequiredError() {
  return new MiswagError(CHANGED_PREVIEW_REQUIRED_MESSAGE, {
    status: 409,
    code: "changed_preview_required",
  });
}

/**
 * A finished Changed Preview stays status "preview" with finishedAt set.
 * It is not status "completed" — that status belongs to a finished sync.
 * This check only authorizes a new Changed Sync. It does not read or write payloads.
 */
function isCompletedChangedPreview(job) {
  if (!job) return false;
  if (job.partner !== "miswag") return false;
  if (job.mode !== "preview") return false;
  if (job.strategy !== "changed") return false;
  if (job.status !== "preview") return false;
  if (!job.finishedAt) return false;
  return true;
}

async function assertCompletedChangedPreview(previewJobId) {
  const id = String(previewJobId ?? "").trim();
  if (!mongoose.isValidObjectId(id)) throw changedPreviewRequiredError();
  let job = null;
  try {
    job = await MiswagSyncJob.findById(id)
      .select("partner mode strategy status finishedAt")
      .lean();
  } catch {
    throw changedPreviewRequiredError();
  }
  if (!isCompletedChangedPreview(job)) throw changedPreviewRequiredError();
}

function countChange(target, result) {
  if (result?.changeType === "new") target.newCount += 1;
  else if (result?.changeType === "changed") target.changedCount += 1;
  else if (result?.changeType === "unchanged") target.unchangedCount += 1;
}

/** Classify READY rows from one batch with a single sync-state query. */
async function annotateChangeTypes(results) {
  const externalIds = [];
  for (const result of results) {
    if (result?.status === "READY" && result.externalId) externalIds.push(result.externalId);
  }
  const states = await loadMiswagSyncStateMap(externalIds);
  return results.map((result) => {
    if (result?.status !== "READY") return result;
    const classified = classifyMiswagPayload(result.payload, states.get(result.externalId));
    return {
      ...result,
      changeType: classified.changeType,
      payloadHash: classified.currentPayloadHash,
    };
  });
}

async function recordAcceptedPayload(result, sent) {
  const httpStatus = Number(sent?.httpStatus) || 0;
  if (!sent?.ok || !Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 202) return "";
  const miswagProductId = String(sent.data?.item_id || sent.data?.id || result.externalId || "");
  await saveMiswagAcceptedPayload({
    productId: result.productId,
    ibsherId: result.ibsherId,
    externalId: result.externalId,
    payload: result.payload,
    httpStatus: sent.httpStatus,
    miswagProductId,
  });
  return miswagProductId;
}

/** Re-attach runner after process restart if a job is still marked running. */
export async function ensureMiswagSyncRunner() {
  const job = await MiswagSyncJob.findOne({
    partner: "miswag",
    mode: { $ne: "preview" },
    status: "running",
  }).sort({
    createdAt: -1,
  });
  if (!job) return null;
  if (activeRunner?.jobId === String(job._id)) return job;
  setImmediate(() => runJobLoop(job._id));
  return job;
}

export async function getLatestMiswagSyncJob() {
  await ensureMiswagSyncRunner();
  const job = await MiswagSyncJob.findOne({ partner: "miswag" }).sort({ createdAt: -1 });
  if (!job) return { job: null };
  const failures = await MiswagSyncProductResult.find({
    jobId: job._id,
    status: { $in: ["FAILED", "SKIPPED"] },
  })
    .sort({ updatedAt: -1 })
    .limit(25)
    .lean();
  return {
    job: publicJob(job, {
      recentFailures: failures.map((row) => ({
        productId: row.productId,
        sku: row.sku,
        status: row.status,
        reason: row.reason,
        httpStatus: row.httpStatus,
        externalId: row.externalId,
      })),
    }),
  };
}

export async function runMiswagSyncPreview({ strategy = "full" } = {}) {
  const context = await prepareContext();
  const requested = normalizeStrategy(strategy);
  const total = await Product.countDocuments({});
  const job = await MiswagSyncJob.create({
    partner: "miswag",
    status: "preview",
    mode: "preview",
    strategy: requested,
    batchSize: MISWAG_SYNC_BATCH_SIZE,
    total,
    startedAt: new Date(),
  });

  const counters = {
    processed: 0,
    ready: 0,
    inactive: 0,
    skipped: 0,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    missingCategory: 0,
    missingBrand: 0,
    missingColor: 0,
    missingImage: 0,
    missingData: 0,
    otherBlocked: 0,
  };
  const blockedSamples = [];
  let cursor = "";

  while (true) {
    const filter = cursor ? { ibsherId: { $gt: cursor } } : {};
    const batch = await Product.find(filter).sort({ ibsherId: 1 }).limit(MISWAG_SYNC_BATCH_SIZE).lean();
    if (!batch.length) break;

    const evaluated = [];
    for (const doc of batch) {
      evaluated.push(await evaluateOneProduct(doc, context));
    }
    const annotated = await annotateChangeTypes(evaluated);

    for (const result of annotated) {
      counters.processed += 1;
      cursor = String(result.ibsherId || "");

      if (result.status === "READY") {
        counters.ready += 1;
        countChange(counters, result);
      } else if (result.status === "INACTIVE") {
        counters.inactive += 1;
      } else {
        counters.skipped += 1;
        const bucket = classifyBlocked(result);
        counters[bucket] = (counters[bucket] || 0) + 1;
        if (blockedSamples.length < 40) {
          blockedSamples.push({
            productId: result.productId,
            sku: result.sku,
            status: result.status,
            reason: result.reason,
            externalId: result.externalId,
          });
        }
      }

      await upsertResult(job._id, {
        productId: result.productId,
        ibsherId: result.ibsherId,
        externalId: result.externalId,
        sku: result.sku,
        status: result.status === "READY" ? "READY" : result.status,
        httpStatus: 0,
        reason:
          result.status === "READY" && result.changeType === "unchanged"
            ? "Unchanged — checked locally, not sent to Miswag"
            : result.reason || "",
        ...(result.changeType ? { changeType: result.changeType } : {}),
      });
    }

    job.processed = counters.processed;
    job.ready = counters.ready;
    job.inactive = counters.inactive;
    job.skipped = counters.skipped;
    job.newCount = counters.newCount;
    job.changedCount = counters.changedCount;
    job.unchangedCount = counters.unchangedCount;
    job.missingCategory = counters.missingCategory;
    job.missingBrand = counters.missingBrand;
    job.missingColor = counters.missingColor;
    job.missingImage = counters.missingImage;
    job.missingData = counters.missingData;
    job.otherBlocked = counters.otherBlocked;
    job.cursorIbsherId = cursor;
    job.categoryAttempted = context.stats.categoryAttempted;
    job.categoryResolved = context.stats.categoryResolved;
    job.brandAttempted = context.stats.brandAttempted;
    job.brandResolved = context.stats.brandResolved;
    await job.save();
  }

  job.status = "preview";
  job.finishedAt = new Date();
  await job.save();

  return {
    dryRun: true,
    sentToMiswag: 0,
    strategy: requested,
    scanned: job.processed,
    batchSize: MISWAG_SYNC_BATCH_SIZE,
    batchSizeReason:
      "No documented bulk-create max found; reused prior Miswag seller client BATCH_SIZE=15 (one item per POST /v1/items/bulk-create).",
    mappedCollections: context.mappingCount,
    job: publicJob(job, { blockedSamples }),
  };
}

async function processSyncBatch(job, context) {
  const filter = job.cursorIbsherId ? { ibsherId: { $gt: job.cursorIbsherId } } : {};
  const batch = await Product.find(filter).sort({ ibsherId: 1 }).limit(job.batchSize || MISWAG_SYNC_BATCH_SIZE);
  if (!batch.length) {
    job.status = "completed";
    job.finishedAt = new Date();
    await job.save();
    return { done: true };
  }

  const evaluated = [];
  for (const doc of batch) {
    const fresh = await MiswagSyncJob.findById(job._id).select("status");
    if (!fresh || fresh.status !== "running") {
      return { done: true, stopped: true };
    }
    evaluated.push(await evaluateOneProduct(doc, context));
  }
  const annotated = await annotateChangeTypes(evaluated);
  const strategy = storedStrategy(job);

  for (let index = 0; index < batch.length; index += 1) {
    const doc = batch[index];
    const result = annotated[index];
    const fresh = await MiswagSyncJob.findById(job._id).select("status");
    if (!fresh || fresh.status !== "running") {
      return { done: true, stopped: true };
    }

    job.processed += 1;
    job.cursorIbsherId = String(doc.ibsherId || "");
    job.categoryAttempted = context.stats.categoryAttempted;
    job.categoryResolved = context.stats.categoryResolved;
    job.brandAttempted = context.stats.brandAttempted;
    job.brandResolved = context.stats.brandResolved;

    if (result.status === "INACTIVE") {
      job.inactive += 1;
      await upsertResult(job._id, { ...result, status: "INACTIVE" });
      await job.save();
      continue;
    }

    if (result.status !== "READY") {
      job.skipped += 1;
      const bucket = classifyBlocked(result);
      job[bucket] = (job[bucket] || 0) + 1;
      await upsertResult(job._id, { ...result, status: "SKIPPED" });
      await job.save();
      continue;
    }

    job.ready += 1;
    countChange(job, result);

    if (strategy === "changed" && result.changeType === "unchanged") {
      await upsertResult(job._id, {
        productId: result.productId,
        ibsherId: result.ibsherId,
        externalId: result.externalId,
        sku: result.sku,
        status: "READY",
        httpStatus: 0,
        reason: "Unchanged — checked locally, not sent to Miswag",
        changeType: "unchanged",
      });
      await job.save();
      continue;
    }

    const sent = await sendWithRetry(result.payload);
    if (sent.authFailed) {
      job.status = "auth_failed";
      job.pausedAt = new Date();
      job.failureSummary = sent.message || "Authentication/access failed";
      job.lastError = sent.message || "";
      await upsertResult(job._id, {
        productId: result.productId,
        ibsherId: result.ibsherId,
        externalId: result.externalId,
        sku: result.sku,
        status: "FAILED",
        httpStatus: sent.httpStatus,
        reason: sent.message,
        ...(result.changeType ? { changeType: result.changeType } : {}),
      });
      await job.save();
      await logMiswagSafe("sync-all-auth-pause", {
        jobId: String(job._id),
        httpStatus: sent.httpStatus,
        productId: result.productId,
      });
      return { done: true, authFailed: true };
    }

    if (sent.ok) {
      job.success += 1;
      const miswagProductId = await recordAcceptedPayload(result, sent);
      await upsertResult(job._id, {
        productId: result.productId,
        ibsherId: result.ibsherId,
        externalId: result.externalId,
        sku: result.sku,
        status: "SYNCED",
        httpStatus: sent.httpStatus,
        reason: "",
        miswagProductId,
        ...(result.changeType ? { changeType: result.changeType } : {}),
      });
    } else {
      job.failed += 1;
      job.lastError = sent.message || "";
      await upsertResult(job._id, {
        productId: result.productId,
        ibsherId: result.ibsherId,
        externalId: result.externalId,
        sku: result.sku,
        status: "FAILED",
        httpStatus: sent.httpStatus,
        reason: sent.message || "Miswag sync failed",
        ...(result.changeType ? { changeType: result.changeType } : {}),
      });
    }
    await job.save();
  }

  return { done: false };
}

async function runJobLoop(jobId) {
  if (activeRunner?.jobId === String(jobId)) return;
  activeRunner = { jobId: String(jobId) };
  try {
    let context = await prepareContext();
    while (true) {
      const job = await MiswagSyncJob.findById(jobId);
      if (!job || job.status !== "running") break;
      const step = await processSyncBatch(job, context);
      if (step.done) break;
      // Yield between batches so pause/stop can take effect.
      await sleep(25);
    }
  } catch (err) {
    const missing =
      err?.name === "DocumentNotFoundError" || /No document found for query/i.test(String(err?.message || ""));
    if (!missing) {
      const job = await MiswagSyncJob.findById(jobId);
      if (job && job.status === "running") {
        job.status = "failed";
        job.lastError = sanitizeMiswagText(err.message || "Sync failed");
        job.finishedAt = new Date();
        await job.save();
      }
      console.error("Miswag sync-all failed:", err?.message || err);
    }
  } finally {
    if (activeRunner?.jobId === String(jobId)) activeRunner = null;
  }
}

export async function startMiswagSyncAll({
  confirm = false,
  strategy = "full",
  previewJobId,
} = {}) {
  if (confirm !== true) {
    throw new MiswagError("Confirm Start Sync after reviewing the dry-run preview.", {
      status: 400,
      code: "confirm_required",
    });
  }
  await assertMiswagSyncAllowed();
  const requested = normalizeStrategy(strategy);

  // Preview-mode jobs are not the single active sync, so a running preview cannot be sent.
  const running = await MiswagSyncJob.findOne({
    partner: "miswag",
    mode: { $ne: "preview" },
    status: { $in: ["running", "paused"] },
  });
  if (running?.status === "running") {
    // Backend may have restarted — re-attach the in-process runner without resetting cursor.
    if (activeRunner?.jobId !== String(running._id)) {
      setImmediate(() => runJobLoop(running._id));
    }
    return { job: publicJob(running), message: "A Miswag sync job is already running." };
  }
  if (running?.status === "paused") {
    if (storedStrategy(running) !== requested) {
      throw new MiswagError(
        "A Miswag sync job is already active. Resume or stop it before starting another.",
        { status: 409, code: "sync_active" }
      );
    }
    running.status = "running";
    running.pausedAt = null;
    running.mode = "sync";
    await running.save();
    setImmediate(() => runJobLoop(running._id));
    return { job: publicJob(running), message: "Resumed paused Miswag sync job." };
  }

  // Authorization only. The new sync still classifies the current payload itself.
  if (requested === "changed") await assertCompletedChangedPreview(previewJobId);

  const total = await Product.countDocuments({});
  const job = await MiswagSyncJob.create({
    partner: "miswag",
    status: "running",
    mode: "sync",
    strategy: requested,
    batchSize: MISWAG_SYNC_BATCH_SIZE,
    total,
    startedAt: new Date(),
    cursorIbsherId: "",
  });
  setImmediate(() => runJobLoop(job._id));
  return {
    job: publicJob(job),
    message:
      requested === "changed"
        ? "Changed sync started. Unchanged products are checked locally and are not sent."
        : "Miswag sync started.",
  };
}

export async function pauseMiswagSyncAll() {
  const job = await MiswagSyncJob.findOne({ partner: "miswag", status: "running" }).sort({
    createdAt: -1,
  });
  if (!job) throw new MiswagError("No running Miswag sync job to pause.", { status: 404 });
  job.status = "paused";
  job.pausedAt = new Date();
  await job.save();
  return { job: publicJob(job) };
}

export async function resumeMiswagSyncAll() {
  await assertMiswagSyncAllowed();
  const job = await MiswagSyncJob.findOne({
    partner: "miswag",
    status: { $in: ["paused", "auth_failed"] },
  }).sort({ createdAt: -1 });
  if (!job) throw new MiswagError("No paused Miswag sync job to resume.", { status: 404 });
  if (job.status === "auth_failed") {
    // Require connection still healthy before continuing.
    await assertMiswagSyncAllowed();
  }
  job.status = "running";
  job.pausedAt = null;
  job.lastError = "";
  await job.save();
  setImmediate(() => runJobLoop(job._id));
  return { job: publicJob(job) };
}

export async function stopMiswagSyncAll() {
  const job = await MiswagSyncJob.findOne({
    partner: "miswag",
    status: { $in: ["running", "paused", "auth_failed"] },
  }).sort({ createdAt: -1 });
  if (!job) throw new MiswagError("No active Miswag sync job to stop.", { status: 404 });
  job.status = "stopped";
  job.finishedAt = new Date();
  await job.save();
  return { job: publicJob(job) };
}

/** Test helper: evaluate one product without sending. */
export async function evaluateMiswagProductForSync(doc, overrides = {}) {
  let mappingByCollection = overrides.mappingByCollection;
  if (!mappingByCollection) {
    mappingByCollection = await loadMiswagCategoryMappingMap();
  }
  const colorMap = overrides.colorMap || (await loadMiswagColorMappingMap());
  const brandMappingMap = overrides.brandMappingMap || (await loadMiswagBrandMappingMap());
  const context = {
    rules: overrides.rules || [],
    eligibility: overrides.eligibility || { partnerActive: true, inactive: {}, taxonomyRequired: false },
    mappingByCollection,
    colorMap,
    brandMappingMap,
    brandCache: overrides.brandCache || createBrandResolverCache(),
    stats: { categoryAttempted: 0, categoryResolved: 0, brandAttempted: 0, brandResolved: 0 },
  };
  return evaluateOneProduct(doc, context);
}

export { evaluateOneProduct as evaluateMiswagSyncProduct };
