import crypto from "crypto";
import { GINI_SAFETY_STOCK } from "./platformExcel/gini.js";
import { productScopeIds } from "./platformEligibility.js";
import { giniMappingStatus } from "./giniCategoryTree.js";
import {
  GINI_DESCRIPTION_MAX_WORDS,
  GINI_IMAGE_LIMIT,
  GINI_NAME_MAX,
  assessSimpleProduct,
  buildSimplePayloadPreview,
  decideSyncAction,
  giniCatalogText,
  giniSkuKey,
  isAllowedMediaUrl,
  listGiniImageUrls,
  normalizeGiniItemCode,
  wordCount,
} from "./giniSyncOnePlan.js";
import { isGiniHistoricalHoldSku } from "./giniHistoricalHold.js";

const BLOCKER_TEXT = {
  duplicate_brownstore_sku: "More than one BrownStore product uses this SKU.",
  existing_gini_product: "This SKU already exists on GINI. A future action would be UPDATE.",
  missing_sku: "This product has no itemCode SKU.",
  missing_mapping: "This collection has no saved GINI category mapping.",
  invalid_mapping: "The saved GINI category mapping is not in the live category tree.",
  inactive_mapping: "The saved GINI category or subcategory is inactive.",
  missing_brand: "Missing brand.",
  missing_name: "Missing Arabic or English product name.",
  missing_description: "Missing Arabic description.",
  name_too_long: "The GINI product name is longer than 255 characters.",
  description_too_long: "The GINI description is longer than 1000 words.",
  invalid_price: "GINI price must be a positive whole number of IQD.",
  price_needs_review: "The original IBSHER regular price is missing or ambiguous.",
  invalid_quantity: "Quantity must be a whole number of 0 or more.",
  missing_image: "At least one usable image is required.",
  invalid_image: "An image could not be downloaded as a valid GINI image file.",
  gini_variant_mapping_required: "This product has more than a single simple sellable variant.",
  connection_required: "Connect GINI API first.",
  categories_unavailable: "The live GINI category tree could not be read.",
  gini_lookup_failed: "The current GINI product list could not be read.",
  confirm_required: "Send requires an explicit confirmation after Preview.",
  preview_required: "Preview this product again before sending.",
  preview_expired: "This preview expired. Preview the product again.",
  preview_mismatch: "The preview does not match this product.",
  existing_gini_product_requires_update_flow:
    "This SKU already exists on GINI. Update is not part of this first create flow.",
  product_inactive: "Product is inactive",
  platform_inactive: "Platform is inactive",
  category_inactive: "Category is inactive",
  subcategory_inactive: "Subcategory is inactive",
  collection_inactive: "Collection is inactive",
  brand_inactive: "Brand is inactive",
  vendor_inactive: "Vendor is inactive",
  vendor_brand_inactive: "Vendor brand is inactive",
  taxonomy_config_missing: "Gini category/subcategory values are missing",
  confirmed_local_send: "This SKU already has a confirmed GINI product id.",
  confirmed_send_missing:
    "A confirmed GINI product id is saved for this SKU, but the current GINI API does not return it. The saved id was kept and no second create was sent.",
  confirmed_send_unverified:
    "A confirmed GINI product id is saved for this SKU, but GINI could not confirm it. It is not counted as currently existing. The saved id was kept and no second create was sent.",
  confirmed_send_id_mismatch:
    "GINI returned a different product id for this SKU than the saved confirmed id. The saved id was kept and no second create was sent.",
  confirmed_send_sku_mismatch:
    "The live GINI SKU does not match the SKU saved with the confirmed GINI id. No update was prepared.",
  confirmed_sku_mismatch:
    "The BrownStore SKU no longer matches the SKU saved with the confirmed GINI id. No update was prepared.",
  confirmed_hash_missing:
    "The confirmed send has no saved payload hash, so a local change cannot be determined.",
  historical_sku_unresolved:
    "This historical SKU is still unresolved, so it is not an update candidate.",
  local_payload_hash_differs:
    "The current BrownStore payload hash differs from the hash saved when this GINI product was confirmed. This is not proof that the GINI product changed.",
  local_payload_hash_matches:
    "The current BrownStore payload hash matches the hash saved when this GINI product was confirmed, and the live GINI id and SKU match.",
  not_in_approved_preview: "This product was not ready to create in the approved Full Preview.",
  historical_sku_hold:
    "This SKU is on the historical hold list. A verified absence does not authorize creating it again.",
  sku_identity_conflict: "The SKU and BrownStore product id do not identify the same product.",
  merchant_not_confirmed: "The stored GINI merchant does not match the verified production connection.",
  stale_preview: "The product changed after the preview. Preview this exact product again.",
  search_pagination_incomplete: "The GINI search did not finish, so the SKU is not confirmed missing.",
  duplicate_remote_sku: "GINI returned more than one product for this SKU.",
  sku_create_writes_disabled: "The SKU-scoped GINI create gates are off.",
  sync_one_writes_disabled: "The legacy Sync One send gates are off. The SKU create gates do not authorize this route.",
  sku_create_indexes_unavailable: "The SKU create lock indexes are missing. No create was sent.",
  existing_write_gates_must_stay_off: "The existing GINI write gates must stay off for this one-product create.",
  sku_create_uncertain: "The create response was lost or could not be confirmed. No second create was sent.",
  sku_create_in_progress: "A create for this SKU is already in progress.",
  confirmed_send_exists: "This product already has a confirmed GINI send.",
  expected_count_required: "This create accepts exactly one product.",
  product_not_found: "Product not found.",
  create_uncertain: "The create response was lost. No second create was sent.",
  gini_edge_blocked: "GINI edge blocked the request.",
  rate_limited: "GINI rate limited the request. No create was sent.",
  secret_unreadable: "The stored GINI secret cannot be read.",
  gini_access_forbidden: "GINI refused access.",
  gini_create_failed: "GINI did not create the product.",
};

export function blockerMessage(code) {
  return BLOCKER_TEXT[code] || code;
}

function integerOrNull(value, { min = 0 } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) return null;
  return number;
}

function numericId(value) {
  const text = String(value ?? "").trim();
  if (/^\d+$/.test(text)) return Number(text);
  return text;
}

/** Saved collection mapping checked against one already-loaded category tree. */
export function mappingFromTree(saved, categories) {
  const categoryId = String(saved?.categoryId || "").trim();
  const subcategoryId = String(saved?.subcategoryId || "").trim();
  const status = giniMappingStatus(saved || {}, categories);
  if (status === "missing") return { blockers: ["missing_mapping"], category: null, subcategory: null };
  if (status === "invalid") {
    return {
      blockers: ["invalid_mapping"],
      category: { id: numericId(categoryId), name: "" },
      subcategory: { id: numericId(subcategoryId), name: "" },
    };
  }
  if (status === "inactive") {
    const category = (categories || []).find((item) => String(item.id) === categoryId);
    const subcategory = category?.subcategories?.find((item) => String(item.id) === subcategoryId);
    return {
      blockers: ["inactive_mapping"],
      category: category
        ? { id: numericId(category.id), name: category.name }
        : { id: numericId(categoryId), name: "" },
      subcategory: subcategory
        ? { id: numericId(subcategory.id), name: subcategory.name }
        : { id: numericId(subcategoryId), name: "" },
    };
  }
  const category = (categories || []).find((item) => String(item.id) === categoryId);
  const subcategory = category.subcategories.find((item) => String(item.id) === subcategoryId);
  return {
    blockers: [],
    category: { id: numericId(category.id), name: category.name },
    subcategory: { id: numericId(subcategory.id), name: subcategory.name },
  };
}

export function giniPayloadHash(payload) {
  if (!payload || typeof payload !== "object") return "";
  const stable = {
    name: payload.name || "",
    description: payload.description || "",
    sku: payload.sku || "",
    price: payload.price,
    quantity: payload.quantity,
    security_stock: payload.security_stock,
    category_id: payload.category_id,
    subcategory_id: payload.subcategory_id,
    is_visible: payload.is_visible,
    images: (payload.images || []).map((image) => (typeof image === "string" ? image : image?.url || "")),
  };
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * Pure GINI create plan. Callers load the product, price rules, mapping, and SKU lookup.
 * Passing `existing: null` means the SKU was not looked up.
 */
export function buildGiniPlanFromParts({
  doc,
  resolved,
  priced,
  duplicateProductIds = [],
  mapping,
  existing = null,
}) {
  const sku = normalizeGiniItemCode(doc?.itemCode);
  const text = giniCatalogText(resolved);
  const simple = assessSimpleProduct({
    ...resolved,
    itemCode: doc?.itemCode,
    sellingPrice: priced?.storePrice,
  });
  const imageUrls = listGiniImageUrls(resolved);
  const plannedImages = imageUrls.slice(0, GINI_IMAGE_LIMIT);
  const blockers = [];
  const owners = Array.isArray(duplicateProductIds) ? duplicateProductIds.map(String) : [];
  if (!sku) blockers.push("missing_sku");
  if (sku && (owners.length !== 1 || !owners.includes(String(doc?._id)))) {
    blockers.push("duplicate_brownstore_sku");
  }
  blockers.push(...simple.blockers);
  if (!text.brand) blockers.push("missing_brand");
  if (!text.nameAr || !text.nameEn) blockers.push("missing_name");
  if (!text.description) blockers.push("missing_description");
  if (text.name && text.name.length > GINI_NAME_MAX) blockers.push("name_too_long");
  if (text.description && wordCount(text.description) > GINI_DESCRIPTION_MAX_WORDS) {
    blockers.push("description_too_long");
  }
  const giniPrice = priced?.priceReview ? null : integerOrNull(priced?.price, { min: 1 });
  const quantity = integerOrNull(resolved?.stock, { min: 0 });
  if (priced?.priceReview) blockers.push("price_needs_review");
  else if (giniPrice == null) blockers.push("invalid_price");
  if (quantity == null) blockers.push("invalid_quantity");
  if (!plannedImages.length) blockers.push("missing_image");
  if (plannedImages.some((url) => !isAllowedMediaUrl(url))) blockers.push("invalid_image");
  blockers.push(...(mapping?.blockers || []));
  if (existing?.error) blockers.push("gini_lookup_failed");
  else if (existing?.exists) blockers.push("existing_gini_product");

  const decision = decideSyncAction(blockers);
  const warnings = [];
  if (imageUrls.length > GINI_IMAGE_LIMIT) warnings.push("Only the first 10 images will be sent.");
  if (resolved?.outOfStock === true) warnings.push("BrownStore marks this product out of stock.");
  if (simple.simple) {
    warnings.push("GINI mode: SIMPLE_PRODUCT");
    warnings.push("BrownStore variants collapsed: 1");
  }
  if (decision.action === "UPDATE_AVAILABLE") {
    warnings.push("This SKU already exists on GINI. The future action would be UPDATE. Send stays blocked.");
  }
  const category = mapping?.category || null;
  const subcategory = mapping?.subcategory || null;
  const isVisible = resolved?.isActive === false ? 0 : 1;
  const payloadPreview = buildSimplePayloadPreview({
    text,
    sku,
    price: giniPrice,
    quantity,
    securityStock: GINI_SAFETY_STOCK,
    category,
    subcategory,
    isVisible,
    imageUrls: plannedImages,
  });
  const lookupState = !existing ? "skipped" : existing.error ? "error" : existing.exists ? "exists" : "absent";
  return {
    productId: String(doc?._id || ""),
    sku,
    action: decision.action,
    canSend: decision.canSend,
    giniMode: simple.giniMode,
    brownStoreVariantsCollapsed: simple.brownStoreVariantsCollapsed,
    variantCount: simple.variantCount,
    brownStorePrice: priced?.priceReview ? null : priced?.storePrice,
    commissionRate: priced?.rate,
    giniPrice: priced?.priceReview ? null : giniPrice,
    priceReview: Boolean(priced?.priceReview),
    priceReviewReason: priced?.priceReviewReason || "",
    quantity,
    category,
    subcategory,
    imageCount: plannedImages.length,
    payloadPreview,
    warnings,
    blockers: decision.blockers,
    blockerMessages: decision.blockers.map(blockerMessage),
    duplicateProductIds: blockers.includes("duplicate_brownstore_sku") ? owners : [],
    existingGiniProductId: existing?.giniProductId || "",
    collectionId: productScopeIds(doc).collection,
    lookupState,
  };
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

/**
 * Bulk classification. Uncertain SKU lookups never become READY_CREATE.
 * Platform eligibility is applied by the caller through `eligibility` and `isActive`.
 */
export function classifyGiniBulk({ plan, isActive = true, eligibility = null, localSend = null }) {
  const planCodes = [...(plan?.blockers || [])];
  const reasons = Array.isArray(eligibility?.reasons) ? eligibility.reasons : [];
  const inactiveByRule = reasons.some((reason) => reason.code !== "taxonomy_config_missing");
  const inactive = isActive === false || inactiveByRule;
  if (inactive) {
    const codes = [];
    const messages = [];
    if (isActive === false) {
      codes.push("product_inactive");
      messages.push(blockerMessage("product_inactive"));
    }
    for (const reason of reasons) {
      if (reason.code === "taxonomy_config_missing") continue;
      codes.push(reason.code);
      messages.push(reason.message || blockerMessage(reason.code));
    }
    return pack("INACTIVE", [...codes, ...planCodes], messages, plan, null);
  }
  if (localSend?.giniProductId) {
    return pack(
      "ALREADY_EXISTS",
      ["confirmed_local_send"],
      [blockerMessage("confirmed_local_send")],
      plan,
      localSend
    );
  }
  if (planCodes.includes("existing_gini_product")) {
    return pack("ALREADY_EXISTS", planCodes, planCodes.map(blockerMessage), plan, null);
  }
  if (isGiniHistoricalHoldSku(plan?.sku)) {
    const codes = unique(["historical_sku_hold", ...planCodes]);
    return pack("BLOCKED", codes, codes.map(blockerMessage), plan, null);
  }
  if (planCodes.includes("gini_lookup_failed") || plan?.lookupState === "error") {
    const codes = planCodes.includes("gini_lookup_failed") ? planCodes : ["gini_lookup_failed", ...planCodes];
    return pack("LOOKUP_UNCERTAIN", codes, codes.map(blockerMessage), plan, null);
  }
  if (planCodes.length === 1 && planCodes[0] === "price_needs_review") {
    return pack("NEEDS_REVIEW", planCodes, planCodes.map(blockerMessage), plan, null);
  }
  if (planCodes.length) return pack("BLOCKED", planCodes, planCodes.map(blockerMessage), plan, null);
  if (plan?.lookupState !== "absent") {
    return pack("LOOKUP_UNCERTAIN", ["gini_lookup_failed"], [blockerMessage("gini_lookup_failed")], plan, null);
  }
  return pack("READY_CREATE", [], [], plan, null);
}

/**
 * A saved send id is duplicate protection, not proof the SKU is currently on GINI.
 * Missing or unreadable remote products stay out of the create set and keep the saved id.
 */
export function classifyConfirmedSend({ plan, localSend, found }) {
  const storedId = String(localSend?.giniProductId || "");
  const liveId = found?.giniProductId == null ? "" : String(found.giniProductId);
  if (found?.exists && liveId && liveId === storedId) {
    return pack(
      "ALREADY_EXISTS",
      ["confirmed_local_send"],
      [blockerMessage("confirmed_local_send")],
      plan,
      localSend
    );
  }
  if (found?.exists && liveId) {
    return pack(
      "RECONCILE",
      ["confirmed_send_id_mismatch"],
      [blockerMessage("confirmed_send_id_mismatch")],
      plan,
      localSend
    );
  }
  if (found?.error || found?.exists !== false) {
    return pack(
      "RECONCILE",
      ["confirmed_send_unverified"],
      [blockerMessage("confirmed_send_unverified")],
      plan,
      localSend
    );
  }
  return pack(
    "RECONCILE",
    ["confirmed_send_missing"],
    [blockerMessage("confirmed_send_missing")],
    plan,
    localSend
  );
}

export const GINI_UNRESOLVED_HISTORICAL_SKUS = Object.freeze(["LP-ID141232", "E6310221"]);

export function isUnresolvedHistoricalGiniSku(sku) {
  const key = giniSkuKey(sku);
  if (!key) return false;
  return GINI_UNRESOLVED_HISTORICAL_SKUS.some((item) => giniSkuKey(item) === key);
}

function changedPreviewIdentity({ savedSku, savedGiniProductId, found }) {
  const storedId = String(savedGiniProductId || "");
  const savedKey = giniSkuKey(savedSku);
  if (!storedId || !savedKey) return { state: "uncertain", code: "confirmed_send_unverified" };
  if (!found || found.error || (found.exists !== true && found.exists !== false)) {
    return { state: "uncertain", code: "confirmed_send_unverified" };
  }
  if (found.exists === false) return { state: "missing", code: "confirmed_send_missing" };
  const liveId = found.giniProductId == null ? "" : String(found.giniProductId);
  const liveKey = giniSkuKey(found.sku);
  if (!liveId || !liveKey) return { state: "uncertain", code: "confirmed_send_unverified" };
  if (liveKey !== savedKey) return { state: "mismatch", code: "confirmed_send_sku_mismatch", liveId };
  if (liveId !== storedId) return { state: "mismatch", code: "confirmed_send_id_mismatch", liveId };
  return { state: "match", code: "", liveId };
}

/**
 * Read-only classification for one confirmed GINI send.
 * A hash difference is a BrownStore payload difference. It is not evidence that GINI changed the remote product.
 */
export function classifyGiniChangedPreview({
  savedSku = "",
  savedGiniProductId = "",
  savedHash = "",
  currentSku = "",
  currentHash = "",
  planBlockers = [],
  inactive = false,
  inactiveReasons = [],
  productFound = false,
  found = null,
} = {}) {
  const identity = changedPreviewIdentity({ savedSku, savedGiniProductId, found });
  if (identity.state !== "match") {
    return {
      classification: "RECONCILIATION_NEEDED",
      code: identity.code,
      blockers: [identity.code],
      reason: blockerMessage(identity.code),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  if (!productFound) {
    return {
      classification: "BLOCKED",
      code: "product_not_found",
      blockers: ["product_not_found"],
      reason: blockerMessage("product_not_found"),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  const savedKey = giniSkuKey(savedSku);
  const currentKey = giniSkuKey(currentSku);
  if (!currentKey || currentKey !== savedKey) {
    return {
      classification: "RECONCILIATION_NEEDED",
      code: "confirmed_sku_mismatch",
      blockers: ["confirmed_sku_mismatch"],
      reason: blockerMessage("confirmed_sku_mismatch"),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  if (inactive) {
    const codes = unique(inactiveReasons.length ? inactiveReasons : ["product_inactive"]);
    return {
      classification: "BLOCKED",
      code: codes[0],
      blockers: codes,
      reason: codes.map(blockerMessage).join("; ").slice(0, 400),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  const blockers = unique((planBlockers || []).filter((code) => code && code !== "existing_gini_product"));
  if (blockers.length) {
    return {
      classification: "BLOCKED",
      code: blockers[0],
      blockers,
      reason: blockers.map(blockerMessage).join("; ").slice(0, 400),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  const previous = String(savedHash || "");
  const current = String(currentHash || "");
  if (!previous || !current) {
    return {
      classification: "RECONCILIATION_NEEDED",
      code: "confirmed_hash_missing",
      blockers: ["confirmed_hash_missing"],
      reason: blockerMessage("confirmed_hash_missing"),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  if (previous !== current) {
    if (isUnresolvedHistoricalGiniSku(savedSku) || isUnresolvedHistoricalGiniSku(currentSku)) {
      return {
        classification: "RECONCILIATION_NEEDED",
        code: "historical_sku_unresolved",
        blockers: ["historical_sku_unresolved"],
        reason: blockerMessage("historical_sku_unresolved"),
        liveGiniProductId: identity.liveId || "",
        provesRemoteChange: false,
      };
    }
    return {
      classification: "CHANGED",
      code: "local_payload_hash_differs",
      blockers: [],
      reason: blockerMessage("local_payload_hash_differs"),
      liveGiniProductId: identity.liveId || "",
      provesRemoteChange: false,
    };
  }
  return {
    classification: "UNCHANGED",
    code: "local_payload_hash_matches",
    blockers: [],
    reason: blockerMessage("local_payload_hash_matches"),
    liveGiniProductId: identity.liveId || "",
    provesRemoteChange: false,
  };
}

const COMPARABLE_CHANGED_FIELDS = ["price", "quantity", "imageCount"];

/** Field diffs only when both sides were stored as numbers. Missing history is not treated as a change. */
export function giniChangedFieldDiffs(savedFields, currentFields) {
  if (!savedFields || !currentFields) return [];
  const diffs = [];
  for (const field of COMPARABLE_CHANGED_FIELDS) {
    const oldValue = savedFields[field];
    const newValue = currentFields[field];
    if (oldValue == null || newValue == null) continue;
    const previous = Number(oldValue);
    const next = Number(newValue);
    if (!Number.isFinite(previous) || !Number.isFinite(next) || previous === next) continue;
    diffs.push({ field, old: previous, new: next });
  }
  return diffs;
}

function pack(classification, codes, messages, plan, localSend) {
  const blockers = unique(codes);
  const giniProductId =
    classification === "READY_CREATE" ? "" : String(localSend?.giniProductId || plan?.existingGiniProductId || "");
  return {
    classification,
    blockers,
    reason: unique(messages).join("; ").slice(0, 400),
    errorCode: blockers[0] || "",
    sku: plan?.sku || "",
    skuKey: giniSkuKey(plan?.sku || ""),
    giniProductId,
    giniPrice: plan?.giniPrice ?? null,
    quantity: plan?.quantity ?? null,
    imageCount: plan?.imageCount || 0,
    payloadHash: giniPayloadHash(plan?.payloadPreview),
    payloadPreview: plan?.payloadPreview || null,
    existingGiniProductId: plan?.existingGiniProductId || "",
  };
}
