import { ELRYAN_PACKAGE_DIMENSIONS_NOTE } from "./elryanPricing.js";
import { assessElryanDimensionConfirmation } from "./elryanStagingGate.js";

export const ELRYAN_DIMENSION_SOURCE = {
  PRODUCT_OVERRIDE: "PRODUCT_OVERRIDE",
  COLLECTION_AUTO: "COLLECTION_AUTO",
  SUGGESTED: "SUGGESTED",
  MISSING: "MISSING",
};

const EMPTY_DIMS = { unit: "", width: null, height: null, depth: null };

export function positiveElryanDimension(value) {
  if (typeof value === "boolean" || value == null || typeof value === "object") return null;
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

export function brownCollectionIdentity(product) {
  const raw = product?.collectionName;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { collectionId: "", ambiguous: true, reason: "missing_collection" };
  }
  const primary = raw._id != null && String(raw._id).trim() !== "" ? String(raw._id).trim() : "";
  const alternate = raw.id != null && String(raw.id).trim() !== "" ? String(raw.id).trim() : "";
  if (primary && alternate && primary !== alternate) {
    return { collectionId: "", ambiguous: true, reason: "ambiguous_collection" };
  }
  const collectionId = primary || alternate;
  if (!collectionId) return { collectionId: "", ambiguous: true, reason: "missing_collection" };
  return { collectionId, ambiguous: false, reason: "" };
}

function missing(reason, identity, extra = {}) {
  return {
    source: ELRYAN_DIMENSION_SOURCE.MISSING,
    confirmed: false,
    usable: false,
    code: "DIMENSIONS_UNVERIFIED",
    reason,
    ...EMPTY_DIMS,
    collectionId: identity?.collectionId || "",
    suggestion: null,
    ...extra,
  };
}

function ruleMatchesCollection(rule, collectionId) {
  return Boolean(rule) && rule.environment === "staging" && String(rule.brownCollectionId || "") === String(collectionId || "");
}

/**
 * How a stored collection rule behaves for a product that has no higher-priority source.
 * Parent categories are never consulted. The caller must pass this collection's own rule.
 */
export function elryanCollectionRuleBucket(rule, collectionId) {
  if (!ruleMatchesCollection(rule, collectionId)) return { bucket: "missing", reason: "missing_mapping" };
  if (rule.applyMode === "DISABLED" || rule.enabled !== true) return { bucket: "missing", reason: "disabled" };
  const width = positiveElryanDimension(rule.width);
  const height = positiveElryanDimension(rule.height);
  const depth = positiveElryanDimension(rule.depth);
  if (String(rule.unit || "") !== "cm" || !width || !height || !depth) {
    return { bucket: "invalid", reason: "invalid_dimensions" };
  }
  if (rule.applyMode === "SUGGEST_REVIEW") return { bucket: "suggest", reason: "suggest_review" };
  if (rule.applyMode === "AUTO_APPLY" && rule.verifiedForCollection === true) {
    return { bucket: "auto", reason: "collection_auto", width, height, depth };
  }
  return { bucket: "missing", reason: "unverified_collection" };
}

export function summarizeCollectionDimensionCoverage({
  productCount = 0,
  productOverride = 0,
  excludedOnly = 0,
  ambiguousOnly = 0,
  differs = 0,
  excluded = 0,
  ambiguous = 0,
  rule = null,
  collectionId = "",
} = {}) {
  const inheritable = Math.max(0, Number(productCount) - Number(productOverride) - Number(excludedOnly) - Number(ambiguousOnly));
  const decision = elryanCollectionRuleBucket(rule, collectionId);
  const counts = {
    productCount: Number(productCount) || 0,
    productOverride: Number(productOverride) || 0,
    collectionAuto: 0,
    suggested: 0,
    missing: Number(excludedOnly) + Number(ambiguousOnly),
    invalid: 0,
    differs: Number(differs) || 0,
    excluded: Number(excluded) || 0,
    ambiguous: Number(ambiguous) || 0,
  };
  if (decision.bucket === "auto") counts.collectionAuto = inheritable;
  else if (decision.bucket === "suggest") counts.suggested = inheritable;
  else if (decision.bucket === "invalid") counts.invalid = inheritable;
  else counts.missing += inheritable;
  return counts;
}

/**
 * Priority:
 * 1. Verified Staging product dimensions.
 * 2. Enabled, operator-confirmed AUTO_APPLY rule for this collection only.
 * 3. SUGGEST_REVIEW is visible and not confirmed.
 * 4. DIMENSIONS_UNVERIFIED.
 * Production never inherits Staging rules or Staging product checks.
 */
export function resolveElryanDimensions({
  environment,
  product,
  dimensionRow = null,
  collectionRule = null,
  excluded = false,
} = {}) {
  const identity = brownCollectionIdentity(product);
  const env = String(environment || "");

  if (env === "staging") {
    const productCheck = assessElryanDimensionConfirmation(dimensionRow);
    if (productCheck.confirmed) {
      return {
        source: ELRYAN_DIMENSION_SOURCE.PRODUCT_OVERRIDE,
        confirmed: true,
        usable: true,
        code: "",
        reason: "product_override",
        unit: productCheck.unit,
        width: productCheck.width,
        height: productCheck.height,
        depth: productCheck.depth,
        collectionId: identity.collectionId,
        suggestion: null,
      };
    }
  } else {
    return missing(env === "production" ? "production_isolated" : "unsupported_environment", identity);
  }

  if (identity.ambiguous || !identity.collectionId) {
    return missing(identity.reason || "ambiguous_collection", identity);
  }
  if (excluded) return missing("excluded", identity);

  const decision = elryanCollectionRuleBucket(collectionRule, identity.collectionId);
  if (decision.bucket === "auto") {
    return {
      source: ELRYAN_DIMENSION_SOURCE.COLLECTION_AUTO,
      confirmed: true,
      usable: true,
      code: "",
      reason: "collection_auto",
      unit: "cm",
      width: decision.width,
      height: decision.height,
      depth: decision.depth,
      collectionId: identity.collectionId,
      suggestion: null,
    };
  }
  if (decision.bucket === "suggest") {
    return {
      source: ELRYAN_DIMENSION_SOURCE.SUGGESTED,
      confirmed: false,
      usable: false,
      code: "DIMENSIONS_UNVERIFIED",
      reason: "suggest_review",
      ...EMPTY_DIMS,
      collectionId: identity.collectionId,
      suggestion: {
        unit: "cm",
        width: positiveElryanDimension(collectionRule.width),
        height: positiveElryanDimension(collectionRule.height),
        depth: positiveElryanDimension(collectionRule.depth),
      },
    };
  }
  return missing(decision.reason, identity);
}

export function presentElryanPackageDimensions(dimensions) {
  const source = dimensions?.source || ELRYAN_DIMENSION_SOURCE.MISSING;
  const base = {
    source,
    code: dimensions?.confirmed ? "" : "DIMENSIONS_UNVERIFIED",
    reason: dimensions?.reason || "",
    collectionId: dimensions?.collectionId || "",
    suggestion: dimensions?.suggestion || null,
    unit: dimensions?.confirmed ? dimensions.unit : "",
    width: dimensions?.confirmed ? dimensions.width : null,
    height: dimensions?.confirmed ? dimensions.height : null,
    depth: dimensions?.confirmed ? dimensions.depth : null,
  };
  if (source === ELRYAN_DIMENSION_SOURCE.PRODUCT_OVERRIDE && dimensions?.confirmed) {
    return {
      ...base,
      status: "CONFIRMED",
      note: "Product-specific Staging dimensions override any collection rule. The BrownStore product record was not changed.",
    };
  }
  if (source === ELRYAN_DIMENSION_SOURCE.COLLECTION_AUTO && dimensions?.confirmed) {
    return {
      ...base,
      status: "CONFIRMED",
      note: "Inherited from a Staging collection rule the operator confirmed as packed shipping-carton dimensions for that collection's eligible products. This is not a measurement of each product.",
    };
  }
  if (source === ELRYAN_DIMENSION_SOURCE.SUGGESTED) {
    return {
      ...base,
      status: "UNVERIFIED",
      note: "The collection rule is only a suggestion. It is not confirmed and does not authorize sending.",
    };
  }
  return {
    ...base,
    status: "UNVERIFIED",
    note: `${ELRYAN_PACKAGE_DIMENSIONS_NOTE} Sending stays blocked until a verified product override or a confirmed collection AUTO_APPLY rule applies. Staging rules are never used in Production.`,
  };
}
