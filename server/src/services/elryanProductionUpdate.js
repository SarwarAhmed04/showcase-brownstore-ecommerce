import crypto from "node:crypto";
import { ElryanSendAttempt } from "../models/ElryanSendAttempt.js";
import { ElryanSyncOnePreview } from "../models/ElryanSyncOnePreview.js";
import { ELRYAN_ENVIRONMENTS, elryanLiveProductWritesEnabled, elryanProductWritesEnabled } from "../utils/elryanConstants.js";
import {
  ELRYAN_DIMENSION_UPDATE_ACTION,
  ELRYAN_PACKAGE_DIMENSION_UNIT,
  compareElryanListing,
  elryanDimensionUpdateBinding,
  elryanListingIdentity,
  elryanProductIdValid,
  hashElryanDimensionUpdateBinding,
  reviewedElryanDimensions,
} from "../utils/elryanDimensionCompare.js";
import {
  ELRYAN_PRICE_UPDATE_ACTION,
  elryanPriceReviewMessage,
  elryanPriceUpdateBinding,
  hashElryanPriceUpdateBinding,
  readElryanSellingPrice,
  reviewElryanSellingPrice,
} from "../utils/elryanPriceUpdate.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";
import { elryanListingFromSkuConflict } from "../utils/elryanSku.js";
import { ELRYAN_FIRST_STAGING_CREATE_SKU } from "../utils/elryanStagingGate.js";
import { elryanGetProduct, elryanSkuExists, elryanUpdateProductionDimensions, elryanUpdateProductionPrice } from "./elryanCatalog.js";
import { resolveElryanConfig } from "./elryanConnection.js";
import { assembleElryanSyncOne } from "./elryanSyncOne.js";

const PREVIEW_TTL_MS = 20 * 60 * 1000;
const inflightUpdates = new Set();

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function blocked(code, message, extra = {}) {
  return {
    ok: false,
    blocked: true,
    classification: extra.classification || "READ",
    code,
    environment: "production",
    sku: ELRYAN_FIRST_STAGING_CREATE_SKU,
    updateAllowed: false,
    dimensionPatch: {},
    rows: extra.rows || [],
    message,
    ...extra,
  };
}

function proposedValues(assembled) {
  const confirmed = assembled.dimensions?.confirmed === true;
  return {
    sku: String(assembled.resolved?.sku || ""),
    price: assembled.payload?.price ?? null,
    quantity: assembled.payload?.quantity ?? null,
    categoryId: assembled.payload?.categoryId || null,
    brandId: assembled.payload?.brandId || null,
    colorId: assembled.payload?.colorId || null,
    warrantyCode: assembled.payload?.warrantyCode || null,
    width: confirmed ? assembled.dimensions.width : null,
    height: confirmed ? assembled.dimensions.height : null,
    depth: confirmed ? assembled.dimensions.depth : null,
  };
}

function conflictOmitsListingIdentity(listing) {
  return !listing?.id && !listing?.sku;
}

/** A conflict with no listing id or SKU is accepted only when this product's saved Production create names that exact listing. */
async function savedProductionCreateMatches({ productId, sku, listingId }) {
  const row = await ElryanSendAttempt.findOne({
    environment: "production",
    productId: String(productId || ""),
    sku,
    status: "succeeded",
    elryanProductId: listingId,
  }).lean();
  return Boolean(row);
}

async function matchProductionListing({ productId, sku, listingId, apiKey }) {
  const wantedId = String(listingId || "").trim();
  const wantedSku = String(sku || "").trim();
  if (!wantedId) return blocked("listing_id_required", "Production update preview requires the existing listing ID.");
  if (!elryanProductIdValid(wantedId)) {
    return blocked("listing_id_invalid", "Marketplace v1 product ids are 24 hexadecimal characters. No listing was changed.");
  }
  let skuState;
  try {
    skuState = await elryanSkuExists(wantedSku);
  } catch (err) {
    return blocked(
      "sku_check_failed",
      sanitizeElryanText(err?.message || "The Production SKU could not be checked.", [apiKey]),
      { httpStatus: 502 }
    );
  }
  if (skuState.available === true) {
    return blocked("sku_not_listed", "This SKU is not an existing Production listing. No update was sent.");
  }
  const fromSku = elryanListingFromSkuConflict(skuState.raw);
  if (!conflictOmitsListingIdentity(fromSku) && (fromSku.id !== wantedId || fromSku.sku !== wantedSku)) {
    return blocked("listing_mismatch", "The SKU and listing ID do not identify the same Production listing. No update was sent.", {
      listing: fromSku,
    });
  }
  if (conflictOmitsListingIdentity(fromSku)) {
    const saved = await savedProductionCreateMatches({ productId, sku: wantedSku, listingId: wantedId });
    if (!saved) {
      return blocked("listing_mismatch", "The SKU and listing ID do not identify the same Production listing. No update was sent.", {
        listing: fromSku,
      });
    }
  }
  let loaded;
  try {
    loaded = await elryanGetProduct(wantedId);
  } catch (err) {
    return blocked(
      "listing_read_failed",
      sanitizeElryanText(err?.message || "The Production listing could not be read.", [apiKey]),
      { httpStatus: 502 }
    );
  }
  const identity = elryanListingIdentity(loaded.product);
  if (identity.id !== wantedId || identity.sku !== wantedSku) {
    return blocked("listing_mismatch", "The listing read from Production does not match this SKU and listing ID. No update was sent.", {
      listing: identity,
    });
  }
  return { ok: true, product: identity.product, listing: { id: identity.id, sku: identity.sku } };
}

async function productionContext(productId) {
  const config = await resolveElryanConfig();
  if (config.environment !== "production" || config.baseUrl !== ELRYAN_ENVIRONMENTS.production.baseUrl) {
    return blocked("production_required", "Production update requires the active Production connection.");
  }
  const assembled = await assembleElryanSyncOne({ productId, investigateCommission: true });
  const sku = String(assembled.resolved?.sku || "");
  if (sku !== ELRYAN_FIRST_STAGING_CREATE_SKU) {
    return blocked("first_test_sku_only", "Production update is limited to SKU OWCH180002. No product was changed.");
  }
  return { ok: true, config, assembled, sku };
}

/**
 * READ — match OWCH180002 by SKU and listing ID, then compare current Elryan fields with BrownStore.
 * Does not create or update a product.
 */
export async function previewElryanProductionUpdate({ productId, listingId } = {}) {
  const context = await productionContext(productId);
  if (!context.ok) return context;
  const matched = await matchProductionListing({
    productId: context.assembled.productKey,
    sku: context.sku,
    listingId,
    apiKey: context.config.apiKey,
  });
  if (!matched.ok) return matched;
  const proposed = proposedValues(context.assembled);
  const compared = compareElryanListing({
    listing: matched.product,
    proposed,
    dimensionsConfirmed: context.assembled.dimensions?.confirmed === true,
  });
  const binding = elryanDimensionUpdateBinding({
    listingId: matched.listing.id,
    current: reviewedElryanDimensions(matched.product),
    patch: compared.dimensionPatch,
  });
  const bindingHash = hashElryanDimensionUpdateBinding(binding);
  const token = crypto.randomBytes(24).toString("base64url");
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);
  await ElryanSyncOnePreview.create({
    tokenHash: hashToken(token),
    productId: context.assembled.productKey,
    payloadHash: bindingHash,
    purpose: ELRYAN_DIMENSION_UPDATE_ACTION,
    listingId: matched.listing.id,
    bindingHash,
    readiness: context.assembled.validation.readiness,
    expiresAt,
  });
  const message = compared.missingApiFields.length
    ? "The listing does not use the API fields width, height, and depth. No dimension update is available."
    : compared.updateAllowed
      ? "Confirmed package dimensions differ. An explicit update can send only those fields."
      : "The confirmed package dimensions already match this listing.";
  const priceReview = reviewElryanSellingPrice({
    product: matched.product,
    approvedPrice: context.assembled.payload?.price,
    approvalValid: context.assembled.pricingApproval?.valid === true,
  });
  let pricePreviewToken = "";
  if (priceReview.priceCode === "price_differs" || priceReview.priceCode === "price_unchanged") {
    const priceBinding = elryanPriceUpdateBinding({
      listingId: matched.listing.id,
      currentSellingPrice: priceReview.currentSellingPrice,
      price: priceReview.pricePatch.price,
    });
    const priceBindingHash = hashElryanPriceUpdateBinding(priceBinding);
    pricePreviewToken = crypto.randomBytes(24).toString("base64url");
    await ElryanSyncOnePreview.create({
      tokenHash: hashToken(pricePreviewToken),
      productId: context.assembled.productKey,
      payloadHash: priceBindingHash,
      purpose: ELRYAN_PRICE_UPDATE_ACTION,
      listingId: matched.listing.id,
      bindingHash: priceBindingHash,
      readiness: context.assembled.validation.readiness,
      expiresAt,
    });
  }
  return {
    ok: true,
    classification: "READ",
    code: "update_preview",
    environment: "production",
    productId: context.assembled.productKey,
    sku: context.sku,
    listingId: matched.listing.id,
    listing: matched.listing,
    matched: true,
    rows: compared.rows,
    dimensionApiFields: compared.dimensionApiFields,
    missingApiFields: compared.missingApiFields,
    dimensionPatch: compared.dimensionPatch,
    dimensionUnit: ELRYAN_PACKAGE_DIMENSION_UNIT,
    updateAllowed: compared.updateAllowed,
    dimensionsConfirmed: context.assembled.dimensions?.confirmed === true,
    previewToken: token,
    currentSellingPrice: priceReview.currentSellingPrice,
    approvedPrice: priceReview.approvedPrice,
    priceCurrency: priceReview.currency,
    pricePatch: priceReview.pricePatch,
    priceUpdateAllowed: priceReview.priceUpdateAllowed,
    priceCode: priceReview.priceCode,
    pricePreviewToken,
    priceMessage: elryanPriceReviewMessage(priceReview.priceCode),
    expiresAt,
    message,
  };
}

/**
 * WRITE — PATCH the existing Production listing with only the confirmed dimensions that differ.
 */
export async function updateElryanProductionDimensions({ productId, listingId, confirm, previewToken } = {}) {
  if (!elryanProductWritesEnabled() || !elryanLiveProductWritesEnabled()) {
    const code = elryanProductWritesEnabled() ? "writes_gated" : "writes_disabled";
    return blocked(code, "Both write flags must be true before a Production dimension update.", {
      classification: "WRITE",
      httpStatus: 403,
    });
  }
  if (confirm !== true) {
    return blocked("confirm_required", "Production dimension update requires explicit confirm=true.", {
      classification: "WRITE",
    });
  }
  const token = String(previewToken || "").trim();
  if (!token) {
    return blocked("preview_required", "Production dimension update requires the update preview token.", {
      classification: "WRITE",
    });
  }
  const localKey = `production-update:${String(productId || "")}`;
  if (inflightUpdates.has(localKey)) {
    return blocked("update_in_progress", "A Production dimension update for this product is already running.", {
      classification: "WRITE",
    });
  }
  inflightUpdates.add(localKey);
  try {
    const context = await productionContext(productId);
    if (!context.ok) return { ...context, classification: "WRITE" };
    const preview = await ElryanSyncOnePreview.findOne({ tokenHash: hashToken(token) }).lean();
    if (
      !preview ||
      preview.purpose !== ELRYAN_DIMENSION_UPDATE_ACTION ||
      preview.productId !== context.assembled.productKey ||
      preview.listingId !== String(listingId || "").trim()
    ) {
      return blocked("preview_mismatch", "This preview token is not bound to this dimension update. No listing was changed.", {
        classification: "WRITE",
      });
    }
    if (new Date(preview.expiresAt).getTime() <= Date.now()) {
      return blocked("preview_expired", "The update preview has expired. No listing was changed.", {
        classification: "WRITE",
      });
    }
    const matched = await matchProductionListing({
      productId: context.assembled.productKey,
      sku: context.sku,
      listingId,
      apiKey: context.config.apiKey,
    });
    if (!matched.ok) return { ...matched, classification: "WRITE" };
    const compared = compareElryanListing({
      listing: matched.product,
      proposed: proposedValues(context.assembled),
      dimensionsConfirmed: context.assembled.dimensions?.confirmed === true,
    });
    const binding = elryanDimensionUpdateBinding({
      listingId: matched.listing.id,
      current: reviewedElryanDimensions(matched.product),
      patch: compared.dimensionPatch,
    });
    if (hashElryanDimensionUpdateBinding(binding) !== preview.bindingHash) {
      return blocked(
        "preview_stale",
        "The reviewed dimensions or the proposed patch changed. Preview the update again. No listing was changed.",
        { classification: "WRITE", rows: compared.rows, dimensionPatch: compared.dimensionPatch }
      );
    }
    if (compared.missingApiFields.length) {
      return blocked("dimension_fields_missing", "The listing does not use width, height, and depth. No listing was changed.", {
        classification: "WRITE",
        missingApiFields: compared.missingApiFields,
        rows: compared.rows,
      });
    }
    if (!compared.updateAllowed) {
      const code = context.assembled.dimensions?.confirmed === true ? "dimensions_unchanged" : "dimensions_unverified";
      return blocked(code, "No confirmed package dimension differs. No listing was changed.", {
        classification: "WRITE",
        rows: compared.rows,
      });
    }
    const result = await elryanUpdateProductionDimensions(matched.listing.id, compared.dimensionPatch);
    if (!result.ok) {
      return blocked("elryan_rejected", "Elryan did not accept the dimension update.", {
        classification: "WRITE",
        httpStatus: result.httpStatus,
      });
    }
    let saved;
    try {
      saved = await elryanGetProduct(matched.listing.id);
    } catch (err) {
      return blocked(
        "saved_read_failed",
        sanitizeElryanText(err?.message || "The dimension update was sent, and the saved listing could not be reread.", [context.config.apiKey]),
        {
          classification: "WRITE",
          httpStatus: result.httpStatus,
          listingId: matched.listing.id,
          dimensionPatch: compared.dimensionPatch,
        }
      );
    }
    const savedProduct = elryanListingIdentity(saved.product).product;
    const savedDimensions = {
      ...reviewedElryanDimensions(savedProduct),
      unit: ELRYAN_PACKAGE_DIMENSION_UNIT,
    };
    const savedCompared = compareElryanListing({
      listing: savedProduct,
      proposed: proposedValues(context.assembled),
      dimensionsConfirmed: true,
    });
    return {
      ok: true,
      classification: "WRITE",
      code: "dimensions_updated",
      environment: "production",
      sku: context.sku,
      listingId: matched.listing.id,
      dimensionPatch: compared.dimensionPatch,
      dimensionUnit: ELRYAN_PACKAGE_DIMENSION_UNIT,
      savedDimensions,
      rows: savedCompared.rows,
      httpStatus: result.httpStatus,
      message: `Elryan saved width ${savedDimensions.width} cm, height ${savedDimensions.height} cm, and depth ${savedDimensions.depth} cm.`,
    };
  } finally {
    inflightUpdates.delete(localKey);
  }
}

/**
 * WRITE — PATCH the existing Production listing with only the selling price.
 * The preview token is bound to the reviewed sellingPrice and the exact price patch.
 */
export async function updateElryanProductionPrice({ productId, listingId, confirm, previewToken } = {}) {
  if (!elryanProductWritesEnabled() || !elryanLiveProductWritesEnabled()) {
    const code = elryanProductWritesEnabled() ? "writes_gated" : "writes_disabled";
    return blocked(code, "Both write flags must be true before a Production price update.", {
      classification: "WRITE",
      httpStatus: 403,
      priceUpdateAllowed: false,
      pricePatch: {},
    });
  }
  if (confirm !== true) {
    return blocked("confirm_required", "Production price update requires explicit confirm=true.", {
      classification: "WRITE",
      priceUpdateAllowed: false,
      pricePatch: {},
    });
  }
  const token = String(previewToken || "").trim();
  if (!token) {
    return blocked("preview_required", "Production price update requires the price preview token.", {
      classification: "WRITE",
      priceUpdateAllowed: false,
      pricePatch: {},
    });
  }
  const localKey = `production-update:${String(productId || "")}`;
  if (inflightUpdates.has(localKey)) {
    return blocked("update_in_progress", "A Production update for this product is already running.", {
      classification: "WRITE",
      priceUpdateAllowed: false,
      pricePatch: {},
    });
  }
  inflightUpdates.add(localKey);
  try {
    const context = await productionContext(productId);
    if (!context.ok) return { ...context, classification: "WRITE", priceUpdateAllowed: false, pricePatch: {} };
    const preview = await ElryanSyncOnePreview.findOne({ tokenHash: hashToken(token) }).lean();
    if (
      !preview ||
      preview.purpose !== ELRYAN_PRICE_UPDATE_ACTION ||
      preview.productId !== context.assembled.productKey ||
      preview.listingId !== String(listingId || "").trim()
    ) {
      return blocked("preview_mismatch", "This preview token is not bound to this price update. No listing was changed.", {
        classification: "WRITE",
        priceUpdateAllowed: false,
        pricePatch: {},
      });
    }
    if (new Date(preview.expiresAt).getTime() <= Date.now()) {
      return blocked("preview_expired", "The price preview has expired. No listing was changed.", {
        classification: "WRITE",
        priceUpdateAllowed: false,
        pricePatch: {},
      });
    }
    const matched = await matchProductionListing({
      productId: context.assembled.productKey,
      sku: context.sku,
      listingId,
      apiKey: context.config.apiKey,
    });
    if (!matched.ok) return { ...matched, classification: "WRITE", priceUpdateAllowed: false, pricePatch: {} };
    const priceReview = reviewElryanSellingPrice({
      product: matched.product,
      approvedPrice: context.assembled.payload?.price,
      approvalValid: context.assembled.pricingApproval?.valid === true,
    });
    const binding = elryanPriceUpdateBinding({
      listingId: matched.listing.id,
      currentSellingPrice: priceReview.currentSellingPrice,
      price: priceReview.pricePatch.price,
    });
    if (hashElryanPriceUpdateBinding(binding) !== preview.bindingHash) {
      return blocked(
        "preview_stale",
        "The reviewed selling price or the approved price changed. Preview the update again. No listing was changed.",
        {
          classification: "WRITE",
          currentSellingPrice: priceReview.currentSellingPrice,
          approvedPrice: priceReview.approvedPrice,
          pricePatch: priceReview.pricePatch,
          priceUpdateAllowed: false,
        }
      );
    }
    if (!priceReview.priceUpdateAllowed) {
      return blocked(priceReview.priceCode, elryanPriceReviewMessage(priceReview.priceCode), {
        classification: "WRITE",
        currentSellingPrice: priceReview.currentSellingPrice,
        approvedPrice: priceReview.approvedPrice,
        priceCurrency: priceReview.currency,
        pricePatch: {},
        priceUpdateAllowed: false,
      });
    }
    const result = await elryanUpdateProductionPrice(matched.listing.id, priceReview.pricePatch.price);
    if (!result.ok) {
      return blocked("elryan_rejected", "Elryan did not accept the selling-price update.", {
        classification: "WRITE",
        httpStatus: result.httpStatus,
        priceUpdateAllowed: false,
        pricePatch: priceReview.pricePatch,
      });
    }
    let saved;
    try {
      saved = await elryanGetProduct(matched.listing.id);
    } catch (err) {
      return blocked(
        "saved_read_failed",
        sanitizeElryanText(err?.message || "The price update was sent, and the saved listing could not be reread.", [context.config.apiKey]),
        {
          classification: "WRITE",
          httpStatus: result.httpStatus,
          listingId: matched.listing.id,
          pricePatch: priceReview.pricePatch,
          priceUpdateAllowed: false,
        }
      );
    }
    const savedIdentity = elryanListingIdentity(saved.product);
    if (savedIdentity.id !== matched.listing.id || savedIdentity.sku !== context.sku) {
      return blocked(
        "listing_mismatch",
        "The listing read after the price update does not match this SKU and listing ID.",
        {
          classification: "WRITE",
          httpStatus: result.httpStatus,
          listing: { id: savedIdentity.id, sku: savedIdentity.sku },
          priceUpdateAllowed: false,
          pricePatch: priceReview.pricePatch,
        }
      );
    }
    const savedPrice = readElryanSellingPrice(savedIdentity.product);
    if (!savedPrice.present || savedPrice.amount == null) {
      return blocked(
        "saved_price_unreadable",
        "The price update was sent, and the reread listing did not include sellingPrice.",
        {
          classification: "WRITE",
          httpStatus: result.httpStatus,
          listingId: matched.listing.id,
          pricePatch: priceReview.pricePatch,
          priceUpdateAllowed: false,
        }
      );
    }
    return {
      ok: true,
      classification: "WRITE",
      code: "price_updated",
      environment: "production",
      sku: context.sku,
      listingId: matched.listing.id,
      currentSellingPrice: priceReview.currentSellingPrice,
      approvedPrice: priceReview.approvedPrice,
      savedSellingPrice: savedPrice.amount,
      priceCurrency: priceReview.currency,
      pricePatch: priceReview.pricePatch,
      priceUpdateAllowed: false,
      httpStatus: result.httpStatus,
      message: `Elryan saved selling price ${savedPrice.amount} IQD.`,
    };
  } finally {
    inflightUpdates.delete(localKey);
  }
}
