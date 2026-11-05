import { performGiniRequest } from "./giniConnection.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "../utils/giniSyncOnePlan.js";

const ABSENCE_SEARCH_PAGE_CAP = 20;

function sameSku(item, skuKey) {
  return giniSkuKey(item?.sku) === skuKey;
}

function failureOf(response) {
  if (response?.edgeBlocked) return "edge";
  if (response?.status === 429) return "rate_limited";
  if (response?.status === 401 || response?.status === 403) return "auth";
  return "error";
}

function giniResponseImages(data) {
  const urls = [];
  const push = (value) => {
    const url = String(value || "").trim();
    if (url) urls.push(url);
  };
  if (Array.isArray(data?.images)) {
    for (const image of data.images) push(typeof image === "string" ? image : image?.url || image?.image);
  }
  if (!urls.length) push(data?.image);
  return urls;
}

function errorResult(response, failure = "") {
  const retryAfter = Number(response?.retryAfter);
  return {
    error: true,
    status: Number(response?.status) || 0,
    failure: failure || failureOf(response),
    reason: failure === "incomplete" ? "search_pagination_incomplete" : failure === "duplicate" ? "duplicate_remote_sku" : "",
    retryAfter: Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : null,
  };
}

function foundResult(data, fallbackSku) {
  return {
    exists: true,
    giniProductId: String(data.id ?? "").trim(),
    sku: String(data.sku || fallbackSku),
    images: giniResponseImages(data),
  };
}

function positiveMatch(data, skuKey) {
  return Boolean(data && sameSku(data, skuKey) && String(data.id ?? "").trim());
}

/**
 * Read one SKU from GINI.
 * A direct HTTP 404 is not absence. Absence requires that 404 plus a finished search
 * with a known last page and no exact SKU. Incomplete, rate-limited, or failed reads stay uncertain.
 * One exact product id remains a positive match and blocks another create.
 */
export async function findExistingGiniProduct(sku, perform = performGiniRequest) {
  const skuKey = giniSkuKey(sku);
  const shown = await perform({
    method: "GET",
    path: `${GINI_PRODUCTS_PATH}/${encodeURIComponent(sku)}`,
  });
  if (shown.status === 200 && positiveMatch(shown.json?.data, skuKey)) return foundResult(shown.json.data, sku);
  if (shown.status !== 200 && shown.status !== 404) return errorResult(shown);
  const directWas404 = shown.status === 404;
  const matches = [];
  let page = 1;
  let lastPage = null;
  while (lastPage == null || page <= lastPage) {
    if (page > ABSENCE_SEARCH_PAGE_CAP) return errorResult({ status: 200 }, "incomplete");
    const listed = await perform({
      method: "GET",
      path: GINI_PRODUCTS_PATH,
      query: `?search=${encodeURIComponent(sku)}&per_page=100&page=${page}`,
    });
    if (listed.status !== 200 || !Array.isArray(listed.json?.data)) return errorResult(listed);
    const reportedLast = Number(listed.json?.meta?.last_page);
    if (!Number.isInteger(reportedLast) || reportedLast < page) return errorResult({ status: listed.status || 200 }, "incomplete");
    lastPage = reportedLast;
    for (const item of listed.json.data) {
      if (positiveMatch(item, skuKey)) matches.push(item);
    }
    const ids = [...new Set(matches.map((item) => String(item.id).trim()))];
    if (ids.length > 1) return errorResult({ status: 200 }, "duplicate");
    if (page >= lastPage) break;
    page += 1;
  }
  if (matches.length === 1) return foundResult(matches[0], sku);
  if (!directWas404) return errorResult({ status: shown.status || 200 }, "incomplete");
  return { exists: false };
}
