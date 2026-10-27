import { ELRYAN_READINESS } from "./elryanConstants.js";
import { validateElryanSku } from "./elryanSku.js";

export function validateElryanPreviewParts({
  hasApiKey,
  resolved,
  sku,
  mapping,
  brand,
  color,
  warranty,
  attributes,
  requiredAttributeCodes = [],
  variation,
  pricing,
  images,
}) {
  const blockers = [];

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

  if (!warranty?.elryanCode) {
    blockers.push({ code: "missing_warranty_mapping", status: ELRYAN_READINESS.MISSING_MAPPING });
  }

  if (!images?.length) {
    blockers.push({ code: "missing_image", status: ELRYAN_READINESS.MISSING_REQUIRED_FIELD });
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

  if (variation && !variation.ok) {
    for (const reason of variation.reasons || []) {
      blockers.push({
        code: reason,
        status: ELRYAN_READINESS.NOT_READY,
        message: "Multi-size / multi-variant Elryan model is not verified; product blocked.",
      });
    }
  }

  if (!pricing?.proposedElryanPrice || pricing.proposedElryanPrice <= 0) {
    blockers.push({ code: "invalid_platform_price", status: ELRYAN_READINESS.NOT_READY });
  }

  // Price/cost semantics with Elryan marketplace commission remain unconfirmed.
  blockers.push({
    code: "pricing_unverified",
    status: ELRYAN_READINESS.PRICING_UNVERIFIED,
    message: pricing?.pricingNote || "Elryan price/cost semantics are not confirmed.",
  });

  const statuses = blockers.map((b) => b.status);
  let readiness = ELRYAN_READINESS.READY;
  if (statuses.includes(ELRYAN_READINESS.API_ACCESS_PENDING)) {
    readiness = ELRYAN_READINESS.API_ACCESS_PENDING;
  } else if (statuses.includes(ELRYAN_READINESS.MISSING_MAPPING)) {
    readiness = ELRYAN_READINESS.MISSING_MAPPING;
  } else if (statuses.includes(ELRYAN_READINESS.MISSING_REQUIRED_FIELD)) {
    readiness = ELRYAN_READINESS.MISSING_REQUIRED_FIELD;
  } else if (statuses.includes(ELRYAN_READINESS.NOT_READY)) {
    readiness = ELRYAN_READINESS.NOT_READY;
  } else if (statuses.includes(ELRYAN_READINESS.PRICING_UNVERIFIED)) {
    readiness = ELRYAN_READINESS.PRICING_UNVERIFIED;
  }

  // Never READY while pricing unverified (always present in this phase).
  if (readiness === ELRYAN_READINESS.READY) {
    readiness = ELRYAN_READINESS.PRICING_UNVERIFIED;
  }

  return {
    readiness,
    blockers,
    canProposePayload: !statuses.includes(ELRYAN_READINESS.MISSING_MAPPING),
  };
}
