/**
 * Duplicate SKUs are a catalog warning for platform Excel exports.
 * The rows stay in the file. Nothing here changes a product or its SKU.
 */
export function summarizeDuplicateSkus(rows) {
  const bySku = new Map();
  for (const row of rows || []) {
    const sku = String(row?.sku ?? "").trim();
    if (!sku) continue;
    const products = bySku.get(sku) || [];
    products.push({
      productId: String(row.productId || ""),
      ibsherId: String(row.ibsherId || ""),
      name: String(row.name || ""),
      brand: String(row.brand || ""),
      collection: String(row.collection || ""),
      sellingPrice: Number(row.sellingPrice) || 0,
    });
    bySku.set(sku, products);
  }

  const duplicates = [];
  for (const [sku, products] of bySku) {
    if (products.length < 2) continue;
    duplicates.push({ sku, rows: products.length, products });
  }
  duplicates.sort((a, b) => a.sku.localeCompare(b.sku));
  const extraDuplicateRows = duplicates.reduce((sum, group) => sum + group.rows - 1, 0);

  return {
    exportRows: (rows || []).length,
    uniqueSkus: bySku.size,
    duplicateSkuValues: duplicates.length,
    extraDuplicateRows,
    duplicates,
  };
}
