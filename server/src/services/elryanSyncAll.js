import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { ElryanConfirmedSend } from "../models/ElryanConfirmedSend.js";
import { ElryanSyncJob } from "../models/ElryanSyncJob.js";
import { ElryanSyncProductResult } from "../models/ElryanSyncProductResult.js";
import { Product } from "../models/Product.js";
import { inspectElryanAttributeValues } from "../utils/elryanAttributeSet.js";
import { ELRYAN_READINESS, ELRYAN_PATHS, elryanProductWritesEnabled } from "../utils/elryanConstants.js";
import {
  ELRYAN_PACKAGE_DIMENSIONS_NOTE,
  ELRYAN_PRICING_NOTE,
  buildElryanPricingView,
  elryanOutboundPriceHash,
} from "../utils/elryanPricing.js";
import { buildElryanProductPayload, collectElryanImageUrls } from "../utils/elryanPayloadBuilder.js";
import { verifyElryanPublicImages } from "../utils/elryanImages.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { evaluatePlatformEligibility } from "../utils/platformEligibility.js";
import { elryanParentCategoryBlocker, validateElryanPreviewParts } from "../utils/elryanValidator.js";
import { assessElryanSellableUnits } from "../utils/elryanVariations.js";
import { toResolvedProduct } from "../utils/productView.js";
import {
  collectElryanWarrantyRows,
  normalizeElryanWarrantyCatalog,
  uncheckedWarrantyCatalog,
} from "../utils/elryanWarranty.js";
import {
  brownColourKeyFromResolved,
  listElryanValueMappings,
} from "./elryanAttributeMapping.js";
import {
  elryanBrandWarrantySubject,
  explicitElryanProductWarrantyKey,
  resolveElryanWarrantyFromRows,
} from "../utils/elryanWarrantyResolve.js";
import { resolveElryanScopedValue } from "../utils/elryanValueResolve.js";
import { brownCollectionIdentity, resolveElryanDimensions } from "../utils/elryanDimensionResolve.js";
import { elryanDimensionBlockers } from "../utils/elryanStagingGate.js";
import { ElryanClientError, elryanRequest } from "./elryanClient.js";
import { resolveElryanConfig } from "./elryanConnection.js";
import {
  loadAllElryanCollectionDimensionRules,
  loadElryanDimensionInputs,
} from "./elryanCollectionDimensions.js";

export const ELRYAN_SYNC_PREVIEW_BATCH = 25;

const loopToken = new Map();
const control = new Map();
let beforeBatch = null;
let batchSizeOverride = 0;

export function setElryanSyncTestHook(fn) {
  beforeBatch = typeof fn === "function" ? fn : null;
}

export function setElryanSyncBatchSizeForTests(size) {
  batchSizeOverride = Number.isInteger(size) && size > 0 ? size : 0;
}

export function resetElryanSyncRuntimeForTests() {
  loopToken.clear();
  control.clear();
  beforeBatch = null;
  batchSizeOverride = 0;
}

function batchSize() {
  return batchSizeOverride || ELRYAN_SYNC_PREVIEW_BATCH;
}

function jobError(message, status, code) {
  const error = new ElryanClientError(message, { status, code, classification: "READ" });
  return error;
}

function activeId(jobId) {
  return String(jobId || "");
}

function loopIsCurrent(jobId, token) {
  const id = activeId(jobId);
  return loopToken.get(id) === token && control.get(id) === "running";
}

function kick(jobId) {
  const id = activeId(jobId);
  const token = (Number(loopToken.get(id)) || 0) + 1;
  loopToken.set(id, token);
  control.set(id, "running");
  setImmediate(() => {
    runPreviewLoop(id, token).catch(() => {});
  });
}

function mappingAttributes(mappingValues, environment) {
  const nested = mappingValues?.environments?.[environment]?.attributes;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  if (mappingValues?.attributes && typeof mappingValues.attributes === "object" && !Array.isArray(mappingValues.attributes)) {
    return mappingValues.attributes;
  }
  return {};
}

function rowsOfKind(rows, kind) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.kind === kind);
}

function isMissingRequired(code) {
  return (
    code === "missing_name" ||
    code === "missing_image" ||
    code === "image_unreachable" ||
    code === "missing_sku" ||
    code === "attribute_set_unverified" ||
    code === "price_needs_review" ||
    code === "invalid_platform_price" ||
    code.startsWith("missing_attribute_") ||
    code.startsWith("unverified_attribute_") ||
    code.startsWith("sku_")
  );
}

function isVariation(code) {
  return (
    code === "missing_variant" ||
    code === "multi_variant_unverified" ||
    code === "multi_size_unverified" ||
    code === "multi_colour_unverified" ||
    code === "per_size_sku_divergence" ||
    code === "per_size_price_divergence"
  );
}

function publicJob(job, extras = {}) {
  const raw = typeof job?.toObject === "function" ? job.toObject() : job || {};
  const total = Number(raw.total) || 0;
  const processed = Number(raw.processed) || 0;
  return {
    id: raw._id ? String(raw._id) : "",
    environment: raw.environment || "staging",
    status: raw.status || "",
    mode: "preview",
    strategy: raw.strategy === "changed" ? "changed" : "full",
    batchSize: raw.batchSize || ELRYAN_SYNC_PREVIEW_BATCH,
    total,
    processed,
    scanned: processed,
    ready: raw.ready || 0,
    newCount: raw.newCount || 0,
    changedCount: raw.changedCount || 0,
    unchangedCount: raw.unchangedCount || 0,
    skipped: raw.skipped || 0,
    inactive: raw.inactive || 0,
    failed: raw.failed || 0,
    missingCategory: raw.missingCategory || 0,
    missingBrand: raw.missingBrand || 0,
    missingColor: raw.missingColor || 0,
    warrantyUnverified: raw.warrantyUnverified || 0,
    pricingUnverified: raw.pricingUnverified || 0,
    missingRequired: raw.missingRequired || 0,
    variationBlocked: raw.variationBlocked || 0,
    sentToElryan: 0,
    percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
    warrantySummary: raw.warrantySummary || null,
    pricingSummary: raw.pricingSummary || null,
    packageDimensions: raw.packageDimensions || null,
    lastError: raw.lastError || "",
    startedAt: raw.startedAt || null,
    finishedAt: raw.finishedAt || null,
    pausedAt: raw.pausedAt || null,
    createdAt: raw.createdAt || null,
    productWritesEnabled: elryanProductWritesEnabled(),
    liveWritesAllowed: false,
    dimensionSummary: raw.dimensionSummary || {
      productOverride: 0,
      collectionAuto: 0,
      suggested: 0,
      missing: 0,
      invalid: 0,
    },
    ...extras,
  };
}

function bumpDimensionSummary(job, result) {
  if (result.status === "INACTIVE" || result.status === "FAILED") return;
  if (!job.dimensionSummary) {
    job.dimensionSummary = {
      productOverride: 0,
      collectionAuto: 0,
      suggested: 0,
      missing: 0,
      invalid: 0,
    };
  }
  if (result.dimensionSource === "PRODUCT_OVERRIDE") job.dimensionSummary.productOverride += 1;
  else if (result.dimensionSource === "COLLECTION_AUTO") job.dimensionSummary.collectionAuto += 1;
  else if (result.dimensionSource === "SUGGESTED") job.dimensionSummary.suggested += 1;
  else if (result.dimensionReason === "invalid_dimensions") job.dimensionSummary.invalid += 1;
  else job.dimensionSummary.missing += 1;
  job.markModified("dimensionSummary");
}

function tally(job, result) {
  job.processed += 1;
  bumpDimensionSummary(job, result);
  const codes = result.blockerCodes || [];
  if (result.status === "FAILED") {
    job.failed += 1;
    return;
  }
  if (result.status === "INACTIVE") {
    job.inactive += 1;
    return;
  }
  if (codes.includes("missing_category_mapping") || codes.includes("category_not_leaf")) job.missingCategory += 1;
  if (codes.includes("missing_brand_mapping")) job.missingBrand += 1;
  if (codes.includes("missing_color_mapping")) job.missingColor += 1;
  if (codes.includes("warranty_unverified") || codes.includes("missing_warranty_mapping")) job.warrantyUnverified += 1;
  if (codes.includes("pricing_unverified")) job.pricingUnverified += 1;
  if (codes.some(isMissingRequired)) job.missingRequired += 1;
  if (codes.some(isVariation)) job.variationBlocked += 1;
  if (result.status === "READY") {
    job.ready += 1;
    if (result.changeType === "new") job.newCount += 1;
    else if (result.changeType === "changed") job.changedCount += 1;
    else if (result.changeType === "unchanged") job.unchangedCount += 1;
    return;
  }
  job.skipped += 1;
}

async function loadWarrantyCatalog(config) {
  if (!config?.hasApiKey) {
    return uncheckedWarrantyCatalog(
      "WARRANTY_UNVERIFIED. No Elryan API key is stored, so the warranty list was not read."
    );
  }
  try {
    const collected = await collectElryanWarrantyRows(async (query) => {
      const result = await elryanRequest({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        path: ELRYAN_PATHS.warranty,
        method: "GET",
        query,
        classification: "READ",
        retries: 0,
      });
      if (!result.ok) {
        return {
          ok: false,
          httpStatus: result.httpStatus,
          json: result.json,
          message: sanitizeElryanText(
            result.text || `Warranty list returned HTTP ${result.httpStatus}`,
            [config.apiKey]
          ),
        };
      }
      return result;
    });
    const catalog = normalizeElryanWarrantyCatalog(collected.rows, collected.httpStatus);
    catalog.pagination = collected.pagination;
    return catalog;
  } catch (err) {
    const catalog = uncheckedWarrantyCatalog(
      sanitizeElryanText(err?.message || "Warranty list could not be read.", [config.apiKey])
    );
    catalog.httpStatus = Number(err?.httpStatus) || 0;
    return catalog;
  }
}

async function prepareContext(environment) {
  const config = await resolveElryanConfig({ environment });
  const [rules, eligibility, mappings, warrantyCatalog, snapshot] = await Promise.all([
    Commission.find({ partner: "elryan", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("elryan"),
    listElryanValueMappings(),
    loadWarrantyCatalog(config),
    ElryanCategoryCatalogSnapshot.findOne({ environment }).select("categories").lean(),
  ]);
  const categoryIndex = new Map();
  for (const row of snapshot?.categories || []) {
    if (row?.id == null) continue;
    categoryIndex.set(String(row.id), row);
  }
  return {
    environment,
    config,
    rules,
    eligibility,
    brandRows: rowsOfKind(mappings, "brand"),
    colorRows: rowsOfKind(mappings, "color"),
    warrantyRows: mappings.filter((row) => row?.kind === "warranty"),
    warrantyCatalog,
    categoryIndex,
    attributeSets: new Map(),
    collectionDimensions:
      environment === "staging" ? await loadAllElryanCollectionDimensionRules() : new Map(),
  };
}

async function attributeInspection(context, categoryId, attributes) {
  const id = String(categoryId || "").trim();
  if (!id) return { requiredCodes: [], rejectedCodes: [], unverified: false, attributeSet: null };
  if (!context.attributeSets.has(id)) {
    if (!context.config?.hasApiKey) {
      context.attributeSets.set(id, { unverified: true, attributeSet: null });
    } else {
      try {
        const result = await elryanRequest({
          baseUrl: context.config.baseUrl,
          apiKey: context.config.apiKey,
          path: ELRYAN_PATHS.attributeSetForCategory(id),
          method: "GET",
          classification: "READ",
          retries: 0,
        });
        const attributeSet = result.ok ? result.json?.data || null : null;
        context.attributeSets.set(id, {
          unverified: !result.ok && result.httpStatus !== 404,
          attributeSet: attributeSet && typeof attributeSet === "object" ? attributeSet : null,
        });
      } catch {
        context.attributeSets.set(id, { unverified: true, attributeSet: null });
      }
    }
  }
  const cached = context.attributeSets.get(id);
  const inspected = inspectElryanAttributeValues(cached.attributeSet, attributes);
  return { ...inspected, unverified: cached.unverified === true, attributeSet: cached.attributeSet };
}

function lookupWarranty(context, doc) {
  return resolveElryanWarrantyFromRows(context.warrantyRows, {
    environment: context.environment,
    explicitKey: explicitElryanProductWarrantyKey(doc),
    brandId: elryanBrandWarrantySubject(doc),
  }).mapping;
}

export async function evaluateElryanProductForSync(doc, context, { origin = "", dimensionRow = null, excluded = false } = {}) {
  const productId = String(doc._id);
  const resolved = toResolvedProduct(doc);
  const sku = resolved?.sku || doc.itemCode || "";
  const eligibility = evaluatePlatformEligibility(doc, context.eligibility);
  if (!eligibility.eligible) {
    return {
      productId,
      sku,
      status: "INACTIVE",
      reason: eligibility.reasons?.[0]?.message || "Inactive / excluded",
      blockerCodes: ["inactive"],
      changeType: "",
      payloadHash: "",
      readiness: "INACTIVE",
    };
  }

  const mapping = taxonomyValuesForProduct(doc, context.eligibility) || {};
  const variation = assessElryanSellableUnits(resolved);
  const brandKey = String(doc.brand?._id || doc.brand?.id || "").trim().toLowerCase();
  const brand = brandKey
    ? resolveElryanScopedValue(context.brandRows, { environment: context.environment, subject: brandKey })?.row || null
    : null;
  const colourKey = brownColourKeyFromResolved(resolved, variation);
  const color = colourKey
    ? resolveElryanScopedValue(context.colorRows, { environment: context.environment, subject: colourKey })?.row || null
    : null;
  const warranty = lookupWarranty(context, doc);
  const attributes = mappingAttributes(mapping, context.environment);
  const collectionIdentity = brownCollectionIdentity(doc);
  const dimensions = resolveElryanDimensions({
    environment: context.environment,
    product: doc,
    dimensionRow: context.environment === "staging" ? dimensionRow : null,
    collectionRule:
      context.environment === "staging" && !collectionIdentity.ambiguous
        ? context.collectionDimensions?.get(collectionIdentity.collectionId) || null
        : null,
    excluded: context.environment === "staging" && excluded === true,
  });
  const extraBlockers = [...elryanDimensionBlockers(dimensions)];
  const category = mapping.categoryId ? context.categoryIndex.get(String(mapping.categoryId)) : null;
  const parentBlock = elryanParentCategoryBlocker(category);
  if (parentBlock) extraBlockers.push(parentBlock);
  const attributeInfo = await attributeInspection(context, mapping.categoryId, attributes);
  const pricing = await buildElryanPricingView(doc, { commissionRules: context.rules });
  const images = collectElryanImageUrls(resolved);
  extraBlockers.push(...(await verifyElryanPublicImages(images)));
  const validation = validateElryanPreviewParts({
    hasApiKey: Boolean(context.config?.hasApiKey),
    resolved,
    sku,
    mapping,
    brand,
    color,
    warranty,
    warrantyCatalog: context.warrantyCatalog,
    attributes,
    requiredAttributeCodes: attributeInfo.requiredCodes,
    rejectedAttributeCodes: attributeInfo.rejectedCodes,
    attributeSetUnverified: attributeInfo.unverified,
    variation,
    pricing,
    images,
    extraBlockers,
  });
  const qty = resolved?.outOfStock ? 0 : Math.max(0, Math.floor(Number(resolved?.stock) || 0));
  const payload = buildElryanProductPayload({
    resolved,
    sku,
    mapping,
    brand,
    color,
    warranty,
    attributes,
    pricing,
    dimensions,
    origin,
    quantity: qty,
  });
  const ready = validation.ready === true && validation.readiness === ELRYAN_READINESS.READY;
  const primary = validation.blockers.find((blocker) => blocker.status === validation.readiness)
    || validation.blockers[0];
  const reason = primary?.message || primary?.code || "";
  return {
    productId,
    sku,
    status: ready ? "READY" : "SKIPPED",
    reason,
    blockerCodes: validation.blockers.map((blocker) => blocker.code),
    changeType: "",
    payloadHash: ready ? elryanOutboundPriceHash(payload, pricing.pricingSource) : "",
    readiness: validation.readiness,
    dimensionSource: dimensions.source,
    dimensionReason: dimensions.reason,
  };
}

async function classifyChanged(environment, results) {
  if (!results.length) return results;
  const ids = results.filter((row) => row.status === "READY").map((row) => row.productId);
  if (!ids.length) return results;
  const priors = await ElryanConfirmedSend.find({
    environment,
    productId: { $in: ids },
  })
    .select("productId payloadHash httpStatus confirmedAt")
    .lean();
  const byProduct = new Map(priors.map((row) => [row.productId, row]));
  return results.map((row) => {
    if (row.status !== "READY") return { ...row, changeType: "" };
    const prior = byProduct.get(row.productId);
    const confirmed =
      prior &&
      prior.payloadHash &&
      Number(prior.httpStatus) >= 200 &&
      Number(prior.httpStatus) < 300 &&
      prior.confirmedAt;
    let changeType = "new";
    if (confirmed && prior.payloadHash === row.payloadHash) changeType = "unchanged";
    else if (confirmed) changeType = "changed";
    return {
      ...row,
      changeType,
      reason:
        changeType === "unchanged"
          ? "Unchanged against the last confirmed Elryan send. Not sent again."
          : row.reason,
    };
  });
}

async function activeEnvironment() {
  const config = await resolveElryanConfig();
  return config.environment === "production" ? "production" : "staging";
}

async function recentBlocked(jobId) {
  const rows = await ElryanSyncProductResult.find({
    jobId,
    status: { $in: ["SKIPPED", "FAILED", "INACTIVE"] },
  })
    .sort({ updatedAt: -1 })
    .limit(30)
    .lean();
  return rows.map((row) => ({
    productId: row.productId,
    sku: row.sku,
    status: row.status,
    reason: row.reason,
    changeType: row.changeType || "",
    blockerCodes: row.blockerCodes || [],
    readiness: row.readiness || "",
  }));
}

export async function getElryanSyncAllStatus() {
  const environment = await activeEnvironment();
  const running = await ElryanSyncJob.findOne({
    environment,
    status: "running",
    mode: "preview",
  }).sort({ createdAt: -1 });
  if (running && !(control.get(String(running._id)) === "running" && loopToken.has(String(running._id)))) {
    kick(running._id);
  }
  const job =
    (await ElryanSyncJob.findOne({
      environment,
      status: { $in: ["running", "paused"] },
    }).sort({ createdAt: -1 })) ||
    (await ElryanSyncJob.findOne({ environment }).sort({ createdAt: -1 }));
  if (!job) {
    return {
      job: null,
      environment,
      sentToElryan: 0,
      productWritesEnabled: elryanProductWritesEnabled(),
    };
  }
  const blockedSamples = await recentBlocked(job._id);
  return {
    job: publicJob(job, { blockedSamples }),
    environment,
    dryRun: true,
    sentToElryan: 0,
    productWritesEnabled: elryanProductWritesEnabled(),
  };
}

function summaries(context) {
  const catalog = context.warrantyCatalog;
  return {
    warrantySummary: {
    status: !catalog.checked || catalog.empty ? ELRYAN_READINESS.WARRANTY_UNVERIFIED : "LIST_LOADED",
      checked: catalog.checked === true,
      httpStatus: catalog.httpStatus || 0,
      catalogCount: catalog.codes?.length || 0,
      items: catalog.items || [],
      message: catalog.message || "Warranty codes were confirmed against GET /v1/warranty.",
      contract:
        "Product create describes warrantyCode as required. The OpenAPI required array does not declare it. GET /v1/warranty documents an empty list when the vendor has created none, and vendors create their own. Warranty is not described as category-specific. No code was invented, and missing_warranty_mapping is still applied when no code is mapped.",
    },
    pricingSummary: {
      status: "BROWNSTORE_RULES",
      message: ELRYAN_PRICING_NOTE,
    },
    packageDimensions: {
      status: "RESOLVED_PER_PRODUCT",
      note: `${ELRYAN_PACKAGE_DIMENSIONS_NOTE} Sync All uses the same Staging dimension resolver as Sync One. A collection AUTO_APPLY rule is used only after an operator confirms that collection. Unverified products are not READY. Nothing is sent.`,
    },
  };
}

export async function runElryanSyncPreview({ strategy = "full", origin = "" } = {}) {
  const requested = strategy === "changed" ? "changed" : "full";
  const config = await resolveElryanConfig();
  const environment = config.environment === "production" ? "production" : "staging";
  const active = await ElryanSyncJob.findOne({
    environment,
    status: { $in: ["running", "paused"] },
  });
  if (active) {
    throw jobError(
      "An Elryan preview is already active for this environment. Pause, resume, or stop it before starting another.",
      409,
      "sync_active"
    );
  }
  const total = await Product.countDocuments({});
  const job = await ElryanSyncJob.create({
    environment,
    status: "running",
    mode: "preview",
    strategy: requested,
    batchSize: batchSize(),
    total,
    startedAt: new Date(),
    origin: String(origin || ""),
    sentToElryan: 0,
    dimensionSummary: {
      productOverride: 0,
      collectionAuto: 0,
      suggested: 0,
      missing: 0,
      invalid: 0,
    },
  });
  kick(job._id);
  return {
    dryRun: true,
    sentToElryan: 0,
    strategy: requested,
    environment,
    message: requested === "changed" ? "Changed preview started. Nothing is sent to Elryan." : "Full preview started. Nothing is sent to Elryan.",
    job: publicJob(job),
  };
}

async function processPreviewBatch(job, context, token) {
  if (beforeBatch) await beforeBatch(job);
  if (!loopIsCurrent(job._id, token)) return { done: true };
  const size = job.batchSize || batchSize();
  const filter = {};
  if (job.cursorProductId && mongoose.isValidObjectId(job.cursorProductId)) {
    filter._id = { $gt: new mongoose.Types.ObjectId(job.cursorProductId) };
  }
  const batch = await Product.find(filter).sort({ _id: 1 }).limit(size).lean();
  if (!batch.length) return { done: true, finished: true };
  const dimensionInputs = await loadElryanDimensionInputs(
    context.environment,
    batch,
    context.collectionDimensions
  );
  const evaluated = [];
  for (const doc of batch) {
    if (!loopIsCurrent(job._id, token)) return { done: true };
    const productId = String(doc._id);
    try {
      const result = await evaluateElryanProductForSync(doc, context, {
        origin: context.origin || "",
        dimensionRow: dimensionInputs.checks.get(productId) || null,
        excluded: dimensionInputs.exclusions.has(productId),
      });
      evaluated.push(result);
    } catch (err) {
      evaluated.push({
        productId: String(doc._id),
        sku: doc.itemCode || "",
        status: "FAILED",
        reason: sanitizeElryanText(err?.message || "Preview failed", [context.config?.apiKey]),
        blockerCodes: [],
        changeType: "",
        payloadHash: "",
        readiness: "FAILED",
      });
    }
  }
  if (!loopIsCurrent(job._id, token)) return { done: true };
  const withChanges = await classifyChanged(context.environment, evaluated);
  const ops = [];
  for (const result of withChanges) {
    tally(job, result);
    job.cursorProductId = result.productId;
    ops.push({
      updateOne: {
        filter: { jobId: job._id, productId: result.productId },
        update: {
          $set: {
            environment: context.environment,
            sku: result.sku || "",
            status: result.status,
            changeType: result.changeType || "",
            reason: result.reason || "",
            blockerCodes: result.blockerCodes || [],
            payloadHash: result.payloadHash || "",
            readiness: result.readiness || "",
            dimensionSource: result.dimensionSource || "",
          },
        },
        upsert: true,
      },
    });
  }
  if (ops.length) await ElryanSyncProductResult.bulkWrite(ops, { ordered: false });
  await job.save();
  return { done: batch.length < size, finished: batch.length < size };
}

async function runPreviewLoop(jobId, token) {
  const id = activeId(jobId);
  try {
    const existing = await ElryanSyncJob.findById(id);
    if (!existing || existing.status !== "running") return;
    if (loopToken.get(id) !== token) return;
    const context = await prepareContext(existing.environment);
    context.origin = existing.origin || "";
    const notes = summaries(context);
    existing.warrantySummary = notes.warrantySummary;
    existing.pricingSummary = notes.pricingSummary;
    existing.packageDimensions = notes.packageDimensions;
    existing.batchSize = existing.batchSize || batchSize();
    await existing.save();
    while (loopIsCurrent(id, token)) {
      const job = await ElryanSyncJob.findById(id);
      if (!job || !loopIsCurrent(id, token)) break;
      const step = await processPreviewBatch(job, context, token);
      if (!loopIsCurrent(id, token)) break;
      if (step.finished) {
        job.status = "preview";
        job.finishedAt = new Date();
        job.sentToElryan = 0;
        await job.save();
        control.set(id, "preview");
        break;
      }
      if (step.done) break;
    }
  } catch (err) {
    const missing = err?.name === "DocumentNotFoundError" || /No document found/i.test(String(err?.message || ""));
    if (!missing && loopToken.get(id) === token) {
      const job = await ElryanSyncJob.findById(id);
      if (job && job.status === "running") {
        job.status = "failed";
        job.lastError = sanitizeElryanText(err?.message || "Preview failed");
        job.finishedAt = new Date();
        await job.save();
      }
    }
  } finally {
    if (loopToken.get(id) === token) loopToken.delete(id);
  }
}

export async function pauseElryanSyncAll() {
  const environment = await activeEnvironment();
  const job = await ElryanSyncJob.findOne({ environment, status: "running" }).sort({ createdAt: -1 });
  if (!job) throw jobError("No running Elryan preview to pause.", 404, "not_running");
  control.set(String(job._id), "paused");
  job.status = "paused";
  job.pausedAt = new Date();
  await job.save();
  return { job: publicJob(job), sentToElryan: 0 };
}

export async function resumeElryanSyncAll() {
  const environment = await activeEnvironment();
  const job = await ElryanSyncJob.findOne({ environment, status: "paused" }).sort({ createdAt: -1 });
  if (!job) throw jobError("No paused Elryan preview to resume.", 404, "not_paused");
  job.status = "running";
  job.pausedAt = null;
  await job.save();
  kick(job._id);
  return { job: publicJob(job), sentToElryan: 0 };
}

export async function stopElryanSyncAll() {
  const environment = await activeEnvironment();
  const job = await ElryanSyncJob.findOne({
    environment,
    status: { $in: ["running", "paused"] },
  }).sort({ createdAt: -1 });
  if (!job) throw jobError("No active Elryan preview to stop.", 404, "not_active");
  control.set(String(job._id), "stopped");
  loopToken.delete(String(job._id));
  job.status = "stopped";
  job.finishedAt = new Date();
  await job.save();
  return { job: publicJob(job), sentToElryan: 0 };
}

/** Product writes stay refused. This does not call Elryan. */
export async function startElryanSyncAll() {
  return {
    ok: false,
    blocked: true,
    classification: "WRITE",
    code: "writes_disabled",
    productWritesEnabled: elryanProductWritesEnabled(),
    liveWritesAllowed: false,
    sentToElryan: 0,
    message:
      "Elryan product sending is disabled. Start Full Sync and Start Changed Sync stay off until publishing is explicitly approved. No product create, update, or bulk write was called.",
  };
}
