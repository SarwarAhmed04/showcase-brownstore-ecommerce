export function canConfirmGiniSkuCreate({ preview, sku, productId, confirmed, busy }) {
  if (!preview) return false;
  return Boolean(
    preview.sku === String(sku || "").trim() &&
      preview.productId === String(productId || "").trim() &&
      preview.canCreate === true &&
      preview.previewToken &&
      preview.productCount === 1 &&
      preview.writesEnabled === true &&
      confirmed === true &&
      busy !== true
  );
}
