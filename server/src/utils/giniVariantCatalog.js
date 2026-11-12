import { giniSkuKey, normalizeGiniItemCode } from "./giniSyncOnePlan.js";

export function giniVariantSyncWritesEnabled(env = process.env) {
  return env.GINI_VARIANT_SYNC_WRITES_ENABLED === "true" && env.GINI_ALLOW_LIVE_VARIANT_SYNC === "true";
}

function text(value, key) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value.name) return text(value.name, key);
  if (value[key]) return String(value[key]).trim();
  return "";
}

export function variantColorLabel(color) {
  return text(color, "en") || text(color, "ku") || text(color, "ar");
}

export function variantSizeLabel(size) {
  if (size == null || size === "") return "";
  if (typeof size === "string" || typeof size === "number") return String(size).trim();
  return text(size, "en") || text(size, "ku") || text(size, "ar");
}

export function variantSkuToken(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function proposeVariantSku(parentSku, color, size, { multipleSizes = false } = {}) {
  const parent = variantSkuToken(normalizeGiniItemCode(parentSku));
  const colorToken = variantSkuToken(color);
  if (!parent || !colorToken) return "";
  if (!multipleSizes) return `${parent}-${colorToken}`;
  const sizeToken = variantSkuToken(size);
  if (!sizeToken) return "";
  return `${parent}-${colorToken}-${sizeToken}`;
}

function whole(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

export function variationCombinations(doc) {
  const rows = [];
  for (const variant of doc?.variants || []) {
    const color = variantColorLabel(variant?.color);
    const sourceVariantId = String(variant?._id || "");
    const images = Array.isArray(variant?.images) ? variant.images.filter((image) => image?.url).length : 0;
    const sizes = Array.isArray(variant?.sizes) ? variant.sizes : [];
    for (const size of sizes) {
      const sizeName = variantSizeLabel(size?.size);
      const stock = whole(size?.stockQuantity);
      if (!color || !sizeName || stock == null || !sourceVariantId) continue;
      const ownPrice = size?.price ?? variant?.price;
      rows.push({
        sourceVariantId,
        sourceSizeId: String(size?._id || ""),
        color,
        colorKey: color.toLowerCase(),
        size: sizeName,
        sizeKey: sizeName.toLowerCase(),
        stock,
        ownPrice: ownPrice == null || ownPrice === "" || !Number.isFinite(Number(ownPrice)) ? null : Number(ownPrice),
        images,
      });
    }
  }
  return rows;
}

function collectImageUrls(doc) {
  const urls = [];
  const seen = new Set();
  for (const variant of doc?.variants || []) {
    for (const image of variant?.images || []) {
      const url = String(image?.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
      if (urls.length >= 8) return urls;
    }
  }
  return urls;
}

function contractHas(contract, value) {
  if (!contract?.attributeId || !Array.isArray(contract.values)) return false;
  const wanted = String(value || "").trim().toLowerCase();
  return contract.values.some((item) => String(item || "").trim().toLowerCase() === wanted);
}

export function classifyVariantProduct({
  doc,
  giniPrice = null,
  mappingOk = false,
  categoryId = "",
  subcategoryId = "",
  ownerIds = [],
  canonicalOwnerId = "",
  identities = [],
  colorContract = null,
  sizeContract = null,
  remoteParent = null,
  operationStatus = "",
} = {}) {
  const combinations = variationCombinations(doc);
  const colors = new Set(combinations.map((row) => row.colorKey));
  const sizes = new Set(combinations.map((row) => row.sizeKey));
  const multipleSizes = sizes.size > 1;
  const parentSku = normalizeGiniItemCode(doc?.itemCode);
  const proposals = combinations.map((row) => ({
    ...row,
    proposedSku: proposeVariantSku(parentSku, row.color, row.size, { multipleSizes }),
    attributeId: multipleSizes ? "" : contractHas(colorContract, row.color) ? String(colorContract.attributeId) : "",
    attributeName: multipleSizes ? "" : contractHas(colorContract, row.color) ? String(colorContract.name || "Color") : "",
    price: row.ownPrice != null && Number.isInteger(row.ownPrice) ? row.ownPrice : giniPrice,
  }));
  const blockers = [];
  if (combinations.length < 2) blockers.push("not_multi_variant");
  if (multipleSizes && !sizeContract?.attributeId) blockers.push("size_attribute_unverified");
  if (!mappingOk) blockers.push("missing_mapping");
  if (!Number.isInteger(giniPrice) || giniPrice < 1) blockers.push("invalid_price");
  if (combinations.some((row) => row.images < 1)) blockers.push("missing_image");
  if (combinations.reduce((sum, row) => sum + row.stock, 0) === 0) blockers.push("zero_stock");
  if (proposals.some((row) => !row.attributeId)) blockers.push("missing_attribute");
  if (proposals.some((row) => !row.proposedSku)) blockers.push("missing_variant_sku");
  const duplicate = ownerIds.filter(Boolean).length > 1;
  const owns = canonicalOwnerId && String(canonicalOwnerId) === String(doc?._id || "");
  const ownedByOther = canonicalOwnerId && !owns;
  if (duplicate && !owns) blockers.push("duplicate_parent_sku");
  if (ownedByOther) blockers.push("other_vendor_owns_parent");
  const identityBySource = new Map(
    (identities || []).map((row) => [`${row.sourceVariantId}\0${row.sourceSizeId || ""}`, row])
  );
  const approved = proposals.every((row) => {
    const saved = identityBySource.get(`${row.sourceVariantId}\0${row.sourceSizeId}`);
    return saved && giniSkuKey(saved.approvedSku) && giniSkuKey(saved.approvedSku) === giniSkuKey(row.proposedSku);
  });
  if (!approved) blockers.push("missing_variant_sku_approval");
  const verified = proposals.every((row) => {
    const saved = identityBySource.get(`${row.sourceVariantId}\0${row.sourceSizeId}`);
    return saved?.status === "verified" && saved.confirmedGiniVariantId && giniSkuKey(saved.approvedSku) === giniSkuKey(row.proposedSku);
  });
  const uncertain = ["parent_uncertain", "variants_uncertain", "parent_in_progress", "variants_in_progress"].includes(operationStatus);
  const hard = ["size_attribute_unverified", "missing_mapping", "invalid_price", "missing_image", "zero_stock", "missing_attribute", "missing_variant_sku", "not_multi_variant", "other_vendor_owns_parent"];
  let status = "BLOCKED";
  if (uncertain) status = "UNCERTAIN";
  else if (verified && remoteParent?.giniProductId && String(remoteParent.productId || "") === String(doc?._id || "")) status = "VERIFIED_REMOTE";
  else if (blockers.includes("size_attribute_unverified") || blockers.includes("other_vendor_owns_parent")) status = "BLOCKED";
  else if (duplicate && !owns) status = "NEEDS_REVIEW";
  else if (blockers.some((code) => hard.includes(code))) status = "BLOCKED";
  else if (approved) status = "APPROVED_FOR_FUTURE_SYNC";
  else status = "READY_FOR_REVIEW";
  if (status === "VERIFIED_REMOTE" || status === "APPROVED_FOR_FUTURE_SYNC" || status === "READY_FOR_REVIEW") {
    // A verified or reviewable product is not sendable from this phase.
  }
  return {
    productId: String(doc?._id || ""),
    name: text(doc?.name, "en") || text(doc?.name, "ar"),
    vendor: text(doc?.createdBy, "en") || String(doc?.createdBy?.name || ""),
    vendorId: String(doc?.createdBy?._id || ""),
    sourceItemId: String(doc?.ibsherId || ""),
    parentSku,
    categoryId,
    subcategoryId,
    imageUrls: collectImageUrls(doc),
    combinations: proposals,
    blockers: [...new Set(blockers)],
    status,
    canSend: false,
    intendedAction: status === "VERIFIED_REMOTE" ? "none" : status === "APPROVED_FOR_FUTURE_SYNC" ? "future_sync_not_enabled" : "review_only",
    remoteParent: remoteParent || null,
    multipleSizes,
  };
}

export function proposalConflicts(products) {
  const seen = new Map();
  const conflicts = [];
  for (const product of products || []) {
    if ((product.blockers || []).includes("other_vendor_owns_parent")) continue;
    for (const row of product.combinations || []) {
      const key = giniSkuKey(row.proposedSku);
      if (!key) continue;
      const previous = seen.get(key);
      if (previous && (previous.productId !== product.productId || previous.sourceVariantId !== row.sourceVariantId || previous.sourceSizeId !== row.sourceSizeId)) {
        conflicts.push({ sku: row.proposedSku, productId: product.productId, otherProductId: previous.productId });
      } else if (!previous) {
        seen.set(key, { productId: product.productId, sourceVariantId: row.sourceVariantId, sourceSizeId: row.sourceSizeId });
      }
    }
  }
  return conflicts;
}
