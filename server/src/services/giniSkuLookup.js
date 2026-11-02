import { performGiniRequest } from "./giniConnection.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "../utils/giniSyncOnePlan.js";

function sameSku(item, skuKey) {
  return giniSkuKey(item?.sku) === skuKey;
}

function failureOf(response) {
  if (response?.edgeBlocked) return "edge";
  if (response?.status === 429) return "rate_limited";
  if (response?.status === 401 || response?.status === 403) return "auth";
  return "error";
}

function errorResult(response) {
  const retryAfter = Number(response?.retryAfter);
  return {
    error: true,
    status: Number(response?.status) || 0,
    failure: failureOf(response),
    retryAfter: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
  };
}

/** Read one SKU from GINI. HTTP failures stay uncertain; they are not treated as "absent". */
export async function findExistingGiniProduct(sku) {
  const skuKey = giniSkuKey(sku);
  const shown = await performGiniRequest({
    method: "GET",
    path: `${GINI_PRODUCTS_PATH}/${encodeURIComponent(sku)}`,
  });
  if (shown.status === 404) return { exists: false };
  if (shown.status === 200 && sameSku(shown.json?.data, skuKey)) {
    return {
      exists: true,
      giniProductId: String(shown.json.data.id ?? ""),
      sku: String(shown.json.data.sku || sku),
    };
  }
  if (shown.status !== 200 && shown.status !== 404) return errorResult(shown);
  let page = 1;
  let lastPage = 1;
  while (page <= lastPage && page <= 5) {
    const listed = await performGiniRequest({
      method: "GET",
      path: GINI_PRODUCTS_PATH,
      query: `?search=${encodeURIComponent(sku)}&per_page=100&page=${page}`,
    });
    if (listed.status !== 200 || !Array.isArray(listed.json?.data)) return errorResult(listed);
    const match = listed.json.data.find((item) => sameSku(item, skuKey));
    if (match) {
      return { exists: true, giniProductId: String(match.id ?? ""), sku: String(match.sku || sku) };
    }
    lastPage = Number(listed.json?.meta?.last_page) || 1;
    page += 1;
  }
  return { exists: false };
}
