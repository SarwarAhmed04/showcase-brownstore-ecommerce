import { publicMediaUrl } from "./commissionExcel.js";

export const GINI_PRODUCTS_PATH = "/api/v2.0/third-party/products";
export const GINI_IMAGE_LIMIT = 10;
export const GINI_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const GINI_NAME_MAX = 255;
export const GINI_DESCRIPTION_MAX_WORDS = 1000;

const IMAGE_MIME = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
});

export function normalizeGiniItemCode(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-");
}

export function giniSkuKey(value) {
  return normalizeGiniItemCode(value).toLowerCase();
}

function loc(value, key) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value.name) return loc(value.name, key);
  if (value[key]) return String(value[key]).trim();
  const text = value.value || value.text || value.label;
  return text != null && text !== "" ? String(text).trim() : "";
}

export function giniCatalogText(product) {
  const brand = loc(product?.brand, "en") || loc(product?.brand, "ku") || loc(product?.brand, "ar");
  const nameAr = loc(product?.name, "ar");
  const nameEn = loc(product?.name, "en");
  const description = loc(product?.description, "ar");
  const name = brand && nameAr && nameEn ? `| ${brand} | ${nameAr} / ${nameEn}` : "";
  return { brand, nameAr, nameEn, name, description };
}

function colorText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return loc(value, "en") || loc(value, "ku") || loc(value, "ar");
}

function explicitSku(record) {
  if (!record || typeof record !== "object") return "";
  return normalizeGiniItemCode(record.sku || record.itemCode || "");
}

function explicitPrice(record) {
  if (!record || typeof record !== "object") return null;
  for (const key of ["price", "sellingPrice", "discountPrice"]) {
    if (record[key] == null || record[key] === "") continue;
    const number = Number(record[key]);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function distinctColors(variant) {
  const found = [];
  const push = (value) => {
    const text = colorText(value).toLowerCase();
    if (text && !found.includes(text)) found.push(text);
  };
  push(variant?.color);
  for (const size of variant?.sizes || []) push(size?.color);
  return found;
}

export function assessSimpleProduct(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const parentKey = giniSkuKey(product?.itemCode);
  const sellingPrice = Number(product?.sellingPrice);
  const reasons = [];
  if (variants.length !== 1) reasons.push("gini_variant_mapping_required");
  const variant = variants.length === 1 ? variants[0] : null;
  if (variant) {
    const sizes = Array.isArray(variant.sizes) ? variant.sizes : [];
    if (sizes.length > 1 || distinctColors(variant).length > 1) {
      reasons.push("gini_variant_mapping_required");
    }
    const ownSku = explicitSku(variant);
    if (ownSku && giniSkuKey(ownSku) !== parentKey) reasons.push("gini_variant_mapping_required");
    const ownPrice = explicitPrice(variant);
    if (ownPrice != null && ownPrice !== sellingPrice) reasons.push("gini_variant_mapping_required");
    for (const size of sizes) {
      const sizeSku = explicitSku(size);
      if (sizeSku && giniSkuKey(sizeSku) !== parentKey) reasons.push("gini_variant_mapping_required");
      const sizePrice = explicitPrice(size);
      if (sizePrice != null && sizePrice !== sellingPrice) reasons.push("gini_variant_mapping_required");
    }
  }
  const simple = reasons.length === 0;
  return {
    simple,
    giniMode: simple ? "SIMPLE_PRODUCT" : null,
    brownStoreVariantsCollapsed: simple ? 1 : 0,
    variantCount: variants.length,
    blockers: [...new Set(reasons)],
  };
}

export function listGiniImageUrls(product) {
  const seen = new Set();
  const urls = [];
  const push = (url) => {
    const next = publicMediaUrl(url);
    if (!next || seen.has(next)) return;
    seen.add(next);
    urls.push(next);
  };
  for (const variant of product?.variants || []) {
    for (const image of variant.images || []) push(image?.url);
  }
  push(product?.image);
  return urls;
}

export function wordCount(value) {
  const text = String(value || "").trim();
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

export function allowedMediaOrigin() {
  try {
    return new URL(publicMediaUrl("/uploads/products/check.webp")).origin;
  } catch {
    return "";
  }
}

export function isAllowedMediaUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  if (!url.pathname.startsWith("/api/media/") || url.pathname.includes("..")) return false;
  return Boolean(allowedMediaOrigin()) && url.origin === allowedMediaOrigin();
}

export function sniffImage(buffer, contentType) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const mimeHeader = String(contentType || "")
    .split(";")[0]
    .trim()
    .toLowerCase()
    .replace("image/jpg", "image/jpeg");
  if (!IMAGE_MIME[mimeHeader]) return null;
  if (!bytes.length || bytes.length > GINI_IMAGE_MAX_BYTES) return null;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.slice(0, 6).toString("ascii") === "GIF87a" || bytes.slice(0, 6).toString("ascii") === "GIF89a";
  const webp =
    bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.slice(8, 12).toString("ascii") === "WEBP";
  const detected = png ? "image/png" : jpeg ? "image/jpeg" : gif ? "image/gif" : webp ? "image/webp" : "";
  if (detected !== mimeHeader) return null;
  return { mime: detected, extension: IMAGE_MIME[detected] };
}

export function decideSyncAction(blockers) {
  const codes = [...new Set((blockers || []).filter(Boolean))];
  const onlyExisting = codes.length === 1 && codes[0] === "existing_gini_product";
  if (onlyExisting) return { action: "UPDATE_AVAILABLE", blockers: codes, canSend: false };
  if (codes.length) return { action: "BLOCKED", blockers: codes, canSend: false };
  return { action: "CREATE", blockers: [], canSend: true };
}

export function buildSimplePayloadPreview({
  text,
  sku,
  price,
  quantity,
  securityStock,
  category,
  subcategory,
  isVisible,
  imageUrls,
}) {
  return {
    name: text.name,
    description: text.description,
    sku,
    price,
    quantity,
    security_stock: securityStock,
    category_id: category?.id ?? null,
    subcategory_id: subcategory?.id ?? null,
    is_visible: isVisible,
    images: (imageUrls || []).map((url) => ({ url })),
  };
}
