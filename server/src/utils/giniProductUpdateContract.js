import crypto from "crypto";
import { giniPayloadHash } from "./giniSyncEvaluate.js";
import { GINI_PRODUCTS_PATH, normalizeGiniItemCode } from "./giniSyncOnePlan.js";

/**
 * Verified from the GINI Merchant API product docs and the official
 * "Gini API v2 - Third Party" Postman collection:
 * PUT /api/v2.0/third-party/products/{sku} is a partial JSON update.
 * Every documented field is optional. {sku} resolves a SKU or a numeric id.
 * JSON requests sign METHOD + PATH + the exact raw body + TIMESTAMP.
 * Price and quantity stay on a signed JSON PUT.
 * One image replacement is a separate multipart POST signed with an empty body:
 * _method=PUT, delete_images[] is the exact live image URL, and images[] is one file.
 * Success for a field update is HTTP 200 with data.id and data.sku. There is no Idempotency-Key.
 */
export const GINI_PRODUCT_UPDATE_METHOD = "PUT";
export const GINI_PRODUCT_UPDATE_CONTENT_TYPE = "application/json";
export const GINI_CHANGED_PREVIEW_TTL_MS = 30 * 60 * 1000;
export const GINI_PUT_DOCUMENTED_FIELDS = Object.freeze([
  "name",
  "sku",
  "description",
  "price",
  "security_stock",
  "quantity",
  "category_id",
  "subcategory_id",
  "is_visible",
  "is_installments",
  "months",
  "is_gini_partner",
  "tags",
  "options",
  "images",
  "delete_images",
]);
export const GINI_CHANGED_SYNC_FIELDS = Object.freeze(["price", "quantity"]);
export const GINI_IMAGE_LIMIT = 10;
export const GINI_IMAGE_REPLACEMENT_METHOD = "POST";
export const GINI_IMAGE_FORM_METHOD = "PUT";

export function giniImageWritesEnabled() {
  return process.env.GINI_IMAGE_WRITES_ENABLED === "true" && process.env.GINI_ALLOW_LIVE_IMAGE_WRITES === "true";
}

export function giniProductUpdatePath(sku) {
  const normalized = normalizeGiniItemCode(sku);
  return `${GINI_PRODUCTS_PATH}/${encodeURIComponent(normalized)}`;
}

export function giniPartialUpdateBody(changes) {
  const ordered = {};
  for (const field of GINI_CHANGED_SYNC_FIELDS) {
    const change = (changes || []).find((item) => item?.field === field);
    if (!change) continue;
    ordered[field] = Number(change.new);
  }
  return JSON.stringify(ordered);
}

export function giniPartialUpdateKeys(rawBody) {
  const parsed = JSON.parse(rawBody);
  return Object.keys(parsed);
}

/**
 * Price and quantity eligibility is field-level.
 * The full payload hash advances only when restoring those two fields reproduces
 * the confirmed hash. A price or quantity difference beside an image change, or
 * any other unsynced field, can still be sent alone. confirmFullHash stays false
 * so the stored hash cannot hide the remaining difference.
 */
export function explainGiniPriceQuantityChange({ savedHash, currentPayload, savedPrice, savedQuantity } = {}) {
  const currentHash = giniPayloadHash(currentPayload);
  const previousHash = String(savedHash || "");
  const empty = { ok: false, changes: [], currentHash, nextHash: "", confirmFullHash: false, previousHash };
  if (!currentHash || !previousHash) {
    return { ...empty, code: "confirmed_hash_missing" };
  }
  if (savedPrice == null || savedQuantity == null) {
    return { ...empty, code: "confirmed_fields_missing" };
  }
  const oldPrice = Number(savedPrice);
  const oldQuantity = Number(savedQuantity);
  if (!Number.isInteger(oldPrice) || !Number.isInteger(oldQuantity) || oldQuantity < 0) {
    return { ...empty, code: "confirmed_fields_missing" };
  }
  const nextPrice = Number(currentPayload?.price);
  const nextQuantity = Number(currentPayload?.quantity);
  const priceValid = Number.isInteger(nextPrice) && nextPrice >= 1;
  const quantityValid = Number.isInteger(nextQuantity) && nextQuantity >= 0;
  const restored = { ...currentPayload, price: oldPrice, quantity: oldQuantity };
  const hashExplained = giniPayloadHash(restored) === previousHash;
  if (!priceValid) return { ...empty, code: hashExplained ? "invalid_price" : "unsupported_field_change" };
  if (!quantityValid) return { ...empty, code: hashExplained ? "invalid_quantity" : "unsupported_field_change" };
  const changes = [];
  if (nextPrice !== oldPrice) changes.push({ field: "price", old: oldPrice, new: nextPrice });
  if (nextQuantity !== oldQuantity) changes.push({ field: "quantity", old: oldQuantity, new: nextQuantity });
  if (!hashExplained && !changes.length) return { ...empty, code: "unsupported_field_change" };
  if (!changes.length) return { ...empty, code: "unchanged", nextHash: currentHash };
  return {
    ok: true,
    code: hashExplained ? "" : "unsynced_fields_remain",
    changes,
    currentHash,
    nextHash: hashExplained ? currentHash : "",
    previousHash,
    confirmFullHash: hashExplained,
  };
}

export function sameUpdateChanges(left, right) {
  const normalize = (changes) =>
    GINI_CHANGED_SYNC_FIELDS.map((field) => (changes || []).find((item) => item?.field === field))
      .filter(Boolean)
      .map((item) => ({ field: item.field, old: Number(item.old), new: Number(item.new) }));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

export function giniChangedPreviewSignature(rows) {
  const stable = [...(rows || [])]
    .map((row) => ({
      sku: String(row?.sku || ""),
      classification: String(row?.classification || ""),
      giniProductId: String(row?.giniProductId || ""),
      savedHash: String(row?.savedHash || ""),
      currentHash: String(row?.currentHash || ""),
      updateEligible: row?.updateEligible === true,
      updateChanges: (row?.updateChanges || []).map((change) => ({
        field: change.field,
        old: Number(change.old),
        new: Number(change.new),
      })),
    }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  return crypto.createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function storedImageCount(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) return null;
  return number;
}

function imageUrlList(values) {
  if (!Array.isArray(values)) return null;
  return values
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (item && typeof item === "object") return String(item.url || "").trim();
      return "";
    })
    .filter(Boolean);
}

function fingerprintMap(urls, fingerprints) {
  if (!Array.isArray(fingerprints) || fingerprints.length !== urls.length) return null;
  const mapped = new Map();
  for (let index = 0; index < urls.length; index += 1) {
    const fingerprint = String(fingerprints[index] || "").trim();
    if (!fingerprint) return null;
    mapped.set(urls[index], fingerprint);
  }
  return mapped;
}

function countUrls(urls) {
  const counts = new Map();
  for (const url of urls) counts.set(url, (counts.get(url) || 0) + 1);
  return counts;
}

/**
 * Image diff for Changed Preview.
 * A missing saved URL list or fingerprint is reported as unverified.
 * A matching URL is not treated as proof that the file bytes are unchanged.
 * Image count never creates a one-to-one replacement pair.
 */
export function assessGiniImageChange({
  savedImageCount = null,
  currentImageUrls = [],
  savedImageUrls = null,
  savedContentFingerprints = null,
  currentContentFingerprints = null,
  hashExplainedByPriceQuantity = false,
  remoteImageUrls = null,
  liveImageUrls = null,
} = {}) {
  const currentImages = imageUrlList(currentImageUrls) || [];
  const savedImages = imageUrlList(savedImageUrls);
  const savedCount = storedImageCount(savedImageCount);
  const remoteConflict = Array.isArray(remoteImageUrls);
  const liveImages = imageUrlList(liveImageUrls);
  const base = {
    imageWriteSupported: false,
    imagePairInferred: false,
    historicalImageBaseline: Boolean(savedImages),
    byteChangesDetectable: false,
    orderSupported: false,
    contentVerified: false,
    contentFingerprinted: false,
    remoteConflict,
    remoteImages: liveImages || [],
    previousImages: [],
    currentImages,
    added: [],
    removed: [],
    replaced: [],
    orderChanged: false,
    savedImageCount: savedCount,
    currentImageCount: currentImages.length,
  };
  if (!savedImages) {
    const countChanged = savedCount != null && savedCount !== currentImages.length;
    let status = "baseline_missing";
    if (savedCount != null && countChanged) status = "count_changed_unverified";
    else if (savedCount != null && hashExplainedByPriceQuantity) status = "urls_match_content_unverified";
    else if (savedCount != null) status = "unattributed_unverified";
    const selectionRequired = status !== "urls_match_content_unverified";
    return {
      ...base,
      status,
      selectionRequired,
      verificationNeeded: selectionRequired || remoteConflict,
    };
  }
  const savedPrints = fingerprintMap(savedImages, savedContentFingerprints);
  const currentPrints = fingerprintMap(currentImages, currentContentFingerprints);
  const contentFingerprinted = Boolean(savedPrints && currentPrints);
  const savedCounts = countUrls(savedImages);
  const currentCounts = countUrls(currentImages);
  const added = [];
  const removed = [];
  for (const [url, count] of currentCounts) {
    const extra = count - (savedCounts.get(url) || 0);
    for (let index = 0; index < extra; index += 1) added.push(url);
  }
  for (const [url, count] of savedCounts) {
    const extra = count - (currentCounts.get(url) || 0);
    for (let index = 0; index < extra; index += 1) removed.push(url);
  }
  const replaced = [];
  if (contentFingerprinted) {
    for (const url of savedPrints.keys()) {
      if (!currentPrints.has(url) || savedPrints.get(url) === currentPrints.get(url)) continue;
      replaced.push({
        url,
        previousFingerprint: savedPrints.get(url),
        nextFingerprint: currentPrints.get(url),
      });
    }
  }
  const orderChanged = added.length === 0 && removed.length === 0 && savedImages.join("\n") !== currentImages.join("\n");
  let status = "unchanged_urls";
  if (added.length && removed.length) status = "replaced_urls";
  else if (added.length) status = "added";
  else if (removed.length) status = "removed";
  else if (replaced.length) status = "content_changed";
  else if (orderChanged) status = "order_changed";
  else if (!contentFingerprinted) status = "urls_match_content_unverified";
  const contentVerified = contentFingerprinted && status === "unchanged_urls";
  const selectionRequired = status === "added" || status === "removed" || status === "replaced_urls" || status === "content_changed";
  return {
    ...base,
    byteChangesDetectable: contentFingerprinted,
    status,
    selectionRequired,
    verificationNeeded: remoteConflict || selectionRequired,
    contentFingerprinted,
    contentVerified,
    previousImages: savedImages,
    added,
    removed,
    replaced,
    orderChanged,
  };
}

/**
 * An image replacement may be sent only when the confirmed price and quantity
 * still match. Those fields can be confirmed by their own JSON PUT without
 * moving the full payload hash. The full hash may advance only when a stored
 * image list proves that images are the only remaining difference. A missing
 * historical image list does not block an operator-selected replacement, and it
 * does not confirm the rest of the payload. Image count never chooses the pair.
 */
export function giniImageReplacementIsolation({
  savedHash,
  currentPayload,
  savedPrice,
  savedQuantity,
  savedImageUrls = null,
} = {}) {
  const currentHash = giniPayloadHash(currentPayload);
  const previousHash = String(savedHash || "");
  const oldPrice = Number(savedPrice);
  const oldQuantity = Number(savedQuantity);
  if (!currentHash || !previousHash || !Number.isInteger(oldPrice) || !Number.isInteger(oldQuantity) || oldQuantity < 0) {
    return { ok: false, block: true, confirmHash: false, code: "confirmed_fields_missing", currentHash, nextHash: "" };
  }
  if (Number(currentPayload?.price) !== oldPrice || Number(currentPayload?.quantity) !== oldQuantity) {
    return { ok: false, block: true, confirmHash: false, code: "unrelated_field_unsynced", currentHash, nextHash: "" };
  }
  const savedImages = imageUrlList(savedImageUrls);
  if (savedImages) {
    const restored = {
      ...currentPayload,
      price: oldPrice,
      quantity: oldQuantity,
      images: savedImages.map((url) => ({ url })),
    };
    if (giniPayloadHash(restored) !== previousHash) {
      return { ok: false, block: true, confirmHash: false, code: "unrelated_field_unsynced", currentHash, nextHash: "" };
    }
    if (currentHash === previousHash) {
      return { ok: false, block: true, confirmHash: false, code: "image_payload_unchanged", currentHash, nextHash: "" };
    }
    return { ok: true, block: false, confirmHash: true, code: "", currentHash, nextHash: currentHash };
  }
  if (currentHash === previousHash) {
    return { ok: false, block: true, confirmHash: false, code: "image_payload_unchanged", currentHash, nextHash: "" };
  }
  return { ok: true, block: false, confirmHash: false, code: "image_hash_not_isolated", currentHash, nextHash: "" };
}

export function classifyGiniImageReplacement({ previousImages, deleteUrl, liveImages } = {}) {
  const previous = imageUrlList(previousImages) || [];
  const live = imageUrlList(liveImages) || [];
  const target = String(deleteUrl || "").trim();
  const sameList = previous.join("\n") === live.join("\n");
  if (sameList) return { state: "not_applied", addedUrl: "" };
  const removed = previous.filter((url) => !live.includes(url));
  const added = live.filter((url) => !previous.includes(url));
  const othersKept = previous.filter((url) => url !== target).every((url) => live.includes(url));
  if (
    target &&
    !live.includes(target) &&
    othersKept &&
    removed.length === 1 &&
    removed[0] === target &&
    added.length === 1 &&
    live.length === previous.length &&
    live.length <= GINI_IMAGE_LIMIT
  ) {
    return { state: "verified", addedUrl: added[0] };
  }
  if (target && !live.includes(target) && othersKept && added.length === 0 && live.length === previous.length - 1) {
    return { state: "pending_verification", addedUrl: "" };
  }
  return { state: "uncertain", addedUrl: "" };
}
