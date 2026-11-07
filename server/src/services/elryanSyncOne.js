import crypto from "crypto";
import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { ElryanSyncOnePreview } from "../models/ElryanSyncOnePreview.js";
import { ElryanProductSyncState } from "../models/ElryanProductSyncState.js";
import { ElryanConfirmedSend } from "../models/ElryanConfirmedSend.js";
import { ElryanSendAttempt } from "../models/ElryanSendAttempt.js";
import { ElryanStagingProductOverride } from "../models/ElryanStagingProductOverride.js";
import { ElryanStagingPriceApproval } from "../models/ElryanStagingPriceApproval.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { loadElryanDimensionInputs } from "./elryanCollectionDimensions.js";
import {
  brownCollectionIdentity,
  presentElryanPackageDimensions,
  resolveElryanDimensions,
} from "../utils/elryanDimensionResolve.js";
import {
  elryanLiveProductWritesEnabled,
  elryanProductWritesEnabled,
  ELRYAN_READINESS,
  ELRYAN_PATHS,
} from "../utils/elryanConstants.js";
import {
  attachCommissionInvestigation,
  buildElryanPricingView,
  elryanOutboundPriceHash,
} from "../utils/elryanPricing.js";
import { buildElryanProductPayload, collectElryanImageUrls } from "../utils/elryanPayloadBuilder.js";
import { verifyElryanPublicImages } from "../utils/elryanImages.js";
import {
  elryanParentCategoryBlocker,
  elryanVerifiedLeafBlocker,
  validateElryanPreviewParts,
} from "../utils/elryanValidator.js";
import { assessElryanSellableUnits } from "../utils/elryanVariations.js";
import { toResolvedProduct } from "../utils/productView.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import {
  brownColourKeyFromResolved,
  findElryanBrandMapping,
  findElryanColorMapping,
  resolveElryanWarrantyForProduct,
} from "./elryanAttributeMapping.js";
import {
  elryanAttributeSetForCategory,
  elryanCalculateCommission,
  elryanCreateProduct,
  elryanListWarranties,
  elryanSkuExists,
} from "./elryanCatalog.js";
import { inspectElryanAttributeValues } from "../utils/elryanAttributeSet.js";
import { normalizeElryanWarrantyCatalog, uncheckedWarrantyCatalog } from "../utils/elryanWarranty.js";
import { getElryanConnectionPublic, getElryanWritesGatePublic, resolveElryanConfig } from "./elryanConnection.js";
import {
  ELRYAN_FIRST_STAGING_CREATE_SKU,
  elryanDimensionBlockers,
  elryanPublicationFromCreate,
  matchElryanStagingPriceApproval,
  mergeElryanStagingAttributes,
} from "../utils/elryanStagingGate.js";

const PREVIEW_TTL_MS = 20 * 60 * 1000;
const inflightSends = new Set();

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function payloadHash(payload, pricingSource) {
  return elryanOutboundPriceHash(payload, pricingSource);
}

function inputError(message, code, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

async function loadProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  return Product.findById(productId).lean();
}

export async function searchElryanSyncProducts(q = "", limit = 20) {
  const query = String(q || "").trim();
  const take = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const filter = {};
  if (query) {
    const rx = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { itemCode: rx },
      { "overrides.sku": rx },
      { "name.en": rx },
      { "name.ar": rx },
      { ibsherId: rx },
    ];
  }
  const rows = await Product.find(filter).sort({ updatedAt: -1 }).limit(take).lean();
  return {
    products: rows.map((doc) => {
      const resolved = toResolvedProduct(doc);
      return {
        id: String(doc._id),
        sku: resolved?.sku || doc.itemCode || "",
        name: resolved?.name || {},
        image: resolved?.image || "",
      };
    }),
  };
}

function mappingAttributes(mappingValues) {
  const nested = mappingValues?.environments?.[mappingValues?.elryanEnvironment]?.attributes;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested;
  if (mappingValues?.attributes && typeof mappingValues.attributes === "object" && !Array.isArray(mappingValues.attributes)) {
    return mappingValues.attributes;
  }
  return {};
}

async function readLiveCommission(categoryId, brandLabel) {
  if (!categoryId || !brandLabel) return null;
  try {
    const calc = await elryanCalculateCommission({
      categoryId,
      brand: brandLabel,
    });
    const rate = Number(calc.calculation?.commission);
    return {
      ok: true,
      rate: Number.isFinite(rate) ? rate : null,
      calculation: calc.calculation,
    };
  } catch (err) {
    return { ok: false, rate: null, message: err?.message || "Commission calculate failed" };
  }
}

async function mappedElryanCategory(environment, categoryId) {
  const id = String(categoryId || "").trim();
  if (!id || environment !== "staging") return { snapshot: null, category: null };
  const snap = await ElryanCategoryCatalogSnapshot.findOne({ environment: "staging" })
    .select("status coverage categories.id categories.isParent")
    .lean();
  if (!snap) return { snapshot: null, category: null };
  const numeric = /^\d+$/.test(id) ? Number(id) : null;
  const category =
    (snap.categories || []).find(
      (row) => String(row?.id) === id || (numeric != null && row?.id === numeric)
    ) || null;
  return {
    snapshot: { status: snap.status, coverage: snap.coverage },
    category,
  };
}

/**
 * Shared Staging preview assembly. Reads Elryan catalog data and does not send a product.
 */
export async function assembleElryanSyncOne({ productId, origin = "", investigateCommission = false } = {}) {
  const connection = await getElryanConnectionPublic();
  const config = await resolveElryanConfig();
  const doc = await loadProduct(productId);
  if (!doc) {
    const error = new Error("Product not found");
    error.status = 404;
    throw error;
  }

  const resolved = toResolvedProduct(doc);
  const productKey = String(doc._id);
  const ctx = await loadEligibilityContext("elryan");
  const mappingValues = taxonomyValuesForProduct(doc, ctx) || {};
  const variation = assessElryanSellableUnits(resolved);
  const brandId = doc.brand?._id || doc.brand?.id || "";
  const brand = await findElryanBrandMapping(brandId, config.environment);
  const colourKey = brownColourKeyFromResolved(resolved, variation);
  const color = await findElryanColorMapping(colourKey, config.environment);
  const warrantyResolved = await resolveElryanWarrantyForProduct(doc, config.environment);
  const warrantyFallback = warrantyResolved.mapping;

  const [override, approvalRow, dimensionInputs, categoryLookup] = await Promise.all([
    ElryanStagingProductOverride.findOne({ environment: "staging", productId: productKey }).lean(),
    ElryanStagingPriceApproval.findOne({ environment: "staging", productId: productKey }).lean(),
    loadElryanDimensionInputs(config.environment, [doc]),
    mappedElryanCategory(config.environment, mappingValues.categoryId),
  ]);
  const collectionIdentity = brownCollectionIdentity(doc);
  const dimensions = resolveElryanDimensions({
    environment: config.environment,
    product: doc,
    dimensionRow: dimensionInputs.checks.get(productKey) || null,
    collectionRule: collectionIdentity.ambiguous
      ? null
      : dimensionInputs.rules.get(collectionIdentity.collectionId) || null,
    excluded: dimensionInputs.exclusions.has(productKey),
  });
  const attributes = mergeElryanStagingAttributes(
    config.environment,
    mappingAttributes(mappingValues),
    override
  );

  let pricing = await buildElryanPricingView(doc);
  let attributeSet = null;
  let requiredAttributeCodes = [];
  let rejectedAttributeCodes = [];
  let attributeSetUnverified = false;
  let commissionInvestigation = null;
  let liveCommission = null;
  let warrantyCatalog = uncheckedWarrantyCatalog(
    config.hasApiKey ? "" : "WARRANTY_UNVERIFIED. No Elryan API key is stored, so the warranty list was not read."
  );

  const shouldReadCommission = Boolean(
    config.hasApiKey && mappingValues.categoryId && brand?.elryanLabel && (investigateCommission || approvalRow)
  );
  if (shouldReadCommission) {
    const calc = await readLiveCommission(mappingValues.categoryId, brand.elryanLabel || brand.brownLabel);
    liveCommission = calc.rate;
    commissionInvestigation = calc.ok
      ? { ok: true, classification: "READ", calculation: calc.calculation }
      : {
          ok: false,
          classification: "READ",
          message: sanitizeElryanText(calc.message || "Commission calculate failed", [config.apiKey]),
        };
    pricing = attachCommissionInvestigation(pricing, commissionInvestigation);
  }

  if (config.hasApiKey) {
    try {
      const listed = await elryanListWarranties();
      warrantyCatalog = normalizeElryanWarrantyCatalog(listed.warranties, listed.httpStatus);
    } catch (err) {
      warrantyCatalog = uncheckedWarrantyCatalog(
        sanitizeElryanText(err?.message || "Warranty list could not be read.", [config.apiKey])
      );
      warrantyCatalog.httpStatus = Number(err?.httpStatus) || 0;
    }
  }

  if (config.hasApiKey && mappingValues.categoryId) {
    try {
      const setResult = await elryanAttributeSetForCategory(mappingValues.categoryId);
      attributeSet = setResult.attributeSet || null;
      const inspected = inspectElryanAttributeValues(attributeSet, attributes);
      requiredAttributeCodes = inspected.requiredCodes;
      rejectedAttributeCodes = inspected.rejectedCodes;
    } catch (err) {
      if (Number(err?.httpStatus) === 404) {
        attributeSet = null;
      } else {
        attributeSetUnverified = true;
      }
    }
  }

  const images = collectElryanImageUrls(resolved);
  const imageBlockers = await verifyElryanPublicImages(images);
  const qty = resolved?.outOfStock ? 0 : Math.max(0, Math.floor(Number(resolved?.stock) || 0));
  const payload = buildElryanProductPayload({
    resolved,
    sku: resolved?.sku,
    mapping: mappingValues,
    brand,
    color,
    warranty: warrantyFallback,
    attributes,
    pricing,
    dimensions,
    origin,
    quantity: qty,
  });
  const hash = payloadHash(payload, pricing.pricingSource);
  const pricingApproval = matchElryanStagingPriceApproval(approvalRow, {
    environment: config.environment,
    productId: productKey,
    sku: resolved?.sku,
    payload,
    payloadHash: hash,
  });

  const validation = validateElryanPreviewParts({
    hasApiKey: config.hasApiKey,
    resolved,
    sku: resolved?.sku,
    mapping: mappingValues,
    brand,
    color,
    warranty: warrantyFallback,
    warrantyCatalog,
    attributes,
    requiredAttributeCodes,
    rejectedAttributeCodes,
    attributeSetUnverified,
    variation,
    pricing,
    pricingApproval,
    images,
    extraBlockers: [
      ...elryanDimensionBlockers(dimensions),
      ...imageBlockers,
      config.environment === "staging" && String(mappingValues.categoryId || "").trim()
        ? elryanVerifiedLeafBlocker(categoryLookup)
        : elryanParentCategoryBlocker(categoryLookup?.category),
    ].filter(Boolean),
  });

  return {
    connection,
    config,
    doc,
    resolved,
    productKey,
    mappingValues,
    variation,
    brand,
    color,
    colourKey,
    warrantyFallback,
    warrantyResolved,
    override: config.environment === "staging" ? override : null,
    dimensions,
    attributes,
    pricing,
    pricingApproval,
    attributeSet,
    requiredAttributeCodes,
    warrantyCatalog,
    images,
    qty,
    payload,
    hash,
    validation,
    liveCommission,
  };
}

/**
 * Local + optional read-only Elryan investigation. Never writes products.
 */
export async function previewElryanSyncOne({ productId, origin = "", investigateCommission = false } = {}) {
  const assembled = await assembleElryanSyncOne({ productId, origin, investigateCommission });
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await ElryanSyncOnePreview.create({
    tokenHash: hashToken(token),
    productId: assembled.productKey,
    payloadHash: assembled.hash,
    readiness: assembled.validation.readiness,
    expiresAt,
  });

  await ElryanProductSyncState.findOneAndUpdate(
    { productId: assembled.productKey },
    {
      $set: {
        sku: assembled.resolved?.sku || "",
        lastReadiness: assembled.validation.readiness,
        lastPreviewAt: new Date(),
      },
    },
    { upsert: true }
  );

  const dimensions = assembled.dimensions;
  const sendAttempt = await inspectElryanSendAttempt(assembled.productKey);
  const writesGate = getElryanWritesGatePublic();
  return {
    ok: true,
    classification: "READ",
    productWritesEnabled: writesGate.productWritesEnabled,
    liveWritesAllowed: writesGate.liveWritesAllowed,
    writesGate,
    readiness: assembled.validation.readiness,
    blockers: assembled.validation.blockers,
    previewToken: token,
    expiresAt,
    product: {
      id: assembled.productKey,
      sku: assembled.resolved?.sku || "",
      name: assembled.resolved?.name || {},
      description: assembled.resolved?.description || {},
      stock: assembled.qty,
      outOfStock: Boolean(assembled.resolved?.outOfStock),
      images: assembled.images,
    },
    mapping: {
      brownCollectionId: String(assembled.doc.collectionName?._id || assembled.doc.collectionName?.id || ""),
      categoryId: assembled.mappingValues.categoryId || "",
      categoryName: assembled.mappingValues.categoryName || "",
      categoryHierarchy: assembled.mappingValues.categoryHierarchy || "",
      attributeSetId: assembled.mappingValues.attributeSetId || "",
    },
    brand: assembled.brand
      ? {
          brownKey: assembled.brand.brownKey,
          elryanId: assembled.brand.elryanId,
          label: assembled.brand.elryanLabel || assembled.brand.brownLabel,
        }
      : null,
    color: assembled.color
      ? {
          brownKey: assembled.color.brownKey,
          elryanId: assembled.color.elryanId,
          label: assembled.color.elryanLabel || assembled.color.brownLabel,
        }
      : { brownKey: assembled.colourKey, elryanId: "", label: assembled.colourKey },
    warranty: assembled.warrantyFallback
      ? {
          brownKey: assembled.warrantyFallback.brownKey,
          elryanCode: assembled.warrantyFallback.elryanCode,
          label: assembled.warrantyFallback.elryanLabel,
          source: assembled.warrantyResolved.source,
          environment: assembled.warrantyResolved.environment,
        }
      : null,
    variation: assembled.variation,
    pricing: assembled.pricing,
    stagingOverride: assembled.override
      ? {
          environment: "staging",
          productId: assembled.productKey,
          sku: assembled.override.sku,
          attributes: assembled.override.attributes || {},
        }
      : null,
    pricingApproval: {
      valid: assembled.pricingApproval.valid === true,
      reason: assembled.pricingApproval.reason,
    },
    attributeSet: assembled.attributeSet,
    requiredAttributeCodes: assembled.requiredAttributeCodes,
    warrantyContract: {
      status: assembled.validation.blockers.some((blocker) => blocker.code === "warranty_unverified")
        ? ELRYAN_READINESS.WARRANTY_UNVERIFIED
        : "CONFIRMED",
      checked: assembled.warrantyCatalog.checked === true,
      catalogCount: assembled.warrantyCatalog.codes?.length || 0,
      message: assembled.warrantyCatalog.message || "",
    },
    packageDimensions: presentElryanPackageDimensions(dimensions),
    proposedPayload: assembled.payload,
    sendAttempt,
    connection: {
      status: assembled.connection.status,
      environment: assembled.connection.environment,
      hasApiKey: assembled.connection.hasApiKey,
      accessLabel: assembled.connection.accessLabel,
    },
    sync: {
      enabled: false,
      reason: elryanProductWritesEnabled()
        ? "Write flags are on. Send still requires a READY preview, an explicit confirmation, and the first-test SKU."
        : "Product publishing is disabled (ELRYAN_PRODUCT_WRITES_ENABLED is not true).",
    },
  };
}

function blockedSend(code, message, extra = {}) {
  return {
    ok: false,
    classification: "WRITE",
    blocked: true,
    code,
    message,
    published: false,
    httpStatus: extra.httpStatus || 403,
    blockers: extra.blockers || [],
    readiness: extra.readiness || ELRYAN_READINESS.NOT_READY,
    elryanProductId: extra.elryanProductId || "",
  };
}

function liveWritesEnabled() {
  return elryanLiveProductWritesEnabled();
}

function heldAttemptMessage(row) {
  if (row?.status === "succeeded") {
    return "This Staging product was already created. No second create was sent.";
  }
  if (row?.status === "uncertain") {
    const prior = row.errorMessage ? ` Earlier result: ${row.errorMessage}` : "";
    return `This create is uncertain and stays blocked until it is reconciled.${prior} A new preview token does not release it, and SKU availability does not clear it. No product was sent.`;
  }
  if (row?.status === "in_progress") {
    return "An earlier create is still in progress, including after the lock timeout. It does not authorize another product POST. No product was sent.";
  }
  return "";
}

export async function inspectElryanSendAttempt(productId) {
  const key = String(productId || "");
  const row = key
    ? await ElryanSendAttempt.findOne({ environment: "staging", productId: key }).lean()
    : null;
  const status = row?.status || "";
  return {
    classification: "READ",
    environment: "staging",
    productId: key,
    found: Boolean(row),
    status,
    sku: row?.sku || "",
    errorCode: row?.errorCode || "",
    errorMessage: row?.errorMessage || "",
    httpStatus: row?.httpStatus || 0,
    published: row?.published === true,
    elryanProductId: row?.elryanProductId || "",
    payloadHash: row?.payloadHash || "",
    startedAt: row?.startedAt || null,
    finishedAt: row?.finishedAt || null,
    blocked: status === "uncertain" || status === "in_progress" || status === "succeeded",
    releaseAllowed: false,
    note: "Inspection does not send a product or change the attempt. An uncertain or in-progress attempt stays blocked until a separate explicit reconciliation release. SKU availability does not clear it.",
  };
}

async function unreconciledSendHold(productId) {
  const existing = await ElryanSendAttempt.findOne({ environment: "staging", productId });
  if (!existing) return null;
  if (!["succeeded", "uncertain", "in_progress"].includes(existing.status)) return null;
  const code =
    existing.status === "succeeded"
      ? "already_sent"
      : existing.status === "uncertain"
        ? "send_uncertain"
        : "send_in_progress";
  return {
    code,
    message: heldAttemptMessage(existing),
    elryanProductId: existing.elryanProductId || "",
  };
}

async function claimSendAttempt({ productId, sku, hash }) {
  const existing = await ElryanSendAttempt.findOne({ environment: "staging", productId });
  const held = existing ? await unreconciledSendHold(productId) : null;
  if (held) return { ok: false, ...held };
  try {
    if (!existing) {
      await ElryanSendAttempt.create({
        environment: "staging",
        productId,
        sku,
        status: "in_progress",
        payloadHash: hash,
        startedAt: new Date(),
        finishedAt: null,
      });
      return { ok: true };
    }
    const updated = await ElryanSendAttempt.updateOne(
      { _id: existing._id, status: existing.status },
      {
        $set: {
          status: "in_progress",
          sku,
          payloadHash: hash,
          startedAt: new Date(),
          finishedAt: null,
          errorCode: "",
          errorMessage: "",
          httpStatus: 0,
          published: false,
        },
      }
    );
    if (updated.modifiedCount !== 1) return { ok: false, code: "send_in_progress" };
    return { ok: true, previousStatus: existing.status };
  } catch (err) {
    if (err?.code === 11000) return { ok: false, code: "send_in_progress" };
    throw err;
  }
}

async function settleAttempt(productId, fields) {
  await ElryanSendAttempt.updateOne(
    { environment: "staging", productId },
    { $set: { ...fields, finishedAt: fields.finishedAt || new Date() } }
  );
}

function apiErrorMessage(json, apiKey) {
  const raw = json?.error?.message || json?.message || "Elryan rejected the product.";
  return sanitizeElryanText(String(raw), [apiKey]);
}

async function recordUncertain(productId, sku, apiKey, message) {
  let followUp = null;
  try {
    followUp = await elryanSkuExists(sku);
  } catch (err) {
    followUp = { error: sanitizeElryanText(err?.message || "SKU check failed", [apiKey]) };
  }
  const taken = followUp?.available === false;
  const code = followUp?.error ? "create_uncertain" : taken ? "create_uncertain_sku_taken" : "create_uncertain";
  const text = followUp?.error
    ? `${message} The SKU could not be checked again. No second create was sent.`
    : taken
      ? `${message} The SKU is now taken. No second create was sent, and no product id was invented.`
      : `${message} The SKU is still available. No second create was sent in this request.`;
  await settleAttempt(productId, {
    status: "uncertain",
    errorCode: code,
    errorMessage: sanitizeElryanText(text, [apiKey]),
    httpStatus: 0,
    published: false,
  });
  return blockedSend(code, text, { httpStatus: 409 });
}

/**
 * Staging create for the first test SKU.
 * Both write flags must be on. This function can POST /v1/products only after every gate passes.
 */
export async function sendElryanSyncOne({ productId, confirm, previewToken } = {}) {
  if (!elryanProductWritesEnabled()) {
    return blockedSend(
      "writes_disabled",
      "Elryan product publishing is disabled. ELRYAN_PRODUCT_WRITES_ENABLED must remain false until a separate review enables it."
    );
  }
  if (!liveWritesEnabled()) {
    return blockedSend(
      "writes_gated",
      "Live Elryan product writes require both ELRYAN_PRODUCT_WRITES_ENABLED=true and ELRYAN_ALLOW_LIVE_PRODUCT_WRITES=true. No product was sent."
    );
  }
  if (confirm !== true) {
    return blockedSend("confirm_required", "Send requires explicit confirm=true after Preview.");
  }
  const token = String(previewToken || "").trim();
  if (!token) return blockedSend("preview_required", "Send requires the preview confirmation token.");

  const config = await resolveElryanConfig();
  if (config.environment !== "staging") {
    return blockedSend("staging_only", "Product create is limited to the Staging environment. No product was sent.");
  }

  const localKey = `staging:${String(productId || "")}`;
  if (inflightSends.has(localKey)) {
    return blockedSend("send_in_progress", "A create for this product is already running. No second create was sent.");
  }
  inflightSends.add(localKey);
  try {
    const assembled = await assembleElryanSyncOne({ productId, investigateCommission: true });
    const sku = String(assembled.resolved?.sku || "");
    if (sku !== ELRYAN_FIRST_STAGING_CREATE_SKU) {
      return blockedSend(
        "first_test_sku_only",
        "The first Staging create is limited to SKU OWCH180002. No product was sent."
      );
    }
    if (assembled.pricingApproval?.valid !== true) {
      return blockedSend(
        "pricing_unverified",
        "The saved Staging price approval does not match this SKU, product, and payload. No product was sent.",
        {
          blockers: assembled.validation.blockers,
          readiness: assembled.validation.readiness,
        }
      );
    }
    if (!assembled.validation.ready) {
      return blockedSend("not_ready", "The product is not READY. No product was sent.", {
        blockers: assembled.validation.blockers,
        readiness: assembled.validation.readiness,
      });
    }
    if (assembled.dimensions.confirmed !== true) {
      return blockedSend("dimensions_unverified", "Dimensions are not confirmed. No product was sent.", {
        blockers: assembled.validation.blockers,
        readiness: assembled.validation.readiness,
      });
    }

    const preview = await ElryanSyncOnePreview.findOne({ tokenHash: hashToken(token) }).lean();
    if (!preview || preview.productId !== assembled.productKey || preview.payloadHash !== assembled.hash) {
      return blockedSend("preview_mismatch", "The preview token does not match this product payload. No product was sent.");
    }
    if (preview.consumedAt) {
      return blockedSend("preview_used", "This preview token was already used. No product was sent.");
    }
    if (new Date(preview.expiresAt).getTime() <= Date.now() || preview.readiness !== ELRYAN_READINESS.READY) {
      return blockedSend("preview_expired", "The preview is expired or was not READY. No product was sent.");
    }

    const prior = await ElryanConfirmedSend.findOne({
      environment: "staging",
      productId: assembled.productKey,
    }).lean();
    if (prior?.elryanProductId) {
      return blockedSend("already_sent", "This Staging product was already created. No second create was sent.", {
        elryanProductId: prior.elryanProductId,
        httpStatus: 409,
      });
    }

    const held = await unreconciledSendHold(assembled.productKey);
    if (held) {
      return blockedSend(held.code, held.message, {
        elryanProductId: held.elryanProductId || "",
        httpStatus: 409,
      });
    }

    const skuState = await elryanSkuExists(sku);
    if (skuState.available !== true) {
      const existingId = String(skuState.raw?.data?.id || skuState.raw?.data?.productId || "").trim();
      return blockedSend(
        existingId ? "sku_already_created" : "sku_unavailable",
        existingId
          ? "The SKU already exists on Elryan. No second create was sent."
          : "The SKU is not available. No product was created.",
        { httpStatus: skuState.httpStatus || 409, elryanProductId: existingId }
      );
    }

    const claim = await claimSendAttempt({
      productId: assembled.productKey,
      sku,
      hash: assembled.hash,
    });
    if (!claim.ok) {
      return blockedSend(claim.code, claim.message || "No product was sent.", {
        elryanProductId: claim.elryanProductId || "",
        httpStatus: 409,
      });
    }

    const consumed = await ElryanSyncOnePreview.findOneAndUpdate(
      {
        _id: preview._id,
        consumedAt: null,
        expiresAt: { $gt: new Date() },
        payloadHash: assembled.hash,
        readiness: ELRYAN_READINESS.READY,
      },
      { $set: { consumedAt: new Date() } }
    );
    if (!consumed) {
      await settleAttempt(assembled.productKey, {
        status: "failed",
        errorCode: "preview_used",
        errorMessage: "The preview token was no longer usable.",
      });
      return blockedSend("preview_used", "This preview token was already used. No product was sent.");
    }

    let result;
    try {
      result = await elryanCreateProduct(assembled.payload);
    } catch (err) {
      return recordUncertain(
        assembled.productKey,
        sku,
        config.apiKey,
        sanitizeElryanText(err?.message || "Elryan did not return a create response.", [config.apiKey])
      );
    }

    const publication = elryanPublicationFromCreate(result.json);
    const definiteClientError = result.httpStatus >= 400 && result.httpStatus < 500 && result.httpStatus !== 409;
    if (result.ok && publication.elryanProductId) {
      await ElryanConfirmedSend.findOneAndUpdate(
        { environment: "staging", productId: assembled.productKey },
        {
          $setOnInsert: {
            environment: "staging",
            productId: assembled.productKey,
            sku,
            payloadHash: assembled.hash,
            elryanProductId: publication.elryanProductId,
            httpStatus: result.httpStatus,
            published: publication.published === true,
            confirmedAt: new Date(),
          },
        },
        { upsert: true }
      );
      await settleAttempt(assembled.productKey, {
        status: "succeeded",
        elryanProductId: publication.elryanProductId,
        httpStatus: result.httpStatus,
        published: publication.published === true,
        errorCode: "",
        errorMessage: "",
      });
      await ElryanProductSyncState.updateOne(
        { productId: assembled.productKey },
        {
          $set: {
            sku,
            elryanProductId: publication.elryanProductId,
            lastSyncAttemptAt: new Date(),
            lastSyncStatus: publication.published ? "published" : "created",
            lastError: "",
          },
        }
      );
      return {
        ok: true,
        classification: "WRITE",
        blocked: false,
        code: publication.published ? "created_and_published" : "created",
        message: publication.published
          ? "Elryan created the product and the response marks it published."
          : "Elryan created the product. The response does not mark it published.",
        httpStatus: result.httpStatus,
        published: publication.published === true,
        elryanProductId: publication.elryanProductId,
        sku,
        environment: "staging",
        payloadHash: assembled.hash,
      };
    }

    if (!definiteClientError) {
      return recordUncertain(
        assembled.productKey,
        sku,
        config.apiKey,
        "Elryan did not return a confirmed product id."
      );
    }

    const message = apiErrorMessage(result.json, config.apiKey);
    await settleAttempt(assembled.productKey, {
      status: "failed",
      httpStatus: result.httpStatus,
      published: false,
      errorCode: "elryan_rejected",
      errorMessage: message,
    });
    return blockedSend("elryan_rejected", message, {
      httpStatus: result.httpStatus,
      blockers: assembled.validation.blockers,
    });
  } finally {
    inflightSends.delete(localKey);
  }
}

export async function approveElryanStagingPrice({ productId, confirm } = {}) {
  if (confirm !== true) {
    throw inputError("Pricing approval requires confirm=true.", "confirm_required");
  }
  const assembled = await assembleElryanSyncOne({ productId, investigateCommission: true });
  if (assembled.config.environment !== "staging") {
    throw inputError("Pricing approval is Staging only.", "staging_only");
  }
  const sku = String(assembled.resolved?.sku || "");
  if (sku !== ELRYAN_FIRST_STAGING_CREATE_SKU) {
    throw inputError("This approval is limited to SKU OWCH180002.", "first_test_sku_only");
  }
  const price = Number(assembled.payload.price);
  const blocking = assembled.validation.blockers.filter((blocker) => blocker.code !== "pricing_unverified");
  if (blocking.length || !(price > 0)) {
    throw inputError("Pricing can be recorded only after BrownStore price rules resolve a final payload.", "not_ready");
  }
  if (assembled.payload.cost != null) {
    throw inputError("The approved payload must omit cost.", "cost_present");
  }
  const approvedAt = new Date();
  const rate = Number(assembled.pricing?.commissionRate);
  const saved = await ElryanStagingPriceApproval.findOneAndUpdate(
    { environment: "staging", productId: assembled.productKey },
    {
      $set: {
        sku,
        price,
        currency: "IQD",
        commissionRate: Number.isFinite(rate) ? rate : 0,
        sendPriceOnly: true,
        costOmitted: true,
        payoutUnknownAccepted: true,
        payloadHash: assembled.hash,
        approvedAt,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean();
  return {
    ok: true,
    environment: "staging",
    productId: assembled.productKey,
    sku: saved.sku,
    price: saved.price,
    currency: saved.currency,
    commissionRate: saved.commissionRate,
    payloadHash: saved.payloadHash,
    payoutUnknownAccepted: true,
  };
}

export function elryanBulkDesignNotes() {
  return {
    classification: "WRITE",
    enabled: false,
    endpoints: {
      create: ELRYAN_PATHS.batchCreate,
      update: ELRYAN_PATHS.batchUpdate,
      status: ELRYAN_PATHS.batchById("{id}"),
    },
    maxBatchSize: 2500,
    notes: [
      "Bulk create accepts JSON or multipart file; valid rows can succeed while invalid rows return problems.",
      "Bulk update matches by SKU; supervised/rejected products cannot be updated.",
      "costPrice alone recalculates sellingPrice from marketplace commission; sellingPrice alone recalculates cost.",
      "Do not execute bulk calls until Elryan grants publishing and a separate review enables writes.",
    ],
  };
}
