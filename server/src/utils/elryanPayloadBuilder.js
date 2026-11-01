import { validateElryanSku } from "./elryanSku.js";
import { ELRYAN_TITLE_MAX } from "./elryanConstants.js";
import { collectElryanImageUrls } from "./elryanImages.js";

export { collectElryanImageUrls };

function clip(value, max) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * Build OpenAPI-shaped create payload. Does not call Elryan.
 * Omits `cost`. `price` is the BrownStore selling price after Elryan commission rules.
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
  dimensions = null,
  quantity,
}) {
  const skuCheck = validateElryanSku(sku);
  const images = collectElryanImageUrls(resolved).map((fileUrl) => ({ fileUrl }));
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
  // cost intentionally omitted; price is the BrownStore Elryan amount

  if (attributes && typeof attributes === "object" && Object.keys(attributes).length) {
    payload.attributes = attributes;
  }

  if (
    dimensions?.confirmed === true &&
    [dimensions.width, dimensions.height, dimensions.depth].every((value) => Number(value) > 0)
  ) {
    payload.width = Number(dimensions.width);
    payload.height = Number(dimensions.height);
    payload.depth = Number(dimensions.depth);
  }

  return payload;
}
