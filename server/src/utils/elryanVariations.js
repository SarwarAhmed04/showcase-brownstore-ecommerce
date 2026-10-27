/**
 * Elryan marketplace-api create schema has colourId + single quantity, no verified multi-size array.
 * Multi-size / multi-variant products are blocked until Elryan confirms the model.
 */
export function assessElryanSellableUnits(resolvedProduct) {
  const variants = Array.isArray(resolvedProduct?.variants) ? resolvedProduct.variants : [];
  const reasons = [];

  if (!variants.length) {
    return {
      ok: false,
      mode: "NONE",
      colourLabel: "",
      sizeCount: 0,
      variantCount: 0,
      reasons: ["missing_variant"],
    };
  }

  let sizeCount = 0;
  const colourLabels = new Set();
  for (const variant of variants) {
    const colour =
      variant?.color?.name?.en ||
      variant?.color?.en ||
      variant?.color?.name ||
      (typeof variant?.color === "string" ? variant.color : "") ||
      "";
    if (String(colour).trim()) colourLabels.add(String(colour).trim().toLowerCase());
    const sizes = Array.isArray(variant?.sizes) ? variant.sizes : [];
    sizeCount += sizes.length;
    for (const size of sizes) {
      if (size?.sku && String(size.sku).trim() && resolvedProduct.sku) {
        if (String(size.sku).trim() !== String(resolvedProduct.sku).trim()) {
          reasons.push("per_size_sku_divergence");
        }
      }
      const sizePrice = Number(size?.price);
      if (Number.isFinite(sizePrice) && sizePrice > 0) {
        const selling = Number(resolvedProduct.sellingPrice);
        if (Number.isFinite(selling) && sizePrice !== selling) {
          reasons.push("per_size_price_divergence");
        }
      }
    }
  }

  if (variants.length > 1) reasons.push("multi_variant_unverified");
  if (sizeCount > 1) reasons.push("multi_size_unverified");
  if (colourLabels.size > 1) reasons.push("multi_colour_unverified");

  const uniqueReasons = [...new Set(reasons)];
  const colourLabel =
    variants[0]?.color?.name?.en ||
    variants[0]?.color?.en ||
    variants[0]?.color?.name ||
    (typeof variants[0]?.color === "string" ? variants[0].color : "") ||
    "";

  return {
    ok: uniqueReasons.length === 0,
    mode: uniqueReasons.length ? "BLOCKED" : "SIMPLE_COLOUR_SKU",
    colourLabel: String(colourLabel || "").trim(),
    sizeCount,
    variantCount: variants.length,
    reasons: uniqueReasons,
  };
}
