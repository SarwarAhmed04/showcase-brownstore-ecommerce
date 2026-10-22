export const VISIBILITY_SCOPES = [
  "category",
  "subcategory",
  "collection",
  "brand",
  "vendor",
  "product",
];

export const LARGE_BULK_COUNT = 25;

const SCOPE_PATHS = [
  ["category", "category._id"],
  ["subcategory", "subCategory._id"],
  ["collection", "collectionName._id"],
  ["brand", "brand._id"],
  ["vendor", "createdBy._id"],
  ["product", "_id"],
];

const REASON_TEXT = {
  platform_inactive: "Platform is inactive",
  category_inactive: "Category is inactive",
  subcategory_inactive: "Subcategory is inactive",
  collection_inactive: "Collection is inactive",
  brand_inactive: "Brand is inactive",
  vendor_inactive: "Vendor is inactive",
  product_inactive: "Product is inactive",
  taxonomy_config_missing: "Platform category setup is missing",
};

export function entityId(value) {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    const id = value._id != null && value._id !== "" ? value._id : value.id;
    if (id == null || id === "") return "";
    return String(id);
  }
  return String(value);
}

export function productScopeIds(product) {
  const raw = typeof product?.toObject === "function" ? product.toObject() : product || {};
  return {
    category: entityId(raw.category),
    subcategory: entityId(raw.subCategory),
    collection: entityId(raw.collectionName),
    brand: entityId(raw.brand),
    vendor: entityId(raw.createdBy),
    product: entityId(raw._id || raw.id),
  };
}

function inactiveSet(context, scope) {
  const set = context?.inactive?.[scope];
  return set instanceof Set ? set : new Set();
}

export function evaluatePlatformEligibility(product, context = {}) {
  const ids = productScopeIds(product);
  const reasons = [];
  if (context.partnerActive === false) {
    reasons.push({
      code: "platform_inactive",
      scope: "platform",
      targetId: "",
      message: REASON_TEXT.platform_inactive,
    });
  }

  const checks = [
    ["category", "category_inactive"],
    ["subcategory", "subcategory_inactive"],
    ["collection", "collection_inactive"],
    ["brand", "brand_inactive"],
    ["vendor", "vendor_inactive"],
    ["product", "product_inactive"],
  ];
  for (const [scope, code] of checks) {
    const targetId = ids[scope];
    if (!targetId) continue;
    if (!inactiveSet(context, scope).has(targetId)) continue;
    reasons.push({
      code,
      scope,
      targetId,
      message: REASON_TEXT[code],
    });
  }

  if (context.taxonomyRequired === true) {
    const configured =
      context.configuredCollectionIds instanceof Set ? context.configuredCollectionIds : new Set();
    if (!ids.collection || !configured.has(ids.collection)) {
      reasons.push({
        code: "taxonomy_config_missing",
        scope: "collection",
        targetId: ids.collection || "",
        message:
          context.partnerSlug === "gini"
            ? "Gini category/subcategory values are missing"
            : REASON_TEXT.taxonomy_config_missing,
      });
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function eligibilityBucket(result) {
  if (result?.eligible) return "ready";
  const reasons = result?.reasons || [];
  if (reasons.some((reason) => reason.code !== "taxonomy_config_missing")) return "inactive";
  return "missing_setup";
}

function idExpr(path) {
  return { $toString: { $ifNull: [`$${path}`, ""] } };
}

function exprIn(path, ids, shouldMatch) {
  const list = [...(ids || [])].map((id) => String(id)).filter(Boolean);
  if (shouldMatch) {
    if (!list.length) return { $expr: { $eq: [1, 0] } };
    return { $expr: { $in: [idExpr(path), list] } };
  }
  if (!list.length) return null;
  return { $expr: { $not: { $in: [idExpr(path), list] } } };
}

function readyClauses(context) {
  if (context?.partnerActive === false) return [{ _id: { $exists: false } }];
  const clauses = [];
  if (context?.taxonomyRequired === true) {
    clauses.push(exprIn("collectionName._id", context?.configuredCollectionIds, true));
  }
  for (const [scope, path] of SCOPE_PATHS) {
    const clause = exprIn(path, inactiveSet(context, scope), false);
    if (clause) clauses.push(clause);
  }
  return clauses;
}

function asAnd(clauses) {
  const items = (clauses || []).filter(Boolean);
  if (!items.length) return {};
  if (items.length === 1) return items[0];
  return { $and: items };
}

export function eligibilityMongoFilter(context, mode) {
  const normalized = String(mode || "all").trim().toLowerCase();
  if (!normalized || normalized === "all") return null;
  const ready = asAnd(readyClauses(context));
  if (normalized === "ready") return ready;
  if (normalized === "blocked") return { $nor: [ready] };
  if (normalized === "unmapped" || normalized === "missing_setup") {
    if (context?.partnerActive === false || context?.taxonomyRequired !== true) {
      return { _id: { $exists: false } };
    }
    const clauses = [];
    const mapped = [...(context?.configuredCollectionIds || [])];
    if (mapped.length) {
      clauses.push({
        $expr: { $not: { $in: [idExpr("collectionName._id"), mapped.map(String)] } },
      });
    }
    for (const [scope, path] of SCOPE_PATHS) {
      const clause = exprIn(path, inactiveSet(context, scope), false);
      if (clause) clauses.push(clause);
    }
    return asAnd(clauses);
  }
  if (normalized === "inactive" || normalized === "excluded") {
    if (context?.partnerActive === false) return {};
    const clauses = [];
    for (const [scope, path] of SCOPE_PATHS) {
      const ids = inactiveSet(context, scope);
      if (!ids.size) continue;
      clauses.push(exprIn(path, ids, true));
    }
    if (!clauses.length) return { _id: { $exists: false } };
    return clauses.length === 1 ? clauses[0] : { $or: clauses };
  }
  return null;
}

export function emptyInactiveSets() {
  return {
    category: new Set(),
    subcategory: new Set(),
    collection: new Set(),
    brand: new Set(),
    vendor: new Set(),
    product: new Set(),
  };
}
