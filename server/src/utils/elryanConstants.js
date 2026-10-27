/** Official marketplace-api hosts only (not legacy merchant.elryan.com). */
export const ELRYAN_ENVIRONMENTS = Object.freeze({
  staging: {
    id: "staging",
    label: "Staging",
    baseUrl: "https://staging-marketplace-api.elryan.com/api",
    apiRoot: "https://staging-marketplace-api.elryan.com/api/v1",
  },
  production: {
    id: "production",
    label: "Production",
    baseUrl: "https://marketplace-api.elryan.com/api",
    apiRoot: "https://marketplace-api.elryan.com/api/v1",
  },
});

export const ELRYAN_DEFAULT_ENVIRONMENT = "staging";
export const ELRYAN_OFFICIAL_BASE_URLS = Object.freeze(
  Object.values(ELRYAN_ENVIRONMENTS).map((item) => item.baseUrl)
);

export const ELRYAN_DEFAULT_TIMEOUT_MS = 20000;
export const ELRYAN_SKU_MAX = 39;
export const ELRYAN_SKU_PATTERN = /^[A-Za-z0-9\-\/_]+$/;
export const ELRYAN_TITLE_MAX = 300;
export const ELRYAN_BATCH_MAX = 2500;

/** OpenAPI paths under server base (.../api). */
export const ELRYAN_PATHS = Object.freeze({
  healthCheck: "/v1/health-check",
  categories: "/v1/categories",
  categoryById: (id) => `/v1/categories/${encodeURIComponent(id)}`,
  categoryChildren: (id) => `/v1/categories/${encodeURIComponent(id)}/children`,
  categoryDescendants: (id) => `/v1/categories/${encodeURIComponent(id)}/descendants`,
  categoryAttributes: (id) => `/v1/categories/${encodeURIComponent(id)}/attributes`,
  attributeSetForCategory: (categoryId) =>
    `/v1/attribute-sets/category/${encodeURIComponent(categoryId)}`,
  attributeValues: "/v1/attribute-values",
  attributeValuesByAttribute: (attribute) =>
    `/v1/attribute-values/${encodeURIComponent(attribute)}`,
  /** Vendor Network catalog with real ids (not in all OpenAPI snapshots). */
  attributeValuesListByAttribute: (attribute) =>
    `/v1/attribute-values/${encodeURIComponent(attribute)}/list`,
  attributeValueById: (id) => `/v1/attribute-values/id/${encodeURIComponent(id)}`,
  commissions: "/v1/commissions",
  commissionsCalculate: "/v1/commissions/calculate",
  warranty: "/v1/warranty",
  products: "/v1/products",
  productById: (id) => `/v1/products/${encodeURIComponent(id)}`,
  skuExists: "/v1/products/sku-exists",
  batchCreate: "/v1/batch/product/create",
  batchUpdate: "/v1/batch/product/update",
  batchById: (id) => `/v1/batch/product/${encodeURIComponent(id)}`,
});

/** Short in-memory TTL for full Brand/Color list responses (per environment). */
export const ELRYAN_ATTRIBUTE_VALUE_LIST_CACHE_TTL_MS = 60_000;

/**
 * Product writes stay off unless explicitly set to the string "true".
 * Missing / any other value => disabled. Possession of an API key never enables writes.
 */
export function elryanProductWritesEnabled() {
  return String(process.env.ELRYAN_PRODUCT_WRITES_ENABLED || "").trim().toLowerCase() === "true";
}

export function elryanEnvironmentConfig(environment) {
  const key = String(environment || ELRYAN_DEFAULT_ENVIRONMENT).trim().toLowerCase();
  return ELRYAN_ENVIRONMENTS[key] || ELRYAN_ENVIRONMENTS[ELRYAN_DEFAULT_ENVIRONMENT];
}

export const ELRYAN_READINESS = Object.freeze({
  READY: "READY",
  NOT_READY: "NOT_READY",
  MISSING_MAPPING: "MISSING_MAPPING",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  PRICING_UNVERIFIED: "PRICING_UNVERIFIED",
  API_ACCESS_PENDING: "API_ACCESS_PENDING",
});

/** Phase 3 category catalog sync — staging reads only, admin-triggered. */
export const ELRYAN_CATALOG_SYNC = Object.freeze({
  PAGE_LIMIT: 50,
  MAX_PAGES: 200,
  MAX_RECORDS: 10000,
  CONCURRENCY: 1,
  MAX_429_RETRIES: 5,
  DEFAULT_429_WAIT_MS: 2000,
  MAX_429_WAIT_MS: 60000,
  ENVIRONMENT: "staging",
});

export const ELRYAN_MAPPING_CONFIDENCE = Object.freeze({
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
  NO_MATCH: "NO_MATCH",
  NEEDS_REVIEW: "NEEDS_REVIEW",
});

/** Mapping preview bounds — keep requests responsive with large catalogs. */
export const ELRYAN_MAPPING_PREVIEW = Object.freeze({
  DEFAULT_LIMIT: 40,
  MAX_LIMIT: 100,
  PRODUCT_SAMPLES_PER_COLLECTION: 6,
  /** Max collections scored per request (after cheap filters). */
  MAX_COLLECTIONS_SCORED: 120,
  /** Soft deadline; throw a clear timeout error if exceeded. */
  TIMEOUT_MS: 20000,
});
