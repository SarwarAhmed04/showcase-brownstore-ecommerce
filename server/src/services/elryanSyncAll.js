import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { ElryanConfirmedSend } from "../models/ElryanConfirmedSend.js";
import { ElryanStagingProductOverride } from "../models/ElryanStagingProductOverride.js";
import { ElryanSyncJob } from "../models/ElryanSyncJob.js";
import { ElryanSyncProductResult } from "../models/ElryanSyncProductResult.js";
import { Product } from "../models/Product.js";
import { inspectElryanAttributeValues, resolveElryanSavedAttributes } from "../utils/elryanAttributeSet.js";
import {
  buildElryanBatchCreateBody,
  buildElryanBatchUpdateBody,
  classifyElryanBatchResult,
  partitionElryanBatchCreates,
  reconcileElryanBatchResult,
} from "../utils/elryanBatch.js";
import {
  ELRYAN_ENVIRONMENTS,
  ELRYAN_READINESS,
  ELRYAN_PATHS,
  elryanLiveProductWritesEnabled,
  elryanProductWritesEnabled,
} from "../utils/elryanConstants.js";
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
import { ELRYAN_FIRST_STAGING_CREATE_SKU, elryanDimensionBlockers } from "../utils/elryanStagingGate.js";
import { ElryanClientError, elryanRequest } from "./elryanClient.js";
import { resolveElryanConfig } from "./elryanConnection.js";
import { executeElryanProductionCreate, productionAccountKey } from "./elryanSyncOne.js";
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
  const env = environment === "production" ? "production" : "staging";
  const nested = mappingValues?.environments?.[env]?.attributes;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  const categoryId = String(mappingValues?.categoryId || "").trim();
  const tagged = String(mappingValues?.elryanEnvironment || "staging").trim().toLowerCase();
  if (!categoryId || tagged !== env) return {};
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
    sentToElryan: Number(raw.sentToElryan) || 0,
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
        query: config.environment === "production" ? { ...(query || {}), fresh: true } : query,
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
    collectionDimensions: await loadAllElryanCollectionDimensionRules(environment),
  };
}

async function attributeInspection(context, categoryId, mappingAttributes, product, override) {
  const id = String(categoryId || "").trim();
  if (!context.attributeSets.has(id)) {
    if (!id || !context.config?.hasApiKey) {
      context.attributeSets.set(id, { unverified: Boolean(id), attributeSet: null });
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
  const cached = context.attributeSets.get(id) || { unverified: false, attributeSet: null };
  const attributes = resolveElryanSavedAttributes({
    environment: context.environment,
    mappingAttributes,
    override: context.environment === "staging" ? override : null,
    attributeSet: cached.attributeSet,
    product,
  });
  const inspected = inspectElryanAttributeValues(cached.attributeSet, attributes);
  return {
    ...inspected,
    attributes,
    unverified: cached.unverified === true,
    attributeSet: cached.attributeSet,
  };
}

function lookupWarranty(context, doc) {
  return resolveElryanWarrantyFromRows(context.warrantyRows, {
    environment: context.environment,
    explicitKey: explicitElryanProductWarrantyKey(doc),
    productId: String(doc?._id || ""),
    sku: String(doc?.overrides?.sku || doc?.itemCode || "").trim(),
    brandId: elryanBrandWarrantySubject(doc),
  }).mapping;
}

export async function evaluateElryanProductForSync(doc, context, { origin = "", dimensionRow = null, excluded = false, productOverride = null } = {}) {
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
  const mappedAttributes = mappingAttributes(mapping, context.environment);
  const collectionIdentity = brownCollectionIdentity(doc);
  const dimensions = resolveElryanDimensions({
    environment: context.environment,
    product: doc,
    dimensionRow,
    collectionRule: collectionIdentity.ambiguous
      ? null
      : context.collectionDimensions?.get(collectionIdentity.collectionId) || null,
    excluded: excluded === true,
  });
  const extraBlockers = [...elryanDimensionBlockers(dimensions)];
  const category = mapping.categoryId ? context.categoryIndex.get(String(mapping.categoryId)) : null;
  const parentBlock = elryanParentCategoryBlocker(category);
  if (parentBlock) extraBlockers.push(parentBlock);
  const attributeInfo = await attributeInspection(
    context,
    mapping.categoryId,
    mappedAttributes,
    doc,
    productOverride
  );
  const attributes = attributeInfo.attributes;
  const pricing = await buildElryanPricingView(doc, { commissionRules: context.rules });
  const images = collectElryanImageUrls(resolved);
  extraBlockers.push(...(await verifyElryanPublicImages(images)));
  const validation = validateElryanPreviewParts({
    environment: context.environment,
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
    payload,
    quantity: qty,
    batchItem: {
      sku: payload.sku,
      brand: brand?.elryanLabel || brand?.brownLabel || "",
      color: color?.elryanLabel || color?.brownLabel || "",
      categoryId: payload.categoryId || "",
      sellingPrice: payload.price,
      quantity: payload.quantity,
      vendorTitle: payload.vendorTitle,
      vendorTitleAr: payload.vendorTitleAr,
      vendorDescription: payload.vendorDescription,
      warrantyCode: payload.warrantyCode,
      images: images,
      width: payload.width,
      height: payload.height,
      depth: payload.depth,
      attributes: payload.attributes,
    },
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
    sentToElryan: Number(job.sentToElryan) || 0,
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
      note: `${ELRYAN_PACKAGE_DIMENSIONS_NOTE} Sync All uses the same dimension resolver as Preview 1 for the active environment. A confirmed collection AUTO_APPLY rule is inherited only in that environment. Unverified products are not READY. Nothing is sent.`,
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
  const overrideByProduct = new Map();
  if (context.environment === "staging") {
    const overrides = await ElryanStagingProductOverride.find({
      environment: "staging",
      productId: { $in: batch.map((doc) => String(doc._id)) },
    }).lean();
    for (const row of overrides) overrideByProduct.set(String(row.productId), row);
  }
  const evaluated = [];
  for (const doc of batch) {
    if (!loopIsCurrent(job._id, token)) return { done: true };
    const productId = String(doc._id);
    try {
      const result = await evaluateElryanProductForSync(doc, context, {
        origin: context.origin || "",
        dimensionRow: dimensionInputs.checks.get(productId) || null,
        excluded: dimensionInputs.exclusions.has(productId),
        productOverride: overrideByProduct.get(productId) || null,
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

function blockedBatch(code, message, extra = {}) {
  return {
    ok: false,
    blocked: true,
    classification: "WRITE",
    code,
    productWritesEnabled: elryanProductWritesEnabled(),
    liveWritesAllowed: elryanLiveProductWritesEnabled(),
    sentToElryan: 0,
    message,
    ...extra,
  };
}

async function readBatchOperation(config, batchId) {
  return elryanRequest({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    path: ELRYAN_PATHS.batchById(batchId),
    method: "GET",
    classification: "READ",
    retries: 0,
  });
}

async function postBatch(config, action, body) {
  return elryanRequest({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    path: action === "update" ? ELRYAN_PATHS.batchUpdate : ELRYAN_PATHS.batchCreate,
    method: "POST",
    classification: "WRITE",
    body,
    retries: 0,
  });
}

async function recordSendOutcomes(job, results) {
  const saved = results.filter((row) => row.outcome === "saved").length;
  if (results.length) {
    await ElryanSyncProductResult.bulkWrite(
      results.map((row) => ({
        updateOne: {
          filter: { jobId: job._id, sku: row.sku },
          update: {
            $set: {
              sendOutcome: row.outcome,
              sendErrors: row.errors || [],
            },
          },
        },
      })),
      { ordered: false }
    );
  }
  job.sentToElryan = (Number(job.sentToElryan) || 0) + saved;
  await job.save();
  return saved;
}

/**
 * Sends a finished preview when both write flags are on.
 * Flags off, Production, and an unreconciled batch do not call product create or update.
 */
export async function startElryanSyncAll({ confirm, strategy } = {}) {
  if (!elryanProductWritesEnabled()) {
    return blockedBatch(
      "writes_disabled",
      "Elryan product sending is disabled. Start Full Sync and Start Changed Sync stay off until publishing is explicitly approved. No product create, update, or bulk write was called."
    );
  }
  if (!elryanLiveProductWritesEnabled()) {
    return blockedBatch(
      "writes_gated",
      "Live Elryan product writes require both write flags. No product create or update was called."
    );
  }
  if (confirm !== true) {
    return blockedBatch("confirm_required", "Bulk send requires confirm=true. No product was sent.");
  }
  const config = await resolveElryanConfig();
  const environment = config.environment === "production" ? "production" : "staging";
  if (environment !== "staging") {
    return blockedBatch(
      "staging_only",
      "Production sending is refused. Staging mappings, dimensions, prices, and permissions are not reused."
    );
  }
  const requested = strategy === "changed" ? "changed" : "full";
  const job = await ElryanSyncJob.findOne({ environment: "staging", status: "preview", strategy: requested }).sort({
    createdAt: -1,
  });
  if (!job) {
    return blockedBatch("preview_required", "Finish a Staging preview before sending. No product was sent.");
  }

  const ambiguous = await ElryanSyncProductResult.find({
    jobId: job._id,
    sendOutcome: "ambiguous",
  })
    .select("sku")
    .lean();
  if (ambiguous.length) {
    if (!job.lastBatchId) {
      return blockedBatch(
        "reconcile_required",
        "A previous batch has no operation id, so it cannot be retried. No product was sent.",
        { results: ambiguous.map((row) => ({ sku: row.sku, outcome: "ambiguous", errors: [] })) }
      );
    }
    let followUp;
    try {
      followUp = await readBatchOperation(config, job.lastBatchId);
    } catch (err) {
      return blockedBatch("reconcile_required", err?.message || "The batch could not be read. No product was sent.", {
        results: ambiguous.map((row) => ({ sku: row.sku, outcome: "ambiguous", errors: [] })),
      });
    }
    const reconciled = reconcileElryanBatchResult(
      { ambiguous: true },
      {
        requestedSkus: ambiguous.map((row) => row.sku),
        httpStatus: followUp.httpStatus,
        json: followUp.ok ? followUp.json : null,
        transportError: followUp.ok ? "" : "batch read failed",
      }
    );
    await recordSendOutcomes(job, reconciled.results);
    if (reconciled.ambiguous) {
      return blockedBatch(
        "reconcile_required",
        "The batch is still ambiguous. It was not sent again.",
        { batchId: job.lastBatchId, results: reconciled.results }
      );
    }
    return {
      ok: true,
      blocked: false,
      classification: "WRITE",
      code: reconciled.partial ? "partial" : "reconciled",
      sentToElryan: reconciled.results.filter((row) => row.outcome === "saved").length,
      results: reconciled.results,
      message: "The earlier batch was reconciled. No second write was sent.",
    };
  }

  const wanted = requested === "changed" ? ["new", "changed"] : ["new", "changed"];
  const ready = await ElryanSyncProductResult.find({
    jobId: job._id,
    status: "READY",
    changeType: { $in: wanted },
  }).lean();
  if (!ready.length) {
    return blockedBatch("nothing_ready", "No new or changed READY products are in this preview. No product was sent.");
  }
  const docs = await Product.find({ _id: { $in: ready.map((row) => row.productId) } }).lean();
  const context = await prepareContext("staging");
  const dimensionInputs = await loadElryanDimensionInputs("staging", docs, context.collectionDimensions);
  const overrides = await ElryanStagingProductOverride.find({
    environment: "staging",
    productId: { $in: docs.map((doc) => String(doc._id)) },
  }).lean();
  const overrideByProduct = new Map(overrides.map((row) => [String(row.productId), row]));
  const byChange = new Map(ready.map((row) => [row.productId, row.changeType]));
  const creates = [];
  const updates = [];
  for (const doc of docs) {
    const evaluated = await evaluateElryanProductForSync(doc, context, {
      dimensionRow: dimensionInputs.checks.get(String(doc._id)) || null,
      excluded: dimensionInputs.exclusions.has(String(doc._id)),
      productOverride: overrideByProduct.get(String(doc._id)) || null,
    });
    if (evaluated.status !== "READY") continue;
    const item = evaluated.batchItem;
    if (byChange.get(String(doc._id)) === "changed") updates.push(item);
    else creates.push(item);
  }

  const confirmed = await ElryanConfirmedSend.find({
    environment: "staging",
    sku: ELRYAN_FIRST_STAGING_CREATE_SKU,
  })
    .select("sku")
    .lean();
  let pilotAvailability = null;
  if (creates.some((item) => item.sku === ELRYAN_FIRST_STAGING_CREATE_SKU)) {
    try {
      const probe = await elryanRequest({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        path: ELRYAN_PATHS.skuExists,
        method: "GET",
        query: { sku: ELRYAN_FIRST_STAGING_CREATE_SKU },
        classification: "READ",
        retries: 0,
      });
      const data = probe.json?.data;
      pilotAvailability = data?.available === true ? true : data?.available === false || probe.httpStatus === 409 ? false : null;
    } catch {
      pilotAvailability = null;
    }
  }
  const partitioned = partitionElryanBatchCreates({
    items: creates,
    confirmedSkus: confirmed.map((row) => row.sku),
    skuAvailability: { [ELRYAN_FIRST_STAGING_CREATE_SKU]: pilotAvailability },
  });

  const results = [...partitioned.results];
  let partial = false;
  async function submit(action, items) {
    if (!items.length) return;
    const body = action === "update" ? buildElryanBatchUpdateBody(items) : buildElryanBatchCreateBody(items);
    let classified;
    try {
      const response = await postBatch(config, action, body);
      classified = classifyElryanBatchResult({
        requestedSkus: items.map((item) => item.sku),
        httpStatus: response.httpStatus,
        json: response.json,
        transportError: response.ok || (response.httpStatus >= 400 && response.httpStatus < 500) ? "" : "batch rejected",
      });
      if (!response.ok && response.httpStatus >= 500) {
        classified = classifyElryanBatchResult({
          requestedSkus: items.map((item) => item.sku),
          httpStatus: 0,
          json: null,
          transportError: "batch rejected",
        });
      }
    } catch (err) {
      classified = classifyElryanBatchResult({
        requestedSkus: items.map((item) => item.sku),
        httpStatus: 0,
        json: null,
        transportError: err?.message || "batch failed",
      });
    }
    if (classified.batchId) job.lastBatchId = classified.batchId;
    if (classified.partial) partial = true;
    results.push(...classified.results);
  }

  await submit("create", partitioned.send);
  await submit("update", updates);
  const saved = await recordSendOutcomes(job, results);
  const ambiguousLeft = results.some((row) => row.outcome === "ambiguous");
  return {
    ok: !ambiguousLeft,
    blocked: ambiguousLeft,
    classification: "WRITE",
    code: ambiguousLeft ? "reconcile_required" : partial ? "partial" : "sent",
    sentToElryan: saved,
    partial,
    results,
    message: ambiguousLeft
      ? "Some SKUs are ambiguous and will not be retried until the batch operation is read."
      : partial
        ? "Elryan saved part of the batch. Failed SKUs were recorded and were not retried."
        : "The Staging batch finished.",
  };
}

const PRODUCTION_SELECTION_LIMIT = 3;
const SELECTION_PAGE_DEFAULT = 50;
const SELECTION_PAGE_MAX = 100;
const AMBIGUOUS_CREATE = new Set(["create_uncertain", "send_uncertain", "create_timeout"]);
const selectionLocks = new Set();

function productLabel(doc) {
  const resolved = toResolvedProduct(doc);
  const name = resolved?.name;
  if (typeof name === "string") return name.trim();
  return String(name?.en || name?.ku || name?.ar || "").trim();
}

function productionAccountReady(config) {
  return (
    config?.environment === "production" &&
    config?.baseUrl === ELRYAN_ENVIRONMENTS.production.baseUrl &&
    Boolean(config?.apiKey)
  );
}

async function quoteProductionRows(job, productIds) {
  const ids = [...new Set(productIds.map((id) => String(id || "")).filter((id) => mongoose.isValidObjectId(id)))];
  const docs = ids.length ? await Product.find({ _id: { $in: ids } }).lean() : [];
  const context = await prepareContext("production");
  context.origin = job?.origin || "";
  const dimensionInputs = await loadElryanDimensionInputs("production", docs, context.collectionDimensions);
  const evaluated = [];
  for (const doc of docs) {
    const id = String(doc._id);
    evaluated.push(
      await evaluateElryanProductForSync(doc, context, {
        origin: job?.origin || "",
        dimensionRow: dimensionInputs.checks.get(id) || null,
        excluded: dimensionInputs.exclusions.has(id),
        productOverride: null,
      })
    );
  }
  const classified = await classifyChanged("production", evaluated);
  const docsById = new Map(docs.map((doc) => [String(doc._id), doc]));
  const quotes = new Map();
  for (const row of classified) {
    const price = Number(row.payload?.price);
    quotes.set(row.productId, {
      productId: row.productId,
      name: productLabel(docsById.get(row.productId)),
      sku: String(row.sku || ""),
      price: Number.isFinite(price) ? price : null,
      stock: Number.isInteger(row.quantity) ? row.quantity : null,
      status: row.status,
      changeType: row.changeType || "",
      payloadHash: row.payloadHash || "",
      payload: row.payload || null,
    });
  }
  return quotes;
}

function publicQuote(quote) {
  return {
    productId: quote.productId,
    name: quote.name,
    sku: quote.sku,
    price: quote.price,
    stock: quote.stock,
  };
}

function selectionPageQuery(input = {}) {
  const page = Math.max(1, Math.floor(Number(input.page)) || 1);
  const requested = Math.floor(Number(input.pageSize));
  const pageSize = Math.min(
    SELECTION_PAGE_MAX,
    Math.max(1, Number.isInteger(requested) && requested > 0 ? requested : SELECTION_PAGE_DEFAULT)
  );
  return { page, pageSize };
}

function emptySelection(code, previewId, message) {
  return {
    ok: false,
    classification: "READ",
    code,
    previewId,
    limit: PRODUCTION_SELECTION_LIMIT,
    page: 1,
    pageSize: SELECTION_PAGE_DEFAULT,
    total: 0,
    pages: 1,
    candidates: [],
    message,
  };
}

/**
 * Name, SKU, price, and stock for one page. This does not recheck readiness
 * or call Elryan. Send-time checks still revalidate the selected rows.
 */
async function pageProductDetails(docs) {
  const rules = docs.length
    ? await Commission.find({ partner: "elryan", isActive: { $ne: false } }).lean()
    : [];
  const details = new Map();
  for (const doc of docs) {
    const resolved = toResolvedProduct(doc);
    const pricing = await buildElryanPricingView(doc, { commissionRules: rules });
    const price = Number(pricing.proposedElryanPrice);
    const stock = resolved?.outOfStock ? 0 : Math.max(0, Math.floor(Number(resolved?.stock) || 0));
    details.set(String(doc._id), {
      name: productLabel(doc),
      sku: String(resolved?.sku || doc.itemCode || "").trim(),
      price: Number.isFinite(price) ? price : null,
      stock: Number.isInteger(stock) ? stock : null,
    });
  }
  return details;
}

/**
 * READ — one page of saved new READY rows from the latest completed Production preview.
 * Nothing is sent, and the saved preview is not revalidated here.
 */
export async function listElryanProductionSelection(input = {}) {
  const config = await resolveElryanConfig();
  if (!productionAccountReady(config)) {
    return emptySelection(
      "production_required",
      "",
      "Choose products from a completed Production preview. The active connection is not Production."
    );
  }
  const latest = await ElryanSyncJob.findOne({ environment: "production" }).sort({ createdAt: -1 });
  if (!latest || latest.status !== "preview") {
    return emptySelection(
      "preview_required",
      latest ? String(latest._id) : "",
      "Finish a Production preview before choosing products. Nothing is sent."
    );
  }
  const requested = selectionPageQuery(input);
  const filter = { jobId: latest._id, status: "READY", changeType: "new" };
  const total = await ElryanSyncProductResult.countDocuments(filter);
  const pages = Math.max(1, Math.ceil(total / requested.pageSize));
  const page = Math.min(requested.page, pages);
  const stored = total
    ? await ElryanSyncProductResult.find(filter)
        .sort({ sku: 1, productId: 1 })
        .skip((page - 1) * requested.pageSize)
        .limit(requested.pageSize)
        .select("productId sku")
        .lean()
    : [];
  const ids = stored.map((row) => row.productId).filter((id) => mongoose.isValidObjectId(id));
  const docs = ids.length ? await Product.find({ _id: { $in: ids } }).lean() : [];
  const details = await pageProductDetails(docs);
  const candidates = stored.map((row) => {
    const detail = details.get(row.productId) || {};
    return {
      productId: row.productId,
      name: detail.name || "",
      sku: detail.sku || row.sku || "",
      price: detail.price ?? null,
      stock: detail.stock ?? null,
    };
  });
  return {
    ok: true,
    classification: "READ",
    code: "ready",
    previewId: String(latest._id),
    environment: "production",
    limit: PRODUCTION_SELECTION_LIMIT,
    page,
    pageSize: requested.pageSize,
    total,
    pages,
    candidates,
    message: total
      ? "These new READY products can be reviewed before a Production create. Existing listings are not updated."
      : "This Production preview has no new READY products to send.",
  };
}

function parseProductionSelection(products) {
  if (!Array.isArray(products) || products.length < 1) {
    return { error: blockedBatch("nothing_selected", "Choose at least one new READY product. No product was sent.") };
  }
  if (products.length > PRODUCTION_SELECTION_LIMIT) {
    return {
      error: blockedBatch("too_many", "This pilot sends at most 3 products. No product was sent."),
    };
  }
  const seen = new Set();
  const rows = [];
  for (const item of products) {
    const productId = String(item?.productId || "").trim();
    const sku = String(item?.sku || "").trim();
    const price = Number(item?.price);
    const stock = Number(item?.stock);
    if (!mongoose.isValidObjectId(productId) || !sku || !Number.isFinite(price) || !Number.isInteger(stock) || stock < 0) {
      return { error: blockedBatch("selection_invalid", "The selected rows are incomplete. No product was sent.") };
    }
    if (seen.has(productId)) {
      return { error: blockedBatch("selection_invalid", "A product was selected more than once. No product was sent.") };
    }
    seen.add(productId);
    rows.push({ productId, sku, price, stock });
  }
  return { rows };
}

/**
 * WRITE — create up to 3 new READY products from one completed Production preview.
 * Full sync, changed sync, and updates to existing listings stay closed.
 */
export async function sendElryanProductionSelection({ previewId, products, confirm } = {}) {
  if (!elryanProductWritesEnabled()) {
    return blockedBatch(
      "writes_disabled",
      "Elryan product publishing is disabled. Both write flags must be true before a Production create. No product was sent."
    );
  }
  if (!elryanLiveProductWritesEnabled()) {
    return blockedBatch(
      "writes_gated",
      "Live Elryan product writes require both write flags. No product was sent."
    );
  }
  if (confirm !== true) {
    return blockedBatch("confirm_required", "Production selection requires explicit confirm=true. No product was sent.");
  }
  const config = await resolveElryanConfig();
  if (!productionAccountReady(config)) {
    return blockedBatch(
      "production_required",
      "Production sending requires the active Production connection. No product was sent."
    );
  }
  const requestedId = String(previewId || "").trim();
  if (!mongoose.isValidObjectId(requestedId)) {
    return blockedBatch("stale_preview", "This Production preview is stale. No product was sent.");
  }
  const latest = await ElryanSyncJob.findOne({ environment: "production" }).sort({ createdAt: -1 });
  if (!latest || latest.status !== "preview" || String(latest._id) !== requestedId) {
    return blockedBatch(
      "stale_preview",
      "This Production preview is stale. Finish the current Production preview and choose the products again. No product was sent."
    );
  }
  const parsed = parseProductionSelection(products);
  if (parsed.error) return parsed.error;
  const stored = await ElryanSyncProductResult.find({
    jobId: latest._id,
    productId: { $in: parsed.rows.map((row) => row.productId) },
  }).lean();
  const storedById = new Map(stored.map((row) => [row.productId, row]));
  for (const row of parsed.rows) {
    const saved = storedById.get(row.productId);
    if (!saved) {
      return blockedBatch("selection_not_in_preview", "A selected product is not on this Production preview. No product was sent.");
    }
    if (saved.changeType === "changed" || saved.changeType === "unchanged") {
      return blockedBatch(
        "updates_not_in_pilot",
        "Updates to existing listings are outside this pilot. No product was sent."
      );
    }
    if (saved.status !== "READY" || saved.changeType !== "new") {
      return blockedBatch("selection_not_ready", "A selected product is not a new READY row. No product was sent.");
    }
  }

  const lockKey = `production:${requestedId}`;
  if (selectionLocks.has(lockKey)) {
    return blockedBatch("send_in_progress", "A Production selection is already sending. No second create was sent.");
  }
  selectionLocks.add(lockKey);
  try {
    const quotes = await quoteProductionRows(latest, parsed.rows.map((row) => row.productId));
    const ready = [];
    for (const row of parsed.rows) {
      const saved = storedById.get(row.productId);
      const quote = quotes.get(row.productId);
      if (!quote) {
        return blockedBatch("stale_preview", "This Production preview is stale. No product was sent.");
      }
      if (quote.changeType === "changed" || quote.changeType === "unchanged") {
        return blockedBatch(
          "updates_not_in_pilot",
          "Updates to existing listings are outside this pilot. No product was sent."
        );
      }
      const sameConfirmation =
        quote.status === "READY" &&
        quote.changeType === "new" &&
        quote.payloadHash === saved.payloadHash &&
        quote.sku === saved.sku &&
        quote.sku === row.sku &&
        quote.price === row.price &&
        quote.stock === row.stock &&
        quote.payload;
      if (!sameConfirmation) {
        return blockedBatch(
          "stale_preview",
          "A selected product changed since this Production preview. No product was sent."
        );
      }
      ready.push({ ...row, name: quote.name, payload: quote.payload, payloadHash: quote.payloadHash });
    }

    const results = [];
    let stop = false;
    for (const row of ready) {
      if (stop) {
        results.push({
          ...publicQuote(row),
          ok: false,
          sent: false,
          code: "not_sent",
          message: "No product was sent because an earlier create in this selection was not confirmed.",
          elryanProductId: "",
          listingStatus: "",
        });
        continue;
      }
      const outcome = await executeElryanProductionCreate({
        productId: row.productId,
        sku: row.sku,
        payload: row.payload,
        hash: row.payloadHash,
        apiKey: config.apiKey,
        accountKey: productionAccountKey(config),
        allowUncertainRetry: false,
        holdAmbiguous: true,
      });
      const sent = outcome.ok === true && Boolean(outcome.elryanProductId);
      results.push({
        ...publicQuote(row),
        ok: sent,
        sent,
        code: outcome.code || "",
        message: outcome.message || "",
        elryanProductId: outcome.elryanProductId || outcome.listing?.id || "",
        listingStatus: outcome.listingStatus || outcome.listing?.status || "",
      });
      if (AMBIGUOUS_CREATE.has(outcome.code) || outcome.code === "send_in_progress") stop = true;
    }
    const sentToElryan = results.filter((row) => row.sent).length;
    if (sentToElryan) {
      latest.sentToElryan = (Number(latest.sentToElryan) || 0) + sentToElryan;
      await latest.save();
    }
    const ambiguous = results.some((row) => AMBIGUOUS_CREATE.has(row.code));
    return {
      ok: sentToElryan === ready.length,
      blocked: sentToElryan !== ready.length,
      classification: "WRITE",
      code: ambiguous ? "reconcile_required" : sentToElryan === ready.length ? "sent" : "partial",
      previewId: requestedId,
      sentToElryan,
      results,
      message: ambiguous
        ? "A create was not confirmed. No further create was sent."
        : sentToElryan
          ? "The selected Production creates finished. Existing listings were not updated."
          : "No selected product was created.",
    };
  } finally {
    selectionLocks.delete(lockKey);
  }
}
