import { ELRYAN_ATTRIBUTE_VALUE_LIST_CACHE_TTL_MS, ELRYAN_PATHS } from "../utils/elryanConstants.js";
import {
  normalizeElryanAttributeName,
  normalizeElryanAttributeValueList,
  normalizeElryanAttributeValueRow,
  verifyElryanCatalogIdAndName,
} from "../utils/elryanAttributeValues.js";
import { formatElryanReadError } from "../utils/elryanErrorMessage.js";
import { ElryanClientError } from "./elryanClient.js";
import { elryanAuthedRead, getElryanConnectionPublic } from "./elryanConnection.js";

/** @type {Map<string, { fetchedAt: number, environment: string, attribute: string, rows: object[] }>} */
const listCache = new Map();

const LIST_ATTRIBUTES = new Set(["Brand", "Color"]);

function asList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeAttributeName(attribute) {
  const raw = String(attribute || "").trim();
  if (/^brand$/i.test(raw)) return "Brand";
  if (/^colou?r$/i.test(raw)) return "Color";
  return raw;
}

function cacheKey(environment, attribute) {
  return `${String(environment || "staging").toLowerCase()}:${attribute}`;
}

export function __resetElryanAttributeValueCatalogCacheForTests() {
  listCache.clear();
}

export function elryanAttributeSupportsValueList(attribute) {
  return LIST_ATTRIBUTES.has(normalizeAttributeName(attribute));
}

async function resolveActiveEnvironment() {
  const connection = await getElryanConnectionPublic();
  return String(connection?.environment || "staging").toLowerCase() === "production"
    ? "production"
    : "staging";
}

/**
 * Fetch full attribute value list from Vendor Network path
 * GET /v1/attribute-values/{Brand|Color}/list
 * Environment-scoped short TTL cache — never stores API keys.
 */
export async function loadElryanAttributeValueList(attribute, { forceRefresh = false } = {}) {
  const attr = normalizeAttributeName(attribute);
  if (!LIST_ATTRIBUTES.has(attr)) {
    throw new ElryanClientError(
      `Attribute list catalog is only implemented for Brand and Color (audited). Got "${attribute}".`,
      { status: 400, code: "attribute_list_unsupported", classification: "READ" }
    );
  }

  const environment = await resolveActiveEnvironment();
  const key = cacheKey(environment, attr);
  const ttl = Number(ELRYAN_ATTRIBUTE_VALUE_LIST_CACHE_TTL_MS) || 60_000;
  const cached = listCache.get(key);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ttl) {
    return {
      environment,
      attribute: attr,
      rows: cached.rows,
      total: cached.rows.length,
      cacheHit: true,
      fetchedAt: cached.fetchedAt,
    };
  }

  const result = await elryanAuthedRead(ELRYAN_PATHS.attributeValuesListByAttribute(attr), {
    query: {},
    retries: 1,
  });
  if (!result.ok) {
    const formatted = formatElryanReadError(result);
    throw new ElryanClientError(formatted.message, {
      status: result.httpStatus >= 400 && result.httpStatus < 600 ? result.httpStatus : 502,
      code: formatted.code || "elryan_read_failed",
      classification: "READ",
      httpStatus: result.httpStatus,
    });
  }

  const rawRows = asList(result.json);
  const rows = normalizeElryanAttributeValueList(rawRows).filter((row) => row.idVerified);
  listCache.set(key, { fetchedAt: Date.now(), environment, attribute: attr, rows });

  return {
    environment,
    attribute: attr,
    rows,
    total: rows.length,
    cacheHit: false,
    fetchedAt: Date.now(),
  };
}

function filterRows(rows, { q = "", id = "" } = {}) {
  const needle = normalizeElryanAttributeName(q);
  const idNeedle = String(id || "").trim();
  let out = rows;
  if (idNeedle) {
    out = out.filter((row) => String(row.verifiedId) === idNeedle);
  }
  if (needle) {
    out = out.filter((row) => {
      const hay = `${normalizeElryanAttributeName(row.name)} ${normalizeElryanAttributeName(row.nameAr)} ${row.verifiedId}`;
      return hay.includes(needle);
    });
  }
  return out;
}

/**
 * Search + paginate over the authenticated Brand/Color list catalog.
 */
export async function searchElryanAttributeValueCatalog({
  attribute = "Brand",
  q = "",
  id = "",
  page = 1,
  limit = 30,
  forceRefresh = false,
} = {}) {
  const catalog = await loadElryanAttributeValueList(attribute, { forceRefresh });
  const filtered = filterRows(catalog.rows, { q, id });
  const pageNum = Math.max(1, Number(page) || 1);
  const take = Math.min(100, Math.max(1, Number(limit) || 30));
  const offset = (pageNum - 1) * take;
  const values = filtered.slice(offset, offset + take).map((row) => ({
    ...row,
    attribute: catalog.attribute,
  }));

  return {
    classification: "READ",
    environment: catalog.environment,
    attribute: catalog.attribute,
    values,
    page: pageNum,
    limit: take,
    total: filtered.length,
    catalogTotal: catalog.total,
    idsAvailable: true,
    verifiedIdCount: values.filter((v) => v.idVerified).length,
    nameOnlyCount: 0,
    cacheHit: catalog.cacheHit,
    meta: {
      page: pageNum,
      limit: take,
      total: filtered.length,
      catalogTotal: catalog.total,
      environment: catalog.environment,
    },
    note: undefined,
  };
}

/**
 * Verify value id against authenticated list catalog (exact id; optional name).
 * Does not use /attribute-values/id/{id} (404 for real Brand ids such as 10104).
 */
export async function verifyElryanAttributeValueFromList({
  attribute = "Brand",
  valueId,
  name,
  requireName = false,
  forceRefresh = false,
} = {}) {
  let catalog;
  try {
    catalog = await loadElryanAttributeValueList(attribute, { forceRefresh });
  } catch (err) {
    throw new ElryanClientError(
      err?.message || "Failed to load Elryan attribute catalog for verification. Save remains blocked.",
      {
        status: Number(err?.status) || 502,
        code: err?.code || "catalog_unavailable",
        classification: "READ",
      }
    );
  }

  if (!catalog.rows.length) {
    throw new ElryanClientError("Elryan attribute catalog was empty. Save remains blocked.", {
      status: 502,
      code: "catalog_empty",
      classification: "READ",
    });
  }

  const result = verifyElryanCatalogIdAndName({
    rows: catalog.rows,
    valueId,
    name,
    requireName,
  });

  if (!result.ok) {
    throw new ElryanClientError(result.message, {
      status: 400,
      code: result.code,
      classification: "READ",
      details: result.value ? { foundName: result.value.name, foundId: result.value.verifiedId } : undefined,
    });
  }

  return {
    ok: true,
    environment: catalog.environment,
    attribute: catalog.attribute,
    value: result.value,
    cacheHit: catalog.cacheHit,
    verifiedAgainst: "attribute_values_list",
  };
}

export function peekElryanAttributeValueListCacheForTests(environment, attribute) {
  return listCache.get(cacheKey(environment, normalizeAttributeName(attribute))) || null;
}

export { normalizeElryanAttributeValueRow };
