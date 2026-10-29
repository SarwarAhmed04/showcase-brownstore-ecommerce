import { Commission } from "../models/Commission.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility } from "../utils/platformEligibility.js";
import { miswagIsLargeFlag } from "../utils/platformTaxonomyFields.js";
import { loadEligibilityContext } from "../utils/platformTaxonomy.js";
import { cdnUrl, toResolvedProduct } from "../utils/productView.js";
import {
  MiswagError,
  assertMiswagSyncAllowed,
  createOrUpdateItem,
  getItem,
  logMiswagSafe,
  sanitizeMiswagText,
} from "./miswag.js";
import {
  loadMiswagCategoryMappingMap,
  resolveMiswagCollectionIsLarge,
} from "./miswagCategoryMapping.js";
import { ensureProductVariationBarcodes } from "./miswagTestBarcodes.js";
import { saveMiswagAcceptedPayload } from "./miswagSyncState.js";
import { resolveMiswagBrandForProduct, createBrandResolverCache } from "./miswagBrandResolve.js";

export const MISWAG_ITEM_CREATE_PATH = "/v1/items/bulk-create";
export const MISWAG_CATEGORY_ID_RX = /^L[34]-\d+$/;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif"]);
const PRINTABLE = /[^\x20-\x7E]/g;
const HIGHLIGHT_MAX = 160;
const HEX_ONLY = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function mediaPublicOrigin() {
  return String(process.env.MEDIA_PUBLIC_ORIGIN || "").trim().replace(/\/$/, "");
}

function printable(value, max = 0) {
  const text = String(value || "").replace(PRINTABLE, "").trim();
  if (!text) return "";
  return max ? text.slice(0, max) : text;
}

function plainText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localized(value, order = ["en", "ar", "ku"]) {
  if (!value) return "";
  if (typeof value === "string") return plainText(value);
  for (const key of order) {
    const text = plainText(value[key]);
    if (text) return text;
  }
  return "";
}

/**
 * Read the original BrownStore variation color name as-is.
 * Prefer English text. Never invent names, never use HEX as a name,
 * and never split multi-color labels (e.g. "Black + White").
 */
export function resolveMiswagColor(variant) {
  const candidates = [];

  function pushCandidate(value) {
    if (value == null) return;
    if (typeof value === "string" || typeof value === "number") {
      const text = plainText(value);
      if (!text || HEX_ONLY.test(text)) return;
      candidates.push(text);
      return;
    }
    if (typeof value !== "object") return;
    // Prefer English first so multi-color English labels stay intact.
    if (value.name && typeof value.name === "object") {
      pushCandidate(value.name.en);
      pushCandidate(value.name.ar);
      pushCandidate(value.name.ku);
    } else {
      pushCandidate(value.name);
    }
    pushCandidate(value.en);
    pushCandidate(value.label);
    // Intentionally ignore hex / value / colorHex — those are not color names.
  }

  pushCandidate(variant?.color);
  pushCandidate(variant?.colour);
  pushCandidate(variant?.colorName);

  const name = candidates.find((text) => text.length > 0) || "";
  if (!name) return null;
  return { name };
}

function publicImageUrl(url, origin) {
  const raw = String(url || "").trim();
  if (!raw || raw.startsWith("data:")) return "";
  const local = cdnUrl(raw);
  // Miswag requires absolute HTTPS media URLs.
  if (/^https:\/\//i.test(local)) return local;
  if (/^http:\/\//i.test(local)) return "";
  if (!origin || !local.startsWith("/")) return "";
  const absolute = `${origin}${local}`;
  return /^https:\/\//i.test(absolute) ? absolute : "";
}

function imageExtension(url) {
  const raw = String(url || "");
  let pathname = raw.split("?")[0].split("#")[0];
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // relative URL
  }
  const match = pathname.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : "";
}

function variationImages(images, origin) {
  const urls = [];
  let primary = "";
  for (const image of images || []) {
    const source = typeof image === "string" ? image : image?.url;
    const url = publicImageUrl(source, origin);
    if (!url || urls.includes(url)) continue;
    urls.push(url);
    if (!primary && image && typeof image === "object" && (image.isMain || image.primary)) primary = url;
  }
  if (!urls.length) return [];
  if (!primary || !urls.includes(primary)) primary = urls[0];
  return urls.map((url) => ({ url, primary: url === primary }));
}

function keywordTokens(...values) {
  const words = [];
  for (const value of values) {
    for (const token of plainText(value).split(/[^\p{L}\p{N}]+/u)) {
      const word = token.trim();
      if (word.length >= 3) words.push(word);
    }
  }
  const unique = [];
  const seen = new Set();
  for (const word of words) {
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(word);
    if (unique.length >= 12) break;
  }
  return unique;
}

function clipAtWord(value, max) {
  const text = plainText(value);
  if (text.length <= max) return text;
  const boundary = text.lastIndexOf(" ", max);
  if (boundary >= 3) return text.slice(0, boundary).trim();
  return "";
}

function entityName(entity) {
  return localized(entity?.name);
}

function storedBarcode(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["barcode", "barCode", "ean", "upc", "gtin"]) {
    const text = String(value[key] ?? "").trim();
    if (!text || text.length > 100 || /[^\x20-\x7E]/.test(text)) continue;
    return text;
  }
  return "";
}

export function miswagItemExternalId(product) {
  return `bs-${String(product?.ibsherId || "").trim()}`;
}

export function miswagVariationExternalId(variant) {
  const variantId = String(variant?._id || variant?.id || "").trim();
  if (!variantId) return "";
  const externalId = printable(`bs-var-${variantId}`, 100);
  return externalId.startsWith("bs-var-") ? externalId : "";
}

function reasonLabel(code) {
  const map = {
    missing_product: "Product not found",
    invalid_external_id: "Invalid Miswag external_id (needs IBSHER id)",
    invalid_price: "Invalid price",
    inactive: "Product is inactive",
    missing_name: "Missing English product name",
    missing_arabic_name_for_highlight: "Missing Arabic name (required for highlight)",
    missing_arabic_description: "Missing Arabic description",
    missing_keywords: "Missing keywords",
    missing_category_id: "Missing required Miswag category ID",
    invalid_category: "Invalid Miswag category ID (expected L3-… or L4-…)",
    missing_brand_id: "Missing required Miswag brand ID",
    invalid_brand_id: "Invalid Miswag brand ID",
    missing_public_origin: "MEDIA_PUBLIC_ORIGIN is not set (needed for image URLs)",
    missing_variations: "Missing variants",
    missing_variant_id: "Missing variant id",
    missing_color_value: "Missing variant color name",
    missing_color_name: "Missing variant color name",
    missing_images: "Missing image",
    missing_sizes: "Missing variant sizes",
    missing_size_label: "Missing size label",
    duplicate_size: "Duplicate size external_id",
    missing_variation_barcode: "Missing variation barcode",
    missing_sku: "Missing SKU / item code",
    platform_blocked: "Blocked by Miswag platform visibility rules",
    connection_required: "Miswag connection is not Connected",
    not_exactly_one: "Exactly one product must be selected",
  };
  return map[code] || code;
}

function validateCategoryId(raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: false, code: "missing_category_id" };
  if (!MISWAG_CATEGORY_ID_RX.test(value)) return { ok: false, code: "invalid_category" };
  return { ok: true, categoryId: value };
}

function validateBrandId(raw) {
  const brandId = Number(raw);
  if (raw == null || String(raw).trim() === "") return { ok: false, code: "missing_brand_id" };
  if (!Number.isInteger(brandId) || brandId <= 0) return { ok: false, code: "invalid_brand_id" };
  return { ok: true, brandId };
}

/**
 * Build Miswag item payload from BrownStore product + temporary Miswag IDs.
 * Field names come from the prior Miswag seller client (POST /v1/items/bulk-create).
 */
export function buildMiswagTestPayload(
  doc,
  {
    rules = [],
    categoryId = "",
    brandId = "",
    brandName = "",
    isLarge = false,
    origin = mediaPublicOrigin(),
    barcodeAssignments = null,
  } = {}
) {
  const resolved = toResolvedProduct(doc);
  const errors = [];
  const warnings = [];
  if (!resolved) {
    return { ok: false, errors: ["missing_product"], warnings, payload: null };
  }

  const pricing = partnerPricePreview(doc, rules);
  const rawAfterCommission = (() => {
    const storePrice = Number(pricing.storePrice) || 0;
    const rate = Number(pricing.rate) || 0;
    return Math.max(0, storePrice * (1 + rate / 100));
  })();
  const price = Math.round(Number(pricing.price));
  const externalId = miswagItemExternalId(resolved);
  if (!/^[\x20-\x7E]+$/.test(externalId) || externalId === "bs-") errors.push("invalid_external_id");
  if (!Number.isFinite(price) || price < 0) errors.push("invalid_price");
  if (resolved.isActive === false) errors.push("inactive");

  const nameEn = localized(resolved.name, ["en", "ku", "ar"]);
  if (nameEn.length < 3) errors.push("missing_name");
  const nameAr = localized(resolved.name, ["ar"]);
  const highlight = nameAr.length >= 3 ? clipAtWord(nameAr, HIGHLIGHT_MAX) : "";
  if (highlight.length < 3) errors.push("missing_arabic_name_for_highlight");

  const description = localized(resolved.description, ["ar"]);
  if (description.length < 3) errors.push("missing_arabic_description");

  const keywords = keywordTokens(
    ...(Array.isArray(resolved.keyword) ? resolved.keyword : []),
    nameEn,
    entityName(resolved.collectionName),
    entityName(resolved.subCategory),
    entityName(resolved.brand)
  );
  if (!keywords.length) errors.push("missing_keywords");

  const categoryCheck = validateCategoryId(categoryId);
  if (!categoryCheck.ok) errors.push(categoryCheck.code);

  const brandCheck = validateBrandId(brandId);
  if (!brandCheck.ok) errors.push(brandCheck.code);

  const code = printable(resolved.itemCode || resolved.sku, 80);
  if (!code) errors.push("missing_sku");

  if (!origin) errors.push("missing_public_origin");

  const variations = [];
  const variants = Array.isArray(resolved.variants) ? resolved.variants : [];
  if (!variants.length) errors.push("missing_variations");

  const previewImages = [];
  let totalStock = 0;

  for (const variant of variants) {
    const variantId = String(variant?._id || variant?.id || "").trim();
    if (!variantId) {
      errors.push("missing_variant_id");
      continue;
    }
    const variationExternalId = miswagVariationExternalId(variant);
    if (!variationExternalId) {
      errors.push("invalid_external_id");
      continue;
    }
    const color = resolveMiswagColor(variant);
    if (!color || !String(color.name || "").trim()) {
      errors.push("missing_color_name");
    }
    const images = variationImages(variant.images, origin);
    if (!images.length) errors.push("missing_images");
    for (const image of images) {
      previewImages.push(image.url);
      const extension = imageExtension(image.url);
      if (extension && !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
        warnings.push("image_format_may_not_be_supported");
      }
    }
    const sizes = [];
    const seenSizes = new Set();
    for (const size of variant.sizes || []) {
      const sizeId = String(size?._id || size?.id || "").trim();
      const label = plainText(size?.size || size?.label || "");
      if (!sizeId) {
        errors.push("missing_sizes");
        continue;
      }
      if (!label || label.length > 50) {
        errors.push("missing_size_label");
        continue;
      }
      const sizeExternalId = printable(`bs-size-${sizeId}`, 100);
      if (!sizeExternalId || seenSizes.has(sizeExternalId)) {
        errors.push(seenSizes.has(sizeExternalId) ? "duplicate_size" : "missing_sizes");
        continue;
      }
      seenSizes.add(sizeExternalId);
      let quantity = Math.max(0, Math.floor(Number(size.stockQuantity) || 0));
      if (resolved.outOfStock) quantity = 0;
      totalStock += quantity;
      sizes.push({
        external_id: sizeExternalId,
        label,
        quantity,
      });
    }
    if (!sizes.length) errors.push("missing_sizes");
    const assigned = barcodeAssignments?.get?.(variationExternalId);
    const explicit = storedBarcode(variant);
    const barcode = String(assigned?.barcode || explicit || "").trim();
    const barcodeSource = assigned?.source
      ? assigned.source
      : explicit
        ? "explicit"
        : "";
    if (!barcode) errors.push("missing_variation_barcode");
    const source = barcodeSource || (barcode ? "explicit" : "");
    variations.push({
      external_id: variationExternalId,
      barcode: barcode || "",
      barcodeSource: source,
      ...(code ? { merchant_code: printable(code, 100) } : {}),
      color: color || undefined,
      images,
      sizes,
    });
  }

  const uniqueErrors = [...new Set(errors)];
  const payloadVariations = variations.map(({ barcodeSource: _source, ...row }) => {
    const next = { ...row };
    if (!next.barcode) delete next.barcode;
    return next;
  });
  const payload = {
    external_id: externalId,
    ...(code ? { item_code: printable(code, 100) } : {}),
    name_en: nameEn,
    ...(nameAr.length >= 3 ? { name_ar: nameAr } : {}),
    keywords,
    ...(highlight ? { highlight } : {}),
    ...(description ? { description } : {}),
    ...(categoryCheck.ok ? { category_id: categoryCheck.categoryId } : {}),
    is_large: miswagIsLargeFlag(isLarge),
    ...(brandCheck.ok ? { brand_id: brandCheck.brandId } : {}),
    price: Number.isFinite(price) ? price : 0,
    currency: "IQD",
    variations: payloadVariations,
  };

  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    errorMessages: uniqueErrors.map(reasonLabel),
    warnings: [...new Set(warnings)],
    payload,
    externalId,
    platformPrice: Number.isFinite(price) ? price : 0,
    rawPriceAfterCommission: Math.round(rawAfterCommission * 100) / 100,
    pricing,
    product: {
      id: String(resolved.id || doc?._id || ""),
      ibsherId: resolved.ibsherId || "",
      name: resolved.name,
      brandName: entityName(resolved.brand),
      sku: resolved.sku || resolved.itemCode || "",
      itemCode: resolved.itemCode || "",
      isActive: resolved.isActive !== false,
      stock: totalStock,
      images: [...new Set(previewImages)],
      variants: variations.map((row) => ({
        external_id: row.external_id,
        barcode: row.barcode || "",
        barcodeSource: row.barcodeSource || "",
        barcodeLabel:
          row.barcodeSource === "generated"
            ? "Auto-generated"
            : row.barcode
              ? "Existing"
              : "",
        merchant_code: row.merchant_code || "",
        color: row.color || null,
        imageCount: (row.images || []).length,
        sizes: (row.sizes || []).map((size) => ({
          external_id: size.external_id,
          label: size.label,
          quantity: size.quantity,
        })),
      })),
    },
    brand: brandCheck.ok
      ? { id: brandCheck.brandId, name: String(brandName || entityName(resolved.brand) || "") }
      : null,
    categoryId: categoryCheck.ok ? categoryCheck.categoryId : "",
    isLarge: miswagIsLargeFlag(isLarge),
  };
}

async function loadProductOrThrow(productId) {
  const id = String(productId || "").trim();
  if (!id) {
    throw new MiswagError("Exactly one product must be selected.", {
      status: 400,
      code: "not_exactly_one",
    });
  }
  const doc = await Product.findById(id);
  if (!doc) {
    throw new MiswagError("Product not found", { status: 404, code: "missing_product" });
  }
  return doc;
}

async function tryResolveBrandId(doc, explicitBrandId, brandCache = createBrandResolverCache()) {
  if (explicitBrandId != null && String(explicitBrandId).trim() !== "") {
    return { brandId: String(explicitBrandId).trim(), brandName: "", source: "temporary" };
  }
  const resolved = await resolveMiswagBrandForProduct(doc, brandCache);
  if (resolved.ok) {
    return {
      brandId: String(resolved.brand.id),
      brandName: String(resolved.brand.name || ""),
      source: resolved.source || resolved.matchType || "live_search",
    };
  }
  return {
    brandId: "",
    brandName: brandLabelOfSafe(doc),
    source: resolved.code === "brand_missing_name" ? "none" : "unresolved",
    code: resolved.code,
  };
}

function brandLabelOfSafe(doc) {
  const brand = doc?.brand;
  if (!brand) return "";
  if (typeof brand.name === "string") return brand.name;
  return brand.name?.en || brand.name?.ar || brand.name?.ku || "";
}

export async function previewMiswagTestProduct({
  productId,
  categoryId = "",
  brandId = "",
  lookupExisting = true,
} = {}) {
  await assertMiswagSyncAllowed();
  const doc = await loadProductOrThrow(productId);
  const storePriceBefore = Number(toResolvedProduct(doc)?.sellingPrice) || 0;

  const [rules, eligibilityContext, brand, mappingByCollection] = await Promise.all([
    Commission.find({ partner: "miswag", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("miswag"),
    tryResolveBrandId(doc, brandId),
    loadMiswagCategoryMappingMap(),
  ]);

  const eligibility = evaluatePlatformEligibility(doc, eligibilityContext);
  const barcodeAssignments = await ensureProductVariationBarcodes(doc);
  const isLarge = resolveMiswagCollectionIsLarge(doc, mappingByCollection);
  const built = buildMiswagTestPayload(doc, {
    rules,
    categoryId,
    brandId: brand.brandId || brandId,
    brandName: brand.brandName,
    isLarge,
    barcodeAssignments,
  });

  const blockReasons = [];
  if (!eligibility.eligible) {
    blockReasons.push("platform_blocked");
    for (const reason of eligibility.reasons || []) {
      if (reason?.message) blockReasons.push(reason.message);
    }
  }
  blockReasons.push(...built.errors);

  let existing = null;
  let plannedAction = "CREATE";
  let lookupNote =
    "Safe lookup uses GET /v1/items/{external_id}. No SKU/item_code lookup endpoint was found in the prior Miswag client.";
  if (lookupExisting && built.externalId && built.externalId !== "bs-") {
    try {
      existing = await getItem(built.externalId);
      plannedAction = existing ? "UPDATE" : "CREATE";
    } catch (err) {
      lookupNote = sanitizeMiswagText(
        `Lookup failed: ${err.message}. Will not send until lookup works (duplicate safety).`
      );
      plannedAction = "BLOCKED";
      blockReasons.push("lookup_failed");
    }
  }

  const canSend = blockReasons.length === 0 && plannedAction !== "BLOCKED";
  const storePriceAfter = Number(toResolvedProduct(doc)?.sellingPrice) || 0;

  return {
    canSend,
    plannedAction: canSend ? plannedAction : "BLOCKED",
    missingFields: built.errorMessages,
    blockReasons: [...new Set(blockReasons.map((code) => reasonLabel(code) === code ? code : reasonLabel(code)))],
    eligibility,
    pricing: {
      storePrice: built.pricing.storePrice,
      commissionPercent: built.pricing.rate,
      rawPriceAfterCommission: built.rawPriceAfterCommission,
      finalRoundedPrice: built.platformPrice,
      currency: "IQD",
      storePriceUnchanged: storePriceBefore === storePriceAfter,
    },
    product: built.product,
    brand: built.brand,
    brandResolution: brand,
    categoryId: built.categoryId || String(categoryId || "").trim(),
    isLarge: built.payload?.is_large === true,
    largeProduct: built.payload?.is_large === true ? "Yes" : "No",
    categoryRequired: true,
    categoryNote:
      "Miswag category_id is mandatory (L3-… or L4-…). Enter a temporary ID for this test only — no mapping system is saved.",
    externalId: built.externalId,
    existingOnMiswag: Boolean(existing),
    miswagItemId: existing
      ? String(existing.data?.id || existing.data?.item_id || built.externalId)
      : "",
    lookupNote,
    endpoint: MISWAG_ITEM_CREATE_PATH,
    method: "POST",
    payloadPreview: built.payload,
    warnings: built.warnings,
  };
}

export async function sendMiswagTestProduct({
  productId,
  categoryId = "",
  brandId = "",
  confirm = false,
} = {}) {
  if (confirm !== true) {
    throw new MiswagError('Confirm by setting confirm: true after reviewing the preview ("Send Test Product").', {
      status: 400,
      code: "confirm_required",
    });
  }

  const preview = await previewMiswagTestProduct({
    productId,
    categoryId,
    brandId,
    lookupExisting: true,
  });

  if (!preview.canSend || preview.plannedAction === "BLOCKED") {
    return {
      ok: false,
      action: "BLOCKED",
      httpStatus: 0,
      method: preview.method,
      endpoint: preview.endpoint,
      brownstoreProductId: preview.product?.id || "",
      brownstoreSku: preview.product?.sku || preview.product?.itemCode || "",
      miswagProductId: "",
      message: "Send blocked — fix missing fields or eligibility first.",
      validationErrors: preview.missingFields,
      blockReasons: preview.blockReasons,
      preview,
    };
  }

  const doc = await loadProductOrThrow(productId);
  const storePriceBefore = Number(toResolvedProduct(doc)?.sellingPrice) || 0;
  const payload = preview.payloadPreview;

  let httpStatus = 0;
  let responseData = null;
  let message = "";
  let ok = false;
  try {
    // Interactive Sync 1 Product: fail fast (no long transient retries).
    const response = await createOrUpdateItem(payload, { retries: 0 });
    httpStatus = response.status;
    responseData = response.data;
    message = response.message || (preview.plannedAction === "UPDATE" ? "Updated on Miswag" : "Created on Miswag");
    ok = httpStatus >= 200 && httpStatus <= 202;
  } catch (err) {
    httpStatus = Number(err.status) || 0;
    message = sanitizeMiswagText(err.message || "Miswag send failed");
    const validationErrors = Array.isArray(err.errors) ? err.errors : [];
    await logMiswagSafe("sync-one-failed", {
      productId: String(productId),
      sku: preview.product?.sku || "",
      httpStatus,
      action: preview.plannedAction,
      success: false,
    });
    return {
      ok: false,
      action: preview.plannedAction,
      httpStatus,
      method: "POST",
      endpoint: MISWAG_ITEM_CREATE_PATH,
      brownstoreProductId: preview.product?.id || "",
      brownstoreSku: preview.product?.sku || preview.product?.itemCode || "",
      miswagProductId: "",
      message,
      validationErrors,
      preview,
    };
  }

  const storePriceAfter = Number(toResolvedProduct(await Product.findById(productId))?.sellingPrice) || 0;
  const miswagProductId = String(
    responseData?.item_id || responseData?.id || payload.external_id || ""
  );

  if (ok) {
    await saveMiswagAcceptedPayload({
      productId: preview.product?.id || String(productId),
      ibsherId: preview.product?.ibsherId || "",
      externalId: payload?.external_id,
      payload,
      httpStatus,
      miswagProductId,
    });
  }

  await logMiswagSafe("sync-one", {
    timestamp: new Date().toISOString(),
    productId: String(productId),
    sku: preview.product?.sku || "",
    httpStatus,
    miswagProductId,
    success: ok,
    action: preview.plannedAction,
  });

  return {
    ok,
    action: preview.plannedAction,
    httpStatus,
    method: "POST",
    endpoint: MISWAG_ITEM_CREATE_PATH,
    brownstoreProductId: preview.product?.id || "",
    brownstoreSku: preview.product?.sku || preview.product?.itemCode || "",
    miswagProductId,
    message: ok
      ? httpStatus === 201 || preview.plannedAction === "CREATE"
        ? "Success — product created/queued on Miswag"
        : "Success — product upserted on Miswag"
      : message,
    validationErrors: [],
    storePriceUnchanged: storePriceBefore === storePriceAfter && storePriceBefore === preview.pricing.storePrice,
    preview,
  };
}

export async function searchProductsForMiswagTest(q = "", limit = 20) {
  await assertMiswagSyncAllowed();
  const query = String(q || "").trim();
  const filter = query
    ? {
        $or: [
          { itemCode: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { "overrides.sku": new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { "name.en": new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { "name.ar": new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
          { "name.ku": new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") },
        ],
      }
    : {};
  const items = await Product.find(filter)
    .select("name itemCode overrides.sku brand ibsherId isActive")
    .sort({ updatedAt: -1 })
    .limit(Math.min(50, Math.max(1, Number(limit) || 20)))
    .lean();
  return {
    products: items.map((item) => ({
      id: String(item._id),
      name: item.name || {},
      sku: item.overrides?.sku || item.itemCode || "",
      itemCode: item.itemCode || "",
      brand:
        typeof item.brand?.name === "string"
          ? item.brand.name
          : item.brand?.name?.en || item.brand?.name?.ar || "",
      ibsherId: item.ibsherId || "",
      isActive: item.isActive !== false,
    })),
  };
}

/** Shared Miswag product payload builder used by Sync 1 and Sync All. */
export const buildMiswagProductPayload = buildMiswagTestPayload;
