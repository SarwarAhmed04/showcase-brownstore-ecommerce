import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";

export async function loadProtectedVariantSkuKeys() {
  const rows = await GiniVariantParentOwner.find({ status: "verified_remote" }).select("skuKey").lean();
  return new Set(rows.map((row) => giniSkuKey(row.skuKey)).filter(Boolean));
}

export function variantParentProtected(skuKey, keys) {
  return Boolean(skuKey) && keys instanceof Set && keys.has(skuKey);
}
