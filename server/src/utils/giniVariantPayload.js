import { buildSimplePayloadPreview } from "./giniSyncOnePlan.js";

export function buildVariantParentPreview({ text, sku, price, category, subcategory, imageUrls }) {
  return buildSimplePayloadPreview({
    text,
    sku,
    price,
    quantity: 0,
    securityStock: 0,
    category,
    subcategory,
    isVisible: 0,
    imageUrls,
  });
}

export function buildReusableVariantFields(rows = []) {
  const fields = [{ key: "_method", value: "PUT", type: "text" }];
  rows.forEach((row, index) => {
    fields.push(
      { key: `variants[${index}][sku]`, value: String(row.sku || ""), type: "text" },
      { key: `variants[${index}][price]`, value: String(row.price), type: "text" },
      { key: `variants[${index}][quantity]`, value: String(row.stock), type: "text" },
      { key: `variants[${index}][attributes][0][attribute_id]`, value: String(row.attributeId || ""), type: "text" },
      { key: `variants[${index}][attributes][0][value]`, value: String(row.value || ""), type: "text" },
      { key: `variants[${index}][image]`, type: "file", sourceUrl: row.imageUrl || "", color: row.value || "" }
    );
  });
  return { method: "PUT", bodyMode: "formdata", fields };
}
