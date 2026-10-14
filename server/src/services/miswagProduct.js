import crypto from "crypto";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { cdnUrl, toResolvedProduct } from "../utils/productView.js";

const SENDABLE = new Set(["auto_mapped", "verified"]);
const SUPPORTED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif"]);
const PUBLISH_CONTENT_ERRORS = ["missing_keywords", "missing_arabic_name_for_highlight", "missing_arabic_description"];
const PRINTABLE = /[^\x20-\x7E]/g;
const HIGHLIGHT_MAX = 160;

const COLOR_MAP = {
  black: ["#000000", "Black"],
  white: ["#FFFFFF", "White"],
  red: ["#FF0000", "Red"],
  blue: ["#0000FF", "Blue"],
  green: ["#008000", "Green"],
  yellow: ["#FFFF00", "Yellow"],
  orange: ["#FFA500", "Orange"],
  purple: ["#800080", "Purple"],
  pink: ["#FFC0CB", "Pink"],
  gray: ["#808080", "Gray"],
  grey: ["#808080", "Gray"],
  silver: ["#C0C0C0", "Silver"],
  gold: ["#D4AF37", "Gold"],
  brown: ["#8B4513", "Brown"],
  beige: ["#F5F5DC", "Beige"],
  navy: ["#000080", "Navy"],
  "navy blue": ["#000080", "Navy"],
  اسود: ["#000000", "Black"],
  ابيض: ["#FFFFFF", "White"],
  احمر: ["#FF0000", "Red"],
  ازرق: ["#0000FF", "Blue"],
  اخضر: ["#008000", "Green"],
  اصفر: ["#FFFF00", "Yellow"],
  برتقالي: ["#FFA500", "Orange"],
  بنفسجي: ["#800080", "Purple"],
  وردي: ["#FFC0CB", "Pink"],
  رمادي: ["#808080", "Gray"],
  فضي: ["#C0C0C0", "Silver"],
  ذهبي: ["#D4AF37", "Gold"],
  بني: ["#8B4513", "Brown"],
  بيج: ["#F5F5DC", "Beige"],
  كحلي: ["#000080", "Navy"],
  "ڕەش": ["#000000", "Black"],
  سپی: ["#FFFFFF", "White"],
  سوور: ["#FF0000", "Red"],
  شین: ["#0000FF", "Blue"],
  سەوز: ["#008000", "Green"],
  زەرد: ["#FFFF00", "Yellow"],
  پرتەقاڵی: ["#FFA500", "Orange"],
  مۆر: ["#800080", "Purple"],
  پەمەیی: ["#FFC0CB", "Pink"],
  خۆڵەمەشی: ["#808080", "Gray"],
  زیو: ["#C0C0C0", "Silver"],
  زێڕ: ["#D4AF37", "Gold"],
  قاوەیی: ["#8B4513", "Brown"],
  بێجی: ["#F5F5DC", "Beige"],
  نیلی: ["#000080", "Navy"],
};

const HEX_NAMES = new Map(
  Object.values(COLOR_MAP).map(([hex, name]) => [normalizeHex(hex), name])
);

export function mediaPublicOrigin() {
  return String(process.env.MEDIA_PUBLIC_ORIGIN || "").trim().replace(/\/$/, "");
}

export function miswagItemExternalId(product) {
  return `bs-${String(product?.ibsherId || "").trim()}`;
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

function normalizeColorKey(value) {
  return plainText(value)
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHex(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (!match) return "";
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((char) => char + char).join("");
  return `#${hex.toUpperCase()}`;
}

function pushColorBits(target, value) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    target.push(String(value));
    return;
  }
  if (typeof value !== "object") return;
  pushColorBits(target, value.value);
  pushColorBits(target, value.hex);
  pushColorBits(target, value.code);
  pushColorBits(target, value.colorHex);
  if (value.name && typeof value.name === "object") {
    pushColorBits(target, value.name.en);
    pushColorBits(target, value.name.ar);
    pushColorBits(target, value.name.ku);
  } else {
    pushColorBits(target, value.name);
  }
  pushColorBits(target, value.en);
  pushColorBits(target, value.ar);
  pushColorBits(target, value.ku);
  pushColorBits(target, value.label);
}

export function resolveMiswagColor(variant) {
  const bits = [];
  pushColorBits(bits, variant?.color);
  pushColorBits(bits, variant?.colour);
  pushColorBits(bits, variant?.colorName);
  pushColorBits(bits, variant?.colorHex);
  pushColorBits(bits, variant?.hex);
  pushColorBits(bits, variant?.colorValue);

  let hex = "";
  const names = [];
  for (const bit of bits) {
    const asHex = normalizeHex(bit);
    if (asHex && !hex) hex = asHex;
    const key = normalizeColorKey(bit);
    if (key && !asHex) names.push(key);
  }

  const named = names.map((name) => COLOR_MAP[name]).find(Boolean);
  if (hex && names.some((name) => name.length >= 3 && !COLOR_MAP[name])) {
    const explicit = names.find((name) => name.length >= 3);
    return { name: explicit.replace(/\b\w/g, (char) => char.toUpperCase()), value: hex };
  }
  if (hex && named) return { name: named[1], value: hex };
  if (hex && names.some((name) => name.length >= 3)) {
    return { name: names.find((name) => name.length >= 3), value: hex };
  }
  if (hex && HEX_NAMES.get(hex)) return { name: HEX_NAMES.get(hex), value: hex };
  if (!hex && named) return { name: named[1], value: normalizeHex(named[0]) };
  return null;
}

function publicImageUrl(url, origin) {
  const raw = String(url || "").trim();
  if (!raw || raw.startsWith("data:")) return "";
  const local = cdnUrl(raw);
  if (/^https?:\/\//i.test(local)) return local;
  if (!origin || !local.startsWith("/")) return "";
  return `${origin}${local}`;
}

function imageExtension(url) {
  const raw = String(url || "");
  let pathname = raw.split("?")[0].split("#")[0];
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // A relative URL can still carry a file extension.
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

function hashValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function fingerprintPayload(payload) {
  const content = {
    ...payload,
    price: 0,
    variations: (payload.variations || []).map((variation) => ({
      ...variation,
      sizes: (variation.sizes || []).map((size) => ({ ...size, quantity: 0 })),
    })),
  };
  const stock = (payload.variations || []).map((variation) => ({
    id: variation.external_id,
    sizes: (variation.sizes || []).map((size) => ({
      id: size.external_id,
      quantity: size.quantity,
    })),
  }));
  return `v1:${hashValue(content)}:${payload.price}:${hashValue(stock)}`;
}

export function planDelta(previousHash, nextHash, hasSuccessfulSync) {
  if (!hasSuccessfulSync) return "full";
  const previous = String(previousHash || "").split(":");
  const next = String(nextHash || "").split(":");
  if (previous[0] !== "v1" || next[0] !== "v1" || previous.length < 4 || next.length < 4) return "full";
  const sameContent = previous[1] === next[1];
  const samePrice = previous[2] === next[2];
  const sameStock = previous.slice(3).join(":") === next.slice(3).join(":");
  if (sameContent && samePrice && sameStock) return "unchanged";
  if (sameContent && sameStock) return "price";
  if (sameContent && samePrice) return "stock";
  if (sameContent) return "price_and_stock";
  return "full";
}

function entityName(entity) {
  return localized(entity?.name);
}

export function publishContentIssues(built) {
  const issues = [];
  const nameAr = String(built?.payload?.name_ar || "").trim();
  if (nameAr.length < 3) issues.push("missing_name_ar_for_publish");
  for (const code of PUBLISH_CONTENT_ERRORS) {
    if (built?.errors?.includes(code)) issues.push(code);
  }
  return issues;
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

export function miswagVariationExternalId(variant) {
  const variantId = String(variant?._id || variant?.id || "").trim();
  if (!variantId) return "";
  const externalId = printable(`bs-var-${variantId}`, 100);
  return externalId.startsWith("bs-var-") ? externalId : "";
}

export function explicitVariationBarcode(variant) {
  return storedBarcode(variant);
}

export function buildMiswagPayload(doc, { rules = [], platformOverrides = null, mapping = null, brandMatch = null, origin = mediaPublicOrigin(), preservedBarcodes = null, assignedBarcodes = null, clearSizeBarcodes = false } = {}) {
  const contentOverrides =
    platformOverrides && typeof platformOverrides === "object"
      ? { ...platformOverrides, price: null, discountPrice: null }
      : platformOverrides;
  const resolved = toResolvedProduct(doc, contentOverrides);
  const errors = [];
  const warnings = [];
  if (!resolved) {
    return { ok: false, errors: ["missing_product"], warnings, payload: null };
  }

  const pricing = partnerPricePreview(doc, rules);
  const price = Math.round(Number(pricing.price));
  const externalId = miswagItemExternalId(resolved);
  if (!/^[\x20-\x7E]+$/.test(externalId) || externalId === "bs-") errors.push("invalid_external_id");
  if (!Number.isFinite(price) || price < 0) errors.push("invalid_price");
  if (resolved.isActive === false) errors.push("inactive");

  const nameEn = localized(resolved.name, ["en", "ku", "ar"]);
  if (!localized(resolved.name, ["en"])) warnings.push("name_en_fallback");
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

  const mappingStatus = mapping?.status || "unmapped";
  const categoryId = String(mapping?.externalCategoryId || "");
  if (!SENDABLE.has(mappingStatus) || !categoryId) {
    errors.push(mappingStatus === "needs_review" ? "needs_review" : "unmapped_collection");
  } else if (!/^L[34]-\d+$/.test(categoryId)) {
    errors.push("invalid_category");
  }

  const code = printable(resolved.itemCode, 80);

  if (!origin) errors.push("missing_public_origin");
  const brandId = Number(brandMatch?.id);
  const brandName = String(brandMatch?.name || "");
  if (!Number.isInteger(brandId) || brandId <= 0) errors.push("brand_not_mapped");

  const variations = [];
  const variants = Array.isArray(resolved.variants) ? resolved.variants : [];
  if (!variants.length) errors.push("missing_variations");

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
    if (!color || color.name.length < 3 || !/^#[0-9A-Fa-f]{6}$/.test(color.value)) {
      errors.push("missing_color_value");
    }
    const images = variationImages(variant.images, origin);
    if (!images.length) errors.push("missing_images");
    if (images.some((image) => {
      const extension = imageExtension(image.url);
      return extension && !SUPPORTED_IMAGE_EXTENSIONS.has(extension);
    })) {
      warnings.push("image_format_may_not_be_supported");
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
      sizes.push({
        external_id: sizeExternalId,
        label,
        quantity,
        ...(clearSizeBarcodes ? { barcode: null } : {}),
      });
    }
    if (!sizes.length) errors.push("missing_sizes");
    const preservedBarcode = String(preservedBarcodes?.get?.(variationExternalId) || "").trim();
    const assignedBarcode = String(assignedBarcodes?.get?.(variationExternalId) || "").trim();
    const barcode = preservedBarcode || assignedBarcode || explicitVariationBarcode(variant);
    if (!barcode) errors.push("missing_variation_barcode");
    variations.push({
      external_id: variationExternalId,
      ...(barcode ? { barcode } : {}),
      ...(code ? { merchant_code: printable(code, 100) } : {}),
      color: color || undefined,
      images,
      sizes,
    });
  }

  const uniqueErrors = [...new Set(errors)];
  const payload = {
    external_id: externalId,
    ...(code ? { item_code: printable(resolved.itemCode || resolved.sku, 100) } : {}),
    name_en: nameEn,
    ...(nameAr.length >= 3 ? { name_ar: nameAr } : {}),
    keywords,
    ...(highlight ? { highlight } : {}),
    ...(description ? { description } : {}),
    ...(categoryId ? { category_id: categoryId } : {}),
    ...(Number.isInteger(brandId) && brandId > 0 ? { brand_id: brandId } : {}),
    price: Number.isFinite(price) ? price : 0,
    currency: "IQD",
    variations,
  };

  return {
    ok: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: [...new Set(warnings)],
    payload,
    externalId,
    platformPrice: Number.isFinite(price) ? price : 0,
    pricing,
    product: {
      id: String(resolved.id || ""),
      ibsherId: resolved.ibsherId || "",
      name: resolved.name,
      sku: resolved.sku || resolved.itemCode || "",
      itemCode: resolved.itemCode || "",
    },
    brand: Number.isInteger(brandId) && brandId > 0 ? { id: brandId, name: brandName } : null,
    mapping: mapping
      ? {
          status: mapping.status,
          externalCategoryId: mapping.externalCategoryId || "",
          externalCategoryName: mapping.externalCategoryName || "",
          externalPath: mapping.externalPath || "",
          confidence: mapping.confidence || 0,
        }
      : null,
  };
}
