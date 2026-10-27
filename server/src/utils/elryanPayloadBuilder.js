import { validateElryanSku } from "./elryanSku.js";
import { ELRYAN_TITLE_MAX } from "./elryanConstants.js";

function clip(value, max) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max);
}

function absolutize(origin, url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${String(origin || "").replace(/\/+$/, "")}${path}`;
}

export function collectElryanImageUrls(resolved, origin) {
  const urls = [];
  const seen = new Set();
  function push(url) {
    const abs = absolutize(origin, url);
    if (!abs || !/^https:\/\//i.test(abs) || seen.has(abs)) return;
    seen.add(abs);
    urls.push(abs);
  }
  for (const variant of resolved?.variants || []) {
    for (const image of variant.images || []) push(image.url);
  }
  push(resolved?.image);
  return urls;
}

/**
 * Build OpenAPI-shaped create payload. Does not call Elryan.
 * Omits `cost` until pricing semantics are confirmed.
 */
export function buildElryanProductPayload({
  resolved,
  sku,
  mapping,
  brand,
  color,
  warranty,
  attributes = {},
  pricing,
  origin = "",
  quantity,
}) {
  const skuCheck = validateElryanSku(sku);
  const images = collectElryanImageUrls(resolved, origin).map((url) => ({ url }));
  const qty = Math.max(0, Math.floor(Number(quantity) || 0));
  const outOfStock = resolved?.outOfStock === true || qty <= 0;

  const vendorTitle = clip(resolved?.name?.en || resolved?.name?.ku || "", ELRYAN_TITLE_MAX);
  const vendorTitleAr = clip(resolved?.name?.ar || "", ELRYAN_TITLE_MAX);
  const vendorDescription = String(
    resolved?.description?.en || resolved?.description?.ar || resolved?.description?.ku || ""
  ).trim();

  const payload = {
    sku: skuCheck.ok ? skuCheck.sku : String(sku || "").trim(),
    vendorTitle: vendorTitle || undefined,
    vendorTitleAr: vendorTitleAr || undefined,
    vendorDescription: vendorDescription || undefined,
    categoryId: mapping?.categoryId ? String(mapping.categoryId) : undefined,
    brandId: brand?.elryanId ? String(brand.elryanId) : undefined,
    colorId: color?.elryanId ? String(color.elryanId) : undefined,
    warrantyCode: warranty?.elryanCode ? String(warranty.elryanCode) : undefined,
    images: images.length ? images : undefined,
    quantity: qty,
    stock: outOfStock ? 0 : 1,
  };

  if (pricing?.proposedElryanPrice != null && pricing.proposedElryanPrice > 0) {
    payload.price = pricing.proposedElryanPrice;
  }
  // cost intentionally omitted (pricing unverified)

  if (attributes && typeof attributes === "object" && Object.keys(attributes).length) {
    payload.attributes = attributes;
  }

  return payload;
}
