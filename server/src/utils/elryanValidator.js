import { ELRYAN_READINESS } from "./elryanConstants.js";
import { validateElryanSku } from "./elryanSku.js";
import { warrantyBlockersFor } from "./elryanWarranty.js";

export function validateElryanPreviewParts({
  hasApiKey,
  resolved,
  sku,
  mapping,
  brand,
  color,
  warranty,
  warrantyCatalog,
  attributes,
  requiredAttributeCodes = [],
  rejectedAttributeCodes = [],
  attributeSetUnverified = false,
  variation,
  pricing,
  images,
  extraBlockers = [],
}) {
  const blockers = [];
  for (const extra of extraBlockers) {
    if (extra?.code) blockers.push(extra);
  }

  if (!hasApiKey) blockers.push({ code: "api_access_pending", status: ELRYAN_READINESS.API_ACCESS_PENDING });

  const skuCheck = validateElryanSku(sku);
  if (!skuCheck.ok) {
    blockers.push({
      code: skuCheck.code,
      status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
      message: skuCheck.message,
    });
  }

  if (!resolved?.name?.en && !resolved?.name?.ar) {
    blockers.push({ code: "missing_name", status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD });
  }

  if (!mapping?.categoryId) {
    blockers.push({ code: "missing_category_mapping", status: ELRYAN_READINESS.MISSING_MAPPING });
  }

  if (!brand?.elryanId) {
    blockers.push({ code: "missing_brand_mapping", status: ELRYAN_READINESS.MISSING_MAPPING });
  }

  if (!color?.elryanId) {
    blockers.push({ code: "missing_color_mapping", status: ELRYAN_READINESS.MISSING_MAPPING });
  }

  blockers.push(...warrantyBlockersFor({ code: warranty?.elryanCode, catalog: warrantyCatalog }));

  if (!images?.length) {
    blockers.push({ code: "missing_image", status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD });
  }

  if (attributeSetUnverified) {
    blockers.push({
      code: "attribute_set_unverified",
      status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
      message: "The category attribute set could not be read, so required attributes are unverified.",
    });
  }

  for (const code of requiredAttributeCodes) {
    if (!attributes || !String(attributes[code] ?? "").trim()) {
      blockers.push({
        code: `missing_attribute_${code}`,
        status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
        message: `Required Elryan attribute "${code}" is not mapped.`,
      });
    }
  }

  for (const code of rejectedAttributeCodes) {
    blockers.push({
      code: `unverified_attribute_${code}`,
      status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD,
      message: `Attribute "${code}" is not one of the values published for this category.`,
    });
  }

  if (variation && !variation.ok) {
    for (const reason of variation.reasons || []) {
      blockers.push({
        code: reason,
        status: ELRYAN_READINESS.NOT_READY,
        message: "Multi-size / multi-variant Elryan model is not verified; product blocked.",
      });
    }
  }

  if (pricing?.priceReview) {
    blockers.push({
      code: "price_needs_review",
      status: ELRYAN_READINESS.NOT_READY,
      message: "The original IBSHER regular price is missing or ambiguous.",
    });
  } else if (!pricing?.proposedElryanPrice || pricing.proposedElryanPrice <= 0) {
    blockers.push({ code: "invalid_platform_price", status: ELRYAN_READINESS.NOT_READY });
  }

  const decision = elryanPreviewDecision({ blockers });
  return {
    readiness: decision.readiness,
    blockers,
    ready: decision.ready,
    canProposePayload: !decision.statuses.includes(ELRYAN_READINESS.MISSING_MAPPING),
  };
}

/**
 * Shared READY rule for Sync One and Sync All.
 * Any remaining blocker, including pricing_unverified, keeps the product out of READY.
 */
export function elryanPreviewDecision({ blockers = [], readiness = "" } = {}) {
  const list = Array.isArray(blockers) ? blockers.filter((blocker) => blocker?.code) : [];
  const statuses = list.map((blocker) => blocker.status);
  let next = readiness || ELRYAN_READINESS.READY;
  if (!readiness) {
    if (statuses.includes(ELRYAN_READINESS.API_ACCESS_PENDING)) {
      next = ELRYAN_READINESS.API_ACCESS_PENDING;
    } else if (statuses.includes(ELRYAN_READINESS.MISSING_MAPPING)) {
      next = ELRYAN_READINESS.MISSING_MAPPING;
    } else if (statuses.includes(ELRYAN_READINESS.MISSING_REQUIRED_FIELD)) {
      next = ELRYAN_READINESS.MISSING_REQUIRED_FIELD;
    } else if (statuses.includes(ELRYAN_READINESS.NOT_READY)) {
      next = ELRYAN_READINESS.NOT_READY;
    } else if (statuses.includes(ELRYAN_READINESS.WARRANTY_UNVERIFIED)) {
      next = ELRYAN_READINESS.WARRANTY_UNVERIFIED;
    } else if (statuses.includes(ELRYAN_READINESS.PRICING_UNVERIFIED)) {
      next = ELRYAN_READINESS.PRICING_UNVERIFIED;
    }
  }
  if (list.length > 0 && next === ELRYAN_READINESS.READY) {
    next = list.some(
      (blocker) =>
        blocker.code === "pricing_unverified" || blocker.status === ELRYAN_READINESS.PRICING_UNVERIFIED
    )
      ? ELRYAN_READINESS.PRICING_UNVERIFIED
      : ELRYAN_READINESS.NOT_READY;
  }
  const ready = next === ELRYAN_READINESS.READY && list.length === 0;
  return { readiness: ready ? ELRYAN_READINESS.READY : next, ready, statuses };
}
