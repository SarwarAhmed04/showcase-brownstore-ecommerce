import { ELRYAN_PATHS } from "../utils/elryanConstants.js";
import {
  normalizeElryanAttributeValueList,
  normalizeElryanAttributeValueRow,
} from "../utils/elryanAttributeValues.js";
import { formatElryanReadError } from "../utils/elryanErrorMessage.js";
import { extractElryanListMeta } from "../utils/elryanPagination.js";
import { ElryanClientError } from "./elryanClient.js";
import { elryanAuthedRead } from "./elryanConnection.js";
import { elryanAttributeSupportsValueList } from "./elryanAttributeValueCatalog.js";

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.categories)) return payload.data.categories;
  return [];
}

function asObject(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if (payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)) {
      return payload.data;
    }
    return payload;
  }
  return {};
}

async function read(path, query) {
  const result = await elryanAuthedRead(path, { query, retries: 1 });
  if (!result.ok) {
    const formatted = formatElryanReadError(result);
    throw new ElryanClientError(formatted.message, {
      status: result.httpStatus >= 400 && result.httpStatus < 600 ? result.httpStatus : 502,
      code: formatted.code || "elryan_read_failed",
      classification: "READ",
      httpStatus: result.httpStatus,
    });
  }
  return result;
}

/** READ — GET /v1/health-check */
export async function elryanHealthCheck() {
  const result = await read(ELRYAN_PATHS.healthCheck);
  return { classification: "READ", httpStatus: result.httpStatus, data: result.json };
}

/** READ — GET /v1/categories */
export async function elryanListCategories(query = {}) {
  const page = query.page != null && query.page !== "" ? Number(query.page) : 1;
  const limit = query.limit != null && query.limit !== "" ? Number(query.limit) : 20;
  const result = await read(ELRYAN_PATHS.categories, {
    page: Number.isFinite(page) ? page : 1,
    limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, limit)) : 20,
    search: query.search || undefined,
    isChildren: query.isChildren,
    rootId: query.rootId,
    rootFilter: query.rootFilter,
  });
  const meta = extractElryanListMeta(result.json);
  return {
    classification: "READ",
    httpStatus: result.httpStatus,
    categories: asList(result.json),
    meta,
    page: meta.page ?? (Number.isFinite(page) ? page : 1),
    limit: meta.limit ?? (Number.isFinite(limit) ? limit : 20),
    total: meta.total,
    raw: result.json,
  };
}

/** READ — GET /v1/categories/{id} */
export async function elryanGetCategory(id) {
  const result = await read(ELRYAN_PATHS.categoryById(id));
  return { classification: "READ", httpStatus: result.httpStatus, category: asObject(result.json) };
}

/** READ — GET /v1/categories/{id}/children */
export async function elryanCategoryChildren(id, query = {}) {
  const result = await read(ELRYAN_PATHS.categoryChildren(id), query);
  return { classification: "READ", httpStatus: result.httpStatus, categories: asList(result.json) };
}

/** READ — GET /v1/categories/{id}/descendants */
export async function elryanCategoryDescendants(id, query = {}) {
  const result = await read(ELRYAN_PATHS.categoryDescendants(id), query);
  return { classification: "READ", httpStatus: result.httpStatus, categories: asList(result.json) };
}

/** READ — GET /v1/categories/{id}/attributes */
export async function elryanCategoryAttributes(id, query = {}) {
  const result = await read(ELRYAN_PATHS.categoryAttributes(id), {
    search: query.search || undefined,
  });
  return { classification: "READ", httpStatus: result.httpStatus, attributes: asList(result.json), raw: result.json };
}

/** READ — GET /v1/attribute-sets/category/{categoryId} */
export async function elryanAttributeSetForCategory(categoryId) {
  const result = await read(ELRYAN_PATHS.attributeSetForCategory(categoryId));
  return { classification: "READ", httpStatus: result.httpStatus, attributeSet: asObject(result.json), raw: result.json };
}

/** READ — GET /v1/attribute-values or /v1/attribute-values/{attribute} */
export async function elryanAttributeValues(attribute, query = {}) {
  const pageRaw = query.page != null && query.page !== "" ? Number(query.page) : 1;
  const limitRaw = query.limit != null && query.limit !== "" ? Number(query.limit) : 20;
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : 20;

  // Brand/Color: Vendor Network `/list` returns real ids. Prefer it over paginated name-only paths.
  const attrHint = attribute || query.attribute;
  if (elryanAttributeSupportsValueList(attrHint)) {
    const { searchElryanAttributeValueCatalog } = await import("./elryanAttributeValueCatalog.js");
    return searchElryanAttributeValueCatalog({
      attribute: attrHint,
      q: query.search || query.q || "",
      id: query.id || "",
      page,
      limit,
      forceRefresh: query.refresh === "1" || query.refresh === "true",
    });
  }

  const path = attribute
    ? ELRYAN_PATHS.attributeValuesByAttribute(attribute)
    : ELRYAN_PATHS.attributeValues;
  const result = await read(path, {
    page,
    limit,
    search: query.search || undefined,
    id: query.id || undefined,
    ...(attribute ? {} : query.attribute ? { attribute: query.attribute } : {}),
  });
  const rawValues = asList(result.json);
  const values = normalizeElryanAttributeValueList(rawValues);
  const meta = extractElryanListMeta(result.json);
  const verifiedCount = values.filter((row) => row.idVerified).length;
  return {
    classification: "READ",
    httpStatus: result.httpStatus,
    values,
    meta,
    page: meta.page ?? page,
    limit: meta.limit ?? limit,
    total: meta.total,
    idsAvailable: verifiedCount > 0,
    verifiedIdCount: verifiedCount,
    nameOnlyCount: Math.max(0, values.length - verifiedCount),
    note:
      verifiedCount === 0 && values.length > 0
        ? "Official list/search returned names without value ids. Do not invent ids; mapping save stays blocked until a verified id is available."
        : undefined,
    raw: result.json,
  };
}

/** READ — GET /v1/attribute-values/id/{id} */
export async function elryanAttributeValueById(id) {
  const valueId = String(id ?? "").trim();
  if (!valueId) {
    throw new ElryanClientError("attribute value id is required", {
      status: 400,
      code: "attribute_value_id_required",
      classification: "READ",
    });
  }
  const result = await read(ELRYAN_PATHS.attributeValueById(valueId));
  const raw = asObject(result.json);
  const normalized = normalizeElryanAttributeValueRow({
    ...raw,
    id: extractIdPrefer(raw, valueId),
  });
  if (!normalized.idVerified) {
    // Path lookup used a known id; treat path id as verified only when API acknowledged the record.
    normalized.verifiedId = valueId;
    normalized.idVerified = true;
    normalized.raw = { ...normalized.raw, id: valueId };
  }
  return {
    classification: "READ",
    httpStatus: result.httpStatus,
    value: normalized,
    raw: result.json,
  };
}

function extractIdPrefer(raw, fallbackId) {
  const fromRow = raw?.id ?? raw?._id ?? raw?.valueId ?? raw?.attributeValueId;
  if (fromRow != null && String(fromRow).trim()) return fromRow;
  return fallbackId;
}

/** READ — GET /v1/commissions */
export async function elryanListCommissions(query = {}) {
  const result = await read(ELRYAN_PATHS.commissions, {
    page: query.page || 1,
    limit: query.limit || 20,
    search: query.search || undefined,
  });
  return { classification: "READ", httpStatus: result.httpStatus, commissions: asList(result.json), raw: result.json };
}

/** READ — GET /v1/commissions/calculate */
export async function elryanCalculateCommission(query = {}) {
  if (!query.brand) {
    throw new ElryanClientError("brand query parameter is required", {
      status: 400,
      code: "brand_required",
      classification: "READ",
    });
  }
  if (!query.categoryId && !query.categoryHierarchy) {
    throw new ElryanClientError("categoryId or categoryHierarchy is required", {
      status: 400,
      code: "category_required",
      classification: "READ",
    });
  }
  const result = await read(ELRYAN_PATHS.commissionsCalculate, {
    categoryId: query.categoryId || undefined,
    categoryHierarchy: query.categoryHierarchy || undefined,
    brand: query.brand,
    splitFeature: query.splitFeature || undefined,
  });
  return {
    classification: "READ",
    httpStatus: result.httpStatus,
    calculation: asObject(result.json),
    raw: result.json,
  };
}

/** READ — GET /v1/warranty */
export async function elryanListWarranties() {
  const result = await read(ELRYAN_PATHS.warranty);
  return { classification: "READ", httpStatus: result.httpStatus, warranties: asList(result.json), raw: result.json };
}

/** READ — GET /v1/products/sku-exists */
export async function elryanSkuExists(sku, productId) {
  const result = await read(ELRYAN_PATHS.skuExists, {
    sku: String(sku || "").trim(),
    productId: productId || undefined,
  });
  return {
    classification: "READ",
    httpStatus: result.httpStatus,
    exists: result.httpStatus === 409 || Boolean(result.json?.exists),
    raw: result.json,
  };
}
