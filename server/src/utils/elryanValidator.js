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
  pricingApproval,
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

  if (pricingApproval && pricingApproval.valid !== true) {
    const reason = String(pricingApproval.reason || "missing");
    const approvalMessage = {
      missing: "No Staging price approval is saved for this product.",
      environment: "The saved price approval is not for Staging.",
      product: "The saved price approval is for a different product.",
      sku: "The saved price approval does not match this SKU.",
      payload_mismatch: "The saved price approval does not match the current payload.",
      price: "The saved price approval does not match the calculated price.",
      cost: "The saved price approval does not omit cost.",
      currency: "The saved price approval is not IQD.",
    }[reason];
    blockers.push({
      code: "pricing_unverified",
      status: ELRYAN_READINESS.PRICING_UNVERIFIED,
      message: approvalMessage || "The saved Staging price approval does not match this product.",
    });
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

/** Sync All blocks a category the snapshot explicitly marks as a parent. */
export function elryanParentCategoryBlocker(category) {
  if (!category || category.isParent !== true) return null;
  return {
    code: "category_not_leaf",
    status: ELRYAN_READINESS.MISSING_MAPPING,
    message: "Mapped Elryan category is a parent. Product create needs a leaf category id.",
  };
}

/**
 * Sync One may create a Staging product, so a mapped category is a leaf only when
 * this row was stored with isParent false in a complete Staging snapshot.
 * A missing row, unknown isParent, or incomplete snapshot is not treated as a leaf.
 */
export function elryanVerifiedLeafBlocker({ category = null, snapshot = null } = {}) {
  if (!snapshot || snapshot.status !== "complete" || snapshot.coverage !== "complete") {
    return {
      code: "category_not_leaf",
      status: ELRYAN_READINESS.MISSING_MAPPING,
      message:
        "The Staging category catalog snapshot is missing or incomplete, so the mapped category is not a verified leaf.",
    };
  }
  if (!category) {
    return {
      code: "category_not_leaf",
      status: ELRYAN_READINESS.MISSING_MAPPING,
      message: "The mapped Elryan category is not in the Staging catalog snapshot.",
    };
  }
  if (category.isParent === true) {
    return {
      code: "category_not_leaf",
      status: ELRYAN_READINESS.MISSING_MAPPING,
      message: "Mapped Elryan category is a parent. Product create needs a leaf category id.",
    };
  }
  if (category.isParent !== false) {
    return {
      code: "category_not_leaf",
      status: ELRYAN_READINESS.MISSING_MAPPING,
      message: "The mapped Elryan category is not a confirmed leaf because isParent is unknown.",
    };
  }
  return null;
}
