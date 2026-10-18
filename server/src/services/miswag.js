import { getMongoMode } from "../utils/dbMode.js";
import { decryptApiKey, encryptApiKey } from "../utils/partnerAuth.js";
import { MiswagConnection } from "../models/MiswagConnection.js";

export const MISWAG_PARTNER = "miswag";
export const MISWAG_DEFAULT_BASE_URL = "https://seller-api.miswag.com";
export const MISWAG_HEALTHCHECK_PATH = "/v1/healthcheck";
export const MISWAG_CATEGORIES_FLAT_PATH = "/v1/categories/flat";
export const MISWAG_BRANDS_SEARCH_PATH = "/v1/brands/search";
export const MISWAG_AUTH_HEADERS = Object.freeze({
  apiKey: "X-API-Key",
  apiSecret: "X-API-Secret",
});

const DEFAULT_TIMEOUT_MS = 30000;
const KEEP_SECRET = "__keep__";

let fetchImpl = globalThis.fetch.bind(globalThis);

/** @param {typeof fetch} [fn] Test helper to stub outbound HTTP. */
export function setMiswagFetch(fn) {
  fetchImpl = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

export class MiswagError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MiswagError";
    this.status = Number(details.status) || 0;
    this.errors = Array.isArray(details.errors) ? details.errors : [];
    this.retryAfter = Number(details.retryAfter) || 0;
    this.eventId = details.eventId || "";
    this.transient = Boolean(details.transient);
    this.code = details.code || "";
    this.method = details.method || "";
    this.endpoint = details.endpoint || "";
    this.operation = details.operation || "";
  }
}

/** Strip query string for safe diagnostics (never log secrets). */
export function miswagPathOnly(urlOrPath) {
  const raw = String(urlOrPath || "");
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).pathname || raw;
  } catch {
    // fall through
  }
  return raw.split("?")[0] || raw;
}

function envValue(name) {
  return String(process.env[name] || "").trim();
}

export function sanitizeMiswagText(message, secrets = []) {
  let text = String(message || "");
  for (const secret of secrets) {
    const value = String(secret || "");
    if (value.length >= 4) text = text.split(value).join("[redacted]");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

export function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 8) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 8)}…`;
}

export function validateMiswagBaseUrl(raw) {
  const value = String(raw || "").trim().replace(/\/$/, "");
  if (!value) {
    return { ok: false, message: "Base URL is required." };
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Base URL is not a valid URL." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, message: "Base URL must use http or https." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Base URL must not include credentials." };
  }
  return { ok: true, baseUrl: `${url.origin}${url.pathname}`.replace(/\/$/, "") || url.origin };
}

async function loadStoredConnection(withSecrets = false) {
  const query = MiswagConnection.findOne({ singletonKey: "default" });
  if (withSecrets) query.select("+apiKeyEnc +apiSecretEnc");
  return query.lean();
}

function decryptStored(enc) {
  if (!enc) return "";
  try {
    return decryptApiKey(enc);
  } catch {
    return "";
  }
}

/**
 * Resolve Miswag credentials from env (preferred) then admin-saved store.
 * Optional overrides are used for unsaved Test Connection attempts.
 */
export async function resolveMiswagConfig(overrides = {}) {
  const stored = await loadStoredConnection(true);
  const envBase = envValue("MISWAG_BASE_URL");
  const envKey = envValue("MISWAG_API_KEY");
  const envSecret = envValue("MISWAG_API_SECRET");

  const storedKey = decryptStored(stored?.apiKeyEnc);
  const storedSecret = decryptStored(stored?.apiSecretEnc);

  const baseCandidate =
    overrides.baseUrl != null && String(overrides.baseUrl).trim()
      ? String(overrides.baseUrl).trim()
      : envBase || stored?.baseUrl || MISWAG_DEFAULT_BASE_URL;
  const validated = validateMiswagBaseUrl(baseCandidate);
  const baseUrl = validated.ok ? validated.baseUrl : MISWAG_DEFAULT_BASE_URL;

  let apiKey =
    overrides.apiKey != null && String(overrides.apiKey).trim() && overrides.apiKey !== KEEP_SECRET
      ? String(overrides.apiKey).trim()
      : envKey || storedKey || "";
  let apiSecret =
    overrides.apiSecret != null && String(overrides.apiSecret).trim() && overrides.apiSecret !== KEEP_SECRET
      ? String(overrides.apiSecret).trim()
      : envSecret || storedSecret || "";

  if (overrides.apiKey === KEEP_SECRET) apiKey = envKey || storedKey || "";
  if (overrides.apiSecret === KEEP_SECRET) apiSecret = envSecret || storedSecret || "";

  return {
    baseUrl,
    apiKey,
    apiSecret,
    sources: {
      baseUrl: envBase ? "env" : stored?.baseUrl ? "stored" : "default",
      apiKey: envKey ? "env" : storedKey ? "stored" : "none",
      apiSecret: envSecret ? "env" : storedSecret ? "stored" : "none",
    },
    envLocked: {
      baseUrl: Boolean(envBase),
      apiKey: Boolean(envKey),
      apiSecret: Boolean(envSecret),
    },
    stored: Boolean(stored),
  };
}

export function miswagConfiguredFromParts({ apiKey, apiSecret }) {
  return Boolean(String(apiKey || "").trim() && String(apiSecret || "").trim());
}

export async function miswagConfigured() {
  const config = await resolveMiswagConfig();
  return miswagConfiguredFromParts(config);
}

export function connectionStatusLabel({ configured, lastStatus, authOk }) {
  if (!configured) return "not_configured";
  if (lastStatus === "connected" && authOk) return "connected";
  if (lastStatus === "auth_failed") return "auth_failed";
  if (
    lastStatus === "server_error" ||
    lastStatus === "network_error" ||
    lastStatus === "rate_limited"
  ) {
    return lastStatus;
  }
  if (lastStatus === "not_found" || lastStatus === "forbidden") return lastStatus;
  if (lastStatus === "testing") return "testing";
  if (lastStatus) return lastStatus;
  return "not_configured";
}

function publicStatusFromDoc(doc, config) {
  const configured = miswagConfiguredFromParts(config);
  const lastStatus = String(doc?.lastStatus || (configured ? "not_configured" : "not_configured"));
  const authOk = Boolean(doc?.lastAuthOk) && lastStatus === "connected";
  const status = connectionStatusLabel({
    configured,
    lastStatus: configured ? lastStatus : "not_configured",
    authOk,
  });
  return {
    partner: MISWAG_PARTNER,
    status: configured ? status : "not_configured",
    configured,
    syncEnabled: status === "connected",
    bulkActionsEnabled: status === "connected",
    baseUrl: config.baseUrl,
    apiKeyPrefix: config.apiKey ? maskApiKey(config.apiKey) : doc?.apiKeyPrefix || "",
    hasApiKey: Boolean(config.apiKey),
    hasApiSecret: Boolean(config.apiSecret),
    secretSet: Boolean(config.apiSecret),
    envLocked: config.envLocked,
    sources: config.sources,
    healthcheckPath: MISWAG_HEALTHCHECK_PATH,
    headers: { ...MISWAG_AUTH_HEADERS },
    diagnostics: {
      baseUrl: doc?.lastBaseUrl || config.baseUrl,
      endpoint: doc?.lastEndpoint || MISWAG_HEALTHCHECK_PATH,
      httpStatus: Number(doc?.lastHttpStatus) || 0,
      responseMs: Number(doc?.lastResponseMs) || 0,
      authOk: Boolean(doc?.lastAuthOk),
      error: sanitizeMiswagText(doc?.lastError || "", [config.apiKey, config.apiSecret]),
      testedAt: doc?.lastTestedAt || null,
      connectedAt: doc?.connectedAt || null,
    },
    credentialCreation:
      "No official Miswag API for creating API Key/Secret was found. Create credentials in the Miswag seller dashboard, then paste them here or set MISWAG_API_KEY / MISWAG_API_SECRET.",
    persistence: {
      mongoMode: getMongoMode(),
      temporary:
        getMongoMode() === "memory"
          ? "Local MongoDB Memory Server is in use. Miswag credentials, sync jobs, and barcodes are temporary and are lost on server restart."
          : "",
    },
  };
}

export async function getMiswagConnectionPublic() {
  const config = await resolveMiswagConfig();
  const stored = await loadStoredConnection(false);
  return publicStatusFromDoc(stored, config);
}

export async function saveMiswagConnection(input = {}) {
  const existing = await MiswagConnection.findOne({ singletonKey: "default" }).select(
    "+apiKeyEnc +apiSecretEnc"
  );
  const envBase = envValue("MISWAG_BASE_URL");
  const envKey = envValue("MISWAG_API_KEY");
  const envSecret = envValue("MISWAG_API_SECRET");

  let baseUrl = existing?.baseUrl || "";
  if (input.baseUrl != null) {
    const validated = validateMiswagBaseUrl(input.baseUrl);
    if (!validated.ok) {
      throw new MiswagError(validated.message, { status: 400, code: "invalid_base_url" });
    }
    if (!envBase) baseUrl = validated.baseUrl;
  } else if (!baseUrl && !envBase) {
    baseUrl = MISWAG_DEFAULT_BASE_URL;
  }

  let apiKeyEnc = existing?.apiKeyEnc || "";
  let apiSecretEnc = existing?.apiSecretEnc || "";
  let apiKeyPrefix = existing?.apiKeyPrefix || "";
  let hasApiKey = Boolean(existing?.hasApiKey);
  let hasApiSecret = Boolean(existing?.hasApiSecret);

  if (input.apiKey != null && String(input.apiKey).trim() && !envKey) {
    const key = String(input.apiKey).trim();
    apiKeyEnc = encryptApiKey(key);
    apiKeyPrefix = maskApiKey(key);
    hasApiKey = true;
  }

  if (input.apiSecret != null && String(input.apiSecret).trim() && !envSecret) {
    const secret = String(input.apiSecret).trim();
    apiSecretEnc = encryptApiKey(secret);
    hasApiSecret = true;
  }

  const credentialsChanged =
    (input.apiKey != null && String(input.apiKey).trim() && !envKey) ||
    (input.apiSecret != null && String(input.apiSecret).trim() && !envSecret) ||
    (input.baseUrl != null && String(input.baseUrl).trim() && !envBase);

  const doc = await MiswagConnection.findOneAndUpdate(
    { singletonKey: "default" },
    {
      $set: {
        singletonKey: "default",
        baseUrl: envBase ? existing?.baseUrl || "" : baseUrl,
        apiKeyEnc,
        apiSecretEnc,
        apiKeyPrefix,
        hasApiKey: hasApiKey || Boolean(envKey),
        hasApiSecret: hasApiSecret || Boolean(envSecret),
        ...(credentialsChanged
          ? {
              lastStatus: "not_configured",
              lastAuthOk: false,
              lastError: "",
              connectedAt: null,
            }
          : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const config = await resolveMiswagConfig();
  if (!miswagConfiguredFromParts(config)) {
    doc.lastStatus = "not_configured";
    doc.lastAuthOk = false;
    doc.connectedAt = null;
    await doc.save();
  }

  return getMiswagConnectionPublic();
}

function errorList(body) {
  const raw = body?.errors;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => sanitizeMiswagText(typeof item === "string" ? item : item?.message || ""))
    .filter(Boolean);
}

function retryAfterSeconds(response) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  // Respect Retry-After including 0; default only when header is missing/invalid.
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  return 60;
}

function classifyHttpStatus(status) {
  if (status === 401) return "auth_failed";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 200 && status <= 202) return "connected";
  return "server_error";
}

function userMessageForStatus(status, detail) {
  if (status === 200 || (status >= 200 && status <= 202)) return "Connected successfully";
  if (status === 401) return "Authentication failed — API Key or Secret was rejected";
  if (status === 403) return "Credentials are valid but access is not permitted";
  if (status === 404) return "Endpoint/Base URL may be incorrect";
  if (status === 429) return "Miswag rate limit reached";
  if (status >= 500) return "Miswag server error";
  return detail || `Miswag request failed (${status})`;
}

function statusError(status, body, response, secrets) {
  const errors = errorList(body).map((item) => sanitizeMiswagText(item, secrets));
  const eventId = sanitizeMiswagText(body?.event_id || "", secrets);
  const detail = sanitizeMiswagText(errors[0] || body?.message || "", secrets);
  const code = classifyHttpStatus(status);

  if (status === 401) {
    return new MiswagError(userMessageForStatus(401), { status, errors, code });
  }
  if (status === 403) {
    return new MiswagError(userMessageForStatus(403, detail), { status, errors, code });
  }
  if (status === 404) {
    return new MiswagError(userMessageForStatus(404, detail), { status, errors, code });
  }
  if (status === 409) {
    return new MiswagError(detail || "Miswag reported a duplicate or conflict.", {
      status,
      errors,
      code: "conflict",
    });
  }
  if (status === 422) {
    return new MiswagError(detail || "Miswag rejected the submitted data.", {
      status,
      errors,
      code: "validation_error",
    });
  }
  if (status === 429) {
    return new MiswagError(userMessageForStatus(429), {
      status,
      errors,
      retryAfter: retryAfterSeconds(response),
      transient: true,
      code,
    });
  }
  if (status >= 500) {
    const suffix = eventId ? ` Event ${eventId}.` : "";
    return new MiswagError(`${userMessageForStatus(status)}${suffix}`, {
      status,
      errors,
      eventId,
      transient: true,
      code,
    });
  }
  return new MiswagError(detail || `Miswag request failed (${status}).`, { status, errors, code });
}

export function isAllowedMiswagUrl(url, baseUrl) {
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function buildMiswagAuthHeaders(apiKey, apiSecret) {
  return {
    Accept: "application/json",
    [MISWAG_AUTH_HEADERS.apiKey]: apiKey,
    [MISWAG_AUTH_HEADERS.apiSecret]: apiSecret,
  };
}

/**
 * Central Miswag HTTP client. All Miswag API calls must go through this.
 */
export async function miswagRequest(path, options = {}) {
  const config = options.config || (await resolveMiswagConfig(options.credentialOverrides));
  const { baseUrl, apiKey, apiSecret } = config;
  const secrets = [apiKey, apiSecret];
  const method = String(options.method || "GET").toUpperCase();
  const endpoint = miswagPathOnly(path);
  const operation = options.operation || `${method} ${endpoint}`;

  if (!apiKey || !apiSecret) {
    throw new MiswagError("Miswag is not configured. Set API Key and API Secret.", {
      status: 400,
      code: "not_configured",
      method,
      endpoint,
      operation,
    });
  }

  const url = /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  if (!isAllowedMiswagUrl(url, baseUrl)) {
    throw new MiswagError("Miswag request URL is outside the configured API host.", {
      status: 400,
      code: "invalid_url",
      method,
      endpoint,
      operation,
    });
  }

  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    ...buildMiswagAuthHeaders(apiKey, apiSecret),
    ...(options.headers || {}),
  };
  if (options.body != null) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: options.body != null ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    const timeout = err?.name === "AbortError";
    const safe = sanitizeMiswagText(
      timeout ? "Miswag request timed out." : err?.message || "Miswag network request failed.",
      secrets
    );
    throw new MiswagError(safe, {
      status: 0,
      transient: true,
      code: timeout ? "timeout" : "network_error",
      method,
      endpoint,
      operation,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: sanitizeMiswagText(text, secrets) };
    }
  }

  if (response.status < 200 || response.status > 202) {
    const err = statusError(response.status, body, response, secrets);
    err.method = method;
    err.endpoint = endpoint;
    err.operation = operation;
    if ((response.status === 401 || response.status === 403) && options.skipAuthMark !== true) {
      try {
        await markMiswagAuthFailed({
          method,
          endpoint,
          httpStatus: response.status,
          operation,
          message: err.message,
        });
      } catch {
        // diagnostics must not hide the original auth failure
      }
    }
    throw err;
  }

  return {
    status: response.status,
    message: sanitizeMiswagText(body?.message || "", secrets),
    data: body?.data ?? body,
    body,
    requestId: response.headers.get("request-id") || "",
    method,
    endpoint,
    operation,
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function miswagRequestWithRetry(path, options = {}, retries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await miswagRequest(path, options);
    } catch (err) {
      const retryable =
        err instanceof MiswagError &&
        err.transient &&
        err.status !== 401 &&
        err.status !== 403 &&
        err.status !== 422;
      if (!retryable || attempt >= retries) throw err;
      const retryAfter = Number(err.retryAfter);
      const wait =
        err.status === 429
          ? Math.min(
              (Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 60) * 1000,
              120000
            )
          : Math.min(1000 * 2 ** attempt, 30000);
      await sleep(wait);
      attempt += 1;
    }
  }
}

export function healthCheck(options = {}) {
  return miswagRequest(MISWAG_HEALTHCHECK_PATH, {
    ...options,
    method: "HEAD",
    operation: options.operation || "HEAD /v1/healthcheck",
  });
}

/** Lookup by Miswag/BrownStore external_id (not by SKU). 404 → null. */
export async function getItem(externalId, options = {}) {
  const id = String(externalId || "").trim();
  if (!id) {
    throw new MiswagError("Miswag external_id is required.", { status: 400, code: "missing_external_id" });
  }
  try {
    return await miswagRequest(`/v1/items/${encodeURIComponent(id)}`, options);
  } catch (err) {
    if (err instanceof MiswagError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Create or upsert an item. Prior Miswag seller client used POST /v1/items/bulk-create
 * with a single item object body (upsert keyed by external_id).
 */
export function createOrUpdateItem(payload, options = {}) {
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : 3;
  const { retries: _ignored, ...reqOptions } = options;
  return miswagRequestWithRetry(
    "/v1/items/bulk-create",
    {
      method: "POST",
      body: payload,
      timeoutMs: 60000,
      ...reqOptions,
    },
    retries
  );
}

export function searchBrands(query, url, options = {}) {
  const path =
    url ||
    `${MISWAG_BRANDS_SEARCH_PATH}?q=${encodeURIComponent(String(query || "").trim())}`;
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : 3;
  const { retries: _ignored, ...reqOptions } = options;
  return miswagRequestWithRetry(
    path,
    {
      ...reqOptions,
      operation: reqOptions.operation || "GET /v1/brands/search",
    },
    retries
  );
}

function categoryPageItems(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  const data = body.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  const buckets = [data, body].filter((item) => item && typeof item === "object" && !Array.isArray(item));
  const keys = ["content", "items", "categories", "results", "records", "list", "flat"];
  for (const bucket of buckets) {
    for (const key of keys) {
      if (Array.isArray(bucket[key])) return bucket[key];
    }
  }
  return [];
}

function categoryNextUrl(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const candidates = [
    body.data?.paging?.next_url,
    body.data?.paging?.nextUrl,
    body.paging?.next_url,
    body.paging?.nextUrl,
    body.data?.next_url,
    body.next_url,
  ];
  for (const value of candidates) {
    const url = String(value || "").trim();
    if (url) return url;
  }
  return "";
}

function formatCategoryPath(path) {
  if (Array.isArray(path)) {
    return path
      .map((segment) => {
        if (typeof segment === "string") return segment.trim();
        if (!segment || typeof segment !== "object") return "";
        return String(
          segment.name_en || segment.nameEn || segment.en || segment.name || segment.name_ar || segment.alias || ""
        ).trim();
      })
      .filter(Boolean)
      .join(" > ");
  }
  if (typeof path === "string") return path.trim();
  if (!path || typeof path !== "object") return "";
  return String(path.en || path.name_en || path.nameEn || path.ar || path.name || "").trim();
}

export function miswagCategoryLevel(externalId) {
  const id = String(externalId || "").trim();
  const match = id.match(/^(L[1-4])-/i);
  return match ? match[1].toUpperCase() : "";
}

/** Normalize a Miswag flat-category row (prior seller client contract). */
export function normalizeMiswagCategory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const externalId = String(raw.id ?? raw._id ?? raw.category_id ?? raw.external_id ?? "").trim();
  if (!externalId) return null;
  const active = raw.active !== false && raw.is_active !== false && raw.isActive !== false;
  const nameEn = String(raw.name_en || raw.nameEn || raw.name?.en || "").trim();
  const nameAr = String(raw.name_ar || raw.nameAr || raw.name?.ar || "").trim();
  return {
    id: externalId,
    alias: String(raw.alias || raw.slug || "").trim(),
    name: nameEn || nameAr || externalId,
    nameEn,
    nameAr,
    path: formatCategoryPath(raw.path || raw.category_path || raw.full_path || "").slice(0, 1000),
    level: miswagCategoryLevel(externalId),
    active,
  };
}

/**
 * List one page of Miswag categories.
 * Authenticated endpoint from prior seller client: GET /v1/categories/flat
 * No dedicated category-search or category-detail endpoint was found.
 */
export function fetchCategoryPage(url, options = {}) {
  const path = url || `${MISWAG_CATEGORIES_FLAT_PATH}?page%5Bsize%5D=30`;
  const retries = Number.isFinite(Number(options.retries)) ? Number(options.retries) : 1;
  const { retries: _ignored, ...reqOptions } = options;
  return miswagRequestWithRetry(
    path,
    {
      ...reqOptions,
      operation: reqOptions.operation || "GET /v1/categories/flat",
    },
    retries
  );
}

/**
 * Load Miswag L3/L4 categories for one sync run (in-memory only; not a mapping DB).
 * Caps pages for safety; returns every leaf-level row collected.
 */
export async function loadMiswagLeafCategories({ maxPages = 200 } = {}) {
  const pageCap = Math.min(400, Math.max(1, Number(maxPages) || 200));
  const byId = new Map();
  let url = `${MISWAG_CATEGORIES_FLAT_PATH}?page%5Bsize%5D=30`;
  let pages = 0;
  while (url && pages < pageCap) {
    pages += 1;
    const response = await fetchCategoryPage(url, { retries: 1 });
    const rows = categoryPageItems(response.data || response.body);
    for (const raw of rows) {
      const category = normalizeMiswagCategory(raw);
      if (!category) continue;
      if (category.level !== "L3" && category.level !== "L4") continue;
      if (category.active === false) continue;
      byId.set(category.id, category);
    }
    const next = categoryNextUrl(response.body || response.data || {});
    if (!next) break;
    const { baseUrl } = await resolveMiswagConfig();
    if (!isAllowedMiswagUrl(next, baseUrl) && !String(next).startsWith("/")) break;
    url = String(next);
  }
  return {
    endpoint: MISWAG_CATEGORIES_FLAT_PATH,
    pagesScanned: pages,
    categories: [...byId.values()],
  };
}

/**
 * Live category finder for Sync 1 Product only.
 * Pages /v1/categories/flat and filters in memory — does not cache or map permanently.
 */
export async function findMiswagCategories({ q = "", limit = 20, maxPages = 15 } = {}) {
  const term = String(q || "").trim().toLowerCase();
  const size = Math.min(50, Math.max(1, Number(limit) || 20));
  const pageCap = Math.min(40, Math.max(1, Number(maxPages) || 15));
  const matches = [];
  const seen = new Set();
  let url = `${MISWAG_CATEGORIES_FLAT_PATH}?page%5Bsize%5D=30`;
  let pages = 0;
  let scanned = 0;

  while (url && pages < pageCap && matches.length < size) {
    pages += 1;
    const response = await fetchCategoryPage(url, { retries: 1 });
    const rows = categoryPageItems(response.data || response.body);
    scanned += rows.length;
    for (const raw of rows) {
      const category = normalizeMiswagCategory(raw);
      if (!category || seen.has(category.id)) continue;
      seen.add(category.id);
      if (term) {
        const hay = [category.id, category.alias, category.nameEn, category.nameAr, category.path]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(term)) continue;
      }
      // Prefer selectable L3/L4 IDs used by product create.
      if (category.level && category.level !== "L3" && category.level !== "L4") continue;
      matches.push(category);
      if (matches.length >= size) break;
    }
    const next = categoryNextUrl(response.body || response.data || {});
    if (!next) break;
    const { baseUrl } = await resolveMiswagConfig();
    if (!isAllowedMiswagUrl(next, baseUrl) && !String(next).startsWith("/")) break;
    url = String(next);
  }

  return {
    endpoint: MISWAG_CATEGORIES_FLAT_PATH,
    searchEndpoint: null,
    detailEndpoint: null,
    note:
      "Miswag exposes authenticated GET /v1/categories/flat (paginated). No dedicated category search/detail endpoint was found in the prior seller client.",
    q: term,
    pagesScanned: pages,
    categoriesScanned: scanned,
    categories: matches,
  };
}

export function normalizeMiswagBrand(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = Number(raw.id ?? raw.brand_id ?? raw.external_id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return {
    id,
    name: String(raw.name || raw.name_en || raw.label || "").trim(),
    alias: String(raw.alias || raw.slug || "").trim(),
  };
}

/** Live brand finder via GET /v1/brands/search?q=... for Sync 1 Product only. */
export async function findMiswagBrands({ q = "", limit = 20 } = {}) {
  const term = String(q || "").trim();
  if (term.length < 1) {
    return {
      endpoint: MISWAG_BRANDS_SEARCH_PATH,
      q: term,
      brands: [],
      note: "Enter a brand name to search Miswag.",
    };
  }
  const size = Math.min(50, Math.max(1, Number(limit) || 20));
  const response = await searchBrands(term, undefined, { retries: 1 });
  const content = Array.isArray(response.data?.content)
    ? response.data.content
    : Array.isArray(response.data)
      ? response.data
      : [];
  const brands = [];
  const seen = new Set();
  for (const raw of content) {
    const brand = normalizeMiswagBrand(raw);
    if (!brand || seen.has(brand.id)) continue;
    seen.add(brand.id);
    brands.push(brand);
    if (brands.length >= size) break;
  }
  return {
    endpoint: MISWAG_BRANDS_SEARCH_PATH,
    q: term,
    brands,
    note: "Results from GET /v1/brands/search. Selection is temporary for Sync 1 Product only.",
  };
}

async function persistDiagnostics(patch) {
  await MiswagConnection.findOneAndUpdate(
    { singletonKey: "default" },
    { $set: { singletonKey: "default", ...patch } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Clear Connected state when any authenticated Miswag call gets 401/403.
 * Prevents a stale Connected badge after healthcheck-only success or lost credentials.
 */
export async function markMiswagAuthFailed({
  method = "",
  endpoint = "",
  httpStatus = 401,
  operation = "",
  message = "",
} = {}) {
  const endpointPath = miswagPathOnly(endpoint);
  const detail =
    sanitizeMiswagText(message) ||
    userMessageForStatus(httpStatus === 403 ? 403 : 401);
  const op = operation || `${method || "GET"} ${endpointPath}`.trim();
  await persistDiagnostics({
    lastStatus: httpStatus === 403 ? "forbidden" : "auth_failed",
    lastHttpStatus: httpStatus,
    lastEndpoint: endpointPath || MISWAG_HEALTHCHECK_PATH,
    lastResponseMs: 0,
    lastAuthOk: false,
    lastError: `${detail}${op ? ` (${op})` : ""}`.slice(0, 500),
    lastTestedAt: new Date(),
    connectedAt: null,
  });
  await logMiswagSafe("auth-failed", {
    method,
    endpoint: endpointPath,
    httpStatus,
    operation: op,
  });
}

export async function testMiswagConnection(input = {}) {
  const started = Date.now();
  const overrides = {};
  if (input.baseUrl != null && String(input.baseUrl).trim()) overrides.baseUrl = input.baseUrl;
  if (input.apiKey != null && String(input.apiKey).trim()) overrides.apiKey = input.apiKey;
  if (input.apiSecret != null && String(input.apiSecret).trim()) {
    overrides.apiSecret = input.apiSecret;
  }

  // Persist form credentials before probing so Preview/Sync reuse the same stored keys.
  // Env-locked values are ignored inside saveMiswagConnection.
  if (overrides.apiKey || overrides.apiSecret || overrides.baseUrl) {
    try {
      await saveMiswagConnection({
        baseUrl: overrides.baseUrl,
        apiKey: overrides.apiKey,
        apiSecret: overrides.apiSecret,
      });
    } catch (err) {
      if (err instanceof MiswagError && err.code === "invalid_base_url") throw err;
      // Continue with overrides for this probe if save is unavailable.
    }
  }

  const baseCheck = validateMiswagBaseUrl(
    overrides.baseUrl || envValue("MISWAG_BASE_URL") || (await loadStoredConnection())?.baseUrl || MISWAG_DEFAULT_BASE_URL
  );
  if (!baseCheck.ok) {
    const diagnostics = {
      baseUrl: String(overrides.baseUrl || ""),
      endpoint: MISWAG_HEALTHCHECK_PATH,
      httpStatus: 0,
      responseMs: Date.now() - started,
      authOk: false,
      error: baseCheck.message,
    };
    await persistDiagnostics({
      lastStatus: "not_configured",
      lastHttpStatus: 0,
      lastEndpoint: MISWAG_HEALTHCHECK_PATH,
      lastBaseUrl: diagnostics.baseUrl,
      lastResponseMs: diagnostics.responseMs,
      lastAuthOk: false,
      lastError: baseCheck.message,
      lastTestedAt: new Date(),
      connectedAt: null,
    });
    return {
      ok: false,
      status: "not_configured",
      message: baseCheck.message,
      httpStatus: 0,
      syncEnabled: false,
      diagnostics,
      connection: await getMiswagConnectionPublic(),
    };
  }

  const config = await resolveMiswagConfig(overrides);
  if (!config.apiKey) {
    const message = "API Key is required.";
    await persistDiagnostics({
      lastStatus: "not_configured",
      lastHttpStatus: 0,
      lastEndpoint: MISWAG_HEALTHCHECK_PATH,
      lastBaseUrl: config.baseUrl,
      lastResponseMs: Date.now() - started,
      lastAuthOk: false,
      lastError: message,
      lastTestedAt: new Date(),
      connectedAt: null,
    });
    return {
      ok: false,
      status: "not_configured",
      message,
      httpStatus: 0,
      syncEnabled: false,
      diagnostics: {
        baseUrl: config.baseUrl,
        endpoint: MISWAG_HEALTHCHECK_PATH,
        httpStatus: 0,
        responseMs: Date.now() - started,
        authOk: false,
        error: message,
      },
      connection: await getMiswagConnectionPublic(),
    };
  }
  if (!config.apiSecret) {
    const message = "API Secret is required.";
    await persistDiagnostics({
      lastStatus: "not_configured",
      lastHttpStatus: 0,
      lastEndpoint: MISWAG_HEALTHCHECK_PATH,
      lastBaseUrl: config.baseUrl,
      lastResponseMs: Date.now() - started,
      lastAuthOk: false,
      lastError: message,
      lastTestedAt: new Date(),
      connectedAt: null,
    });
    return {
      ok: false,
      status: "not_configured",
      message,
      httpStatus: 0,
      syncEnabled: false,
      diagnostics: {
        baseUrl: config.baseUrl,
        endpoint: MISWAG_HEALTHCHECK_PATH,
        httpStatus: 0,
        responseMs: Date.now() - started,
        authOk: false,
        error: message,
      },
      connection: await getMiswagConnectionPublic(),
    };
  }

  try {
    // HEAD alone is not enough — some gateways accept healthcheck while rejecting authenticated GETs.
    const health = await healthCheck({
      config,
      timeoutMs: input.timeoutMs,
      operation: "test_connection_healthcheck",
    });
    const probePath = `${MISWAG_CATEGORIES_FLAT_PATH}?page%5Bsize%5D=1`;
    const probe = await fetchCategoryPage(probePath, {
      config,
      retries: 0,
      timeoutMs: input.timeoutMs,
      operation: "test_connection_categories",
    });
    const responseMs = Date.now() - started;
    await persistDiagnostics({
      lastStatus: "connected",
      lastHttpStatus: probe.status || health.status,
      lastEndpoint: MISWAG_CATEGORIES_FLAT_PATH,
      lastBaseUrl: config.baseUrl,
      lastResponseMs: responseMs,
      lastAuthOk: true,
      lastError: "",
      lastTestedAt: new Date(),
      connectedAt: new Date(),
      hasApiKey: true,
      hasApiSecret: true,
      apiKeyPrefix: maskApiKey(config.apiKey),
    });
    return {
      ok: true,
      status: "connected",
      message: userMessageForStatus(health.status),
      httpStatus: probe.status || health.status,
      syncEnabled: true,
      diagnostics: {
        baseUrl: config.baseUrl,
        endpoint: MISWAG_CATEGORIES_FLAT_PATH,
        healthcheckEndpoint: MISWAG_HEALTHCHECK_PATH,
        httpStatus: probe.status || health.status,
        responseMs,
        authOk: true,
        error: "",
        verifiedOperations: ["HEAD /v1/healthcheck", "GET /v1/categories/flat"],
      },
      connection: await getMiswagConnectionPublic(),
    };
  } catch (err) {
    const responseMs = Date.now() - started;
    const httpStatus = Number(err?.status) || 0;
    const code = err?.code || classifyHttpStatus(httpStatus) || "network_error";
    const status =
      code === "network_error" || code === "timeout"
        ? "network_error"
        : code === "not_configured"
          ? "not_configured"
          : classifyHttpStatus(httpStatus) === "connected"
            ? "server_error"
            : classifyHttpStatus(httpStatus) || "server_error";
    const failedEndpoint = err?.endpoint || MISWAG_HEALTHCHECK_PATH;
    const failedMethod = err?.method || "";
    const failedOperation = err?.operation || `${failedMethod} ${failedEndpoint}`.trim();
    const message = sanitizeMiswagText(err?.message || "Miswag connection failed.", [
      config.apiKey,
      config.apiSecret,
    ]);
    await persistDiagnostics({
      lastStatus: status === "auth_failed" ? "auth_failed" : status,
      lastHttpStatus: httpStatus,
      lastEndpoint: failedEndpoint,
      lastBaseUrl: config.baseUrl,
      lastResponseMs: responseMs,
      lastAuthOk: false,
      lastError: `${message}${failedOperation ? ` (${failedOperation})` : ""}`.slice(0, 500),
      lastTestedAt: new Date(),
      connectedAt: null,
    });
    return {
      ok: false,
      status: status === "auth_failed" ? "auth_failed" : status,
      message,
      httpStatus,
      syncEnabled: false,
      method: failedMethod,
      endpoint: failedEndpoint,
      operation: failedOperation,
      diagnostics: {
        baseUrl: config.baseUrl,
        endpoint: failedEndpoint,
        httpStatus,
        responseMs,
        authOk: false,
        error: message,
        operation: failedOperation,
      },
      connection: await getMiswagConnectionPublic(),
    };
  }
}

export async function miswagSyncAllowed() {
  const publicState = await getMiswagConnectionPublic();
  return publicState.syncEnabled === true;
}

export async function assertMiswagSyncAllowed() {
  if (!(await miswagSyncAllowed())) {
    throw new MiswagError("Miswag product sync is disabled until Test Connection succeeds.", {
      status: 403,
      code: "sync_disabled",
    });
  }
}

/** Safe console logging helper — never prints secrets. */
export function logMiswagSafe(label, details = {}) {
  const configPromise = resolveMiswagConfig();
  return configPromise.then((config) => {
    const safe = {
      ...details,
      message: sanitizeMiswagText(details.message, [config.apiKey, config.apiSecret]),
    };
    console.info(`[miswag] ${label}`, safe);
  });
}
