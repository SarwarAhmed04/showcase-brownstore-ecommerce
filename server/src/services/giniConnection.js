import { decryptApiKey, encryptApiKey } from "../utils/partnerAuth.js";
import {
  GINI_CATEGORIES_PATH,
  GINI_PING_PATH,
  giniAuthHeaders,
  giniTimestampSeconds,
  signGiniRequest,
} from "../utils/giniSigner.js";
import { GiniConnection } from "../models/GiniConnection.js";
import { normalizeGiniCategories } from "../utils/giniCategoryTree.js";

export const GINI_DEFAULT_BASE_URL = "https://merchant.gini.iq";
export const GINI_OFFICIAL_HOSTS = Object.freeze(["merchant.gini.iq", "app.gini.iq"]);
export const GINI_HOST_UNVERIFIED_MESSAGE =
  "GINI host could not be verified. Try the alternate official host.";

const DEFAULT_TIMEOUT_MS = 20000;
const HOST_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

let fetchImpl = globalThis.fetch.bind(globalThis);

/** @param {typeof fetch | null} fn Test helper. Production uses global fetch. */
export function setGiniFetch(fn) {
  fetchImpl = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

export class GiniConnectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "GiniConnectionError";
    this.status = Number(details.status) || 400;
    this.code = details.code || "";
  }
}

export function alternateGiniBaseUrl(baseUrl) {
  const current = validateGiniBaseUrl(baseUrl);
  const host = current.ok ? new URL(current.baseUrl).hostname : "merchant.gini.iq";
  const next = host === "app.gini.iq" ? "merchant.gini.iq" : "app.gini.iq";
  return `https://${next}`;
}

export function validateGiniBaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: false, message: "Base URL is required." };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: "Base URL is not a valid URL." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, message: "Base URL must use HTTPS." };
  }
  if (url.username || url.password) {
    return { ok: false, message: "Base URL must not include credentials." };
  }
  if (url.port) {
    return { ok: false, message: "Base URL must not include a port." };
  }
  if (url.search || url.hash) {
    return { ok: false, message: "Base URL must not include a query or hash." };
  }
  if (url.pathname && url.pathname !== "/") {
    return { ok: false, message: "Base URL must be the host only." };
  }
  const host = url.hostname.toLowerCase();
  if (!GINI_OFFICIAL_HOSTS.includes(host)) {
    return {
      ok: false,
      message: "Base URL must be https://merchant.gini.iq or https://app.gini.iq.",
    };
  }
  return { ok: true, baseUrl: `https://${host}` };
}

export function sanitizeGiniText(message, secrets = [], maxLength = 300) {
  let text = String(message || "");
  const values = [...secrets]
    .map((secret) => String(secret || ""))
    .filter((secret) => secret.length >= 4)
    .sort((left, right) => right.length - left.length);
  for (const secret of values) text = text.split(secret).join("[redacted]");
  const limit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 300;
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}

function decryptStored(enc) {
  if (!enc) return "";
  try {
    return decryptApiKey(enc);
  } catch {
    return "";
  }
}

async function loadStored(withSecret = false) {
  const query = GiniConnection.findOne({ singletonKey: "default" });
  if (withSecret) query.select("+clientSecretEnc");
  return query.lean();
}

function configuredFrom(clientId, clientSecret) {
  return Boolean(String(clientId || "").trim() && String(clientSecret || "").trim());
}

export async function resolveGiniConfig(overrides = {}) {
  const stored = await loadStored(true);
  const storedSecret = decryptStored(stored?.clientSecretEnc);
  const baseCandidate =
    overrides.baseUrl != null && String(overrides.baseUrl).trim()
      ? String(overrides.baseUrl).trim()
      : stored?.baseUrl || GINI_DEFAULT_BASE_URL;
  const validated = validateGiniBaseUrl(baseCandidate);
  const clientId =
    overrides.clientId != null && String(overrides.clientId).trim()
      ? String(overrides.clientId).trim()
      : String(stored?.clientId || "").trim();
  const submittedSecret = overrides.clientSecret != null ? String(overrides.clientSecret).trim() : "";
  const clientSecret = submittedSecret || storedSecret;
  return {
    baseUrl: validated.ok ? validated.baseUrl : "",
    baseUrlError: validated.ok ? "" : validated.message,
    clientId,
    clientSecret,
    hasSecret: Boolean(clientSecret),
    stored: Boolean(stored),
  };
}

export async function getGiniConnectionPublic() {
  const stored = await loadStored(false);
  const baseUrl = stored?.baseUrl || GINI_DEFAULT_BASE_URL;
  const ready = Boolean(stored?.clientId && stored?.hasSecret);
  let status = String(stored?.lastStatus || "not_configured");
  if (!ready) status = "not_configured";
  else if (!status || status === "not_configured") status = "configured";
  return {
    baseUrl,
    clientId: stored?.clientId || "",
    hasSecret: Boolean(stored?.hasSecret),
    status,
    lastTestAt: stored?.lastTestedAt || null,
    lastSuccessAt: stored?.lastSuccessAt || null,
    officialHosts: GINI_OFFICIAL_HOSTS.map((host) => `https://${host}`),
    alternateHost: alternateGiniBaseUrl(baseUrl),
    lastHttpStatus: Number(stored?.lastHttpStatus) || 0,
    lastEndpoint: stored?.lastEndpoint || "",
    message: sanitizeGiniText(stored?.lastError || ""),
    categories:
      stored?.lastTestedAt && status === "connected"
        ? {
            ok: Boolean(stored.lastCategoriesOk),
            topLevelCount: Number(stored.lastCategoriesCount) || 0,
            subcategoryAccess: Boolean(stored.lastCategoriesOk),
            message: sanitizeGiniText(stored.lastCategoriesError || ""),
          }
        : null,
  };
}

export async function saveGiniConnection(input = {}) {
  const existing = await GiniConnection.findOne({ singletonKey: "default" }).select("+clientSecretEnc");
  const validated = validateGiniBaseUrl(
    input.baseUrl != null && String(input.baseUrl).trim() ? input.baseUrl : existing?.baseUrl || GINI_DEFAULT_BASE_URL
  );
  if (!validated.ok) {
    throw new GiniConnectionError(validated.message, { status: 400, code: "invalid_base_url" });
  }

  const clientId =
    input.clientId != null ? String(input.clientId).trim().slice(0, 200) : String(existing?.clientId || "");
  const submittedSecret = input.clientSecret != null ? String(input.clientSecret).trim() : "";
  let clientSecretEnc = existing?.clientSecretEnc || "";
  let hasSecret = Boolean(existing?.hasSecret);
  if (submittedSecret) {
    clientSecretEnc = encryptApiKey(submittedSecret.slice(0, 500));
    hasSecret = true;
  }

  const baseChanged = validated.baseUrl !== String(existing?.baseUrl || "");
  const idChanged = clientId !== String(existing?.clientId || "");
  const secretChanged = Boolean(submittedSecret);
  const credentialsChanged = baseChanged || idChanged || secretChanged;
  const ready = Boolean(clientId && hasSecret);

  const doc = await GiniConnection.findOneAndUpdate(
    { singletonKey: "default" },
    {
      $set: {
        singletonKey: "default",
        baseUrl: validated.baseUrl,
        clientId,
        clientSecretEnc,
        hasSecret,
        ...(credentialsChanged
          ? {
              lastStatus: ready ? "configured" : "not_configured",
              lastAuthOk: false,
              lastError: "",
              lastSuccessAt: null,
              lastHttpStatus: 0,
              lastEndpoint: "",
              lastCategoriesOk: false,
              lastCategoriesCount: 0,
              lastCategoriesError: "",
            }
          : {}),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  if (!ready) {
    doc.lastStatus = "not_configured";
    doc.lastAuthOk = false;
    doc.lastSuccessAt = null;
    await doc.save();
  }

  return getGiniConnectionPublic();
}

function errorCodeOf(err) {
  return String(err?.cause?.code || err?.code || "");
}

function isHostRoutingError(err) {
  const code = errorCodeOf(err);
  const message = String(err?.message || "");
  return HOST_ERROR_CODES.has(code) || /ENOTFOUND|ECONNREFUSED|getaddrinfo|EHOSTUNREACH/i.test(message);
}

function isTimeout(err) {
  const name = String(err?.name || "");
  const code = errorCodeOf(err);
  return name === "AbortError" || name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT";
}

function safeJson(text, contentType) {
  const trimmed = String(text || "").trim();
  const looksJson = /json/i.test(contentType) || trimmed.startsWith("{") || trimmed.startsWith("[");
  if (!looksJson) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isEdgeBlock(status, contentType, text) {
  if (status !== 403) return false;
  const html = /text\/html/i.test(String(contentType || "")) || /^\s*</.test(String(text || ""));
  if (!html) return false;
  return /cloudfront|request blocked/i.test(String(text || ""));
}

const DIAGNOSTIC_TEXT_LIMIT = 400;

function safeRequestId(response) {
  const raw = response?.headers?.get?.("x-request-id") || response?.headers?.get?.("X-Request-Id") || "";
  return String(raw)
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "")
    .slice(0, 64);
}

function readableDiagnosticText(text, contentType) {
  let value = String(text || "");
  const html = /text\/html/i.test(String(contentType || "")) || /^\s*</.test(value);
  if (html) {
    value = value
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  }
  return value
    .replace(/x-signature\s*[:=]\s*\S+/gi, " ")
    .replace(/x-api-key\s*[:=]\s*\S+/gi, " ")
    .replace(/cookie\s*[:=]\s*\S+/gi, " ");
}

function jsonDiagnosticText(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return "";
  if (typeof json.error === "string" && json.error.trim()) return json.error;
  if (typeof json.message === "string" && json.message.trim()) return json.message;
  return "";
}

function buildSafeBodySnippet(text, contentType, secrets) {
  return sanitizeGiniText(readableDiagnosticText(text, contentType), secrets, DIAGNOSTIC_TEXT_LIMIT);
}

function buildSafeErrorMessage(json, snippet, secrets) {
  const preferred = jsonDiagnosticText(json);
  return sanitizeGiniText(preferred || snippet || "", secrets, DIAGNOSTIC_TEXT_LIMIT);
}

function retryAfterSeconds(response) {
  const header = response?.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  return null;
}

async function giniGet(baseUrl, path, { clientId, clientSecret, timeoutMs }) {
  const timestamp = giniTimestampSeconds();
  const signed = signGiniRequest({
    method: "GET",
    path,
    body: "",
    timestamp,
    clientSecret,
  });
  const headers = giniAuthHeaders({
    clientId,
    signature: signed.signature,
    timestamp: signed.timestamp,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${signed.path}`, {
      method: "GET",
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
    const contentType = response.headers?.get?.("content-type") || "";
    const text = String(await response.text());
    return {
      response,
      status: Number(response.status) || 0,
      contentType,
      text: text.slice(0, 20000),
      json: safeJson(text, contentType),
      signedPath: signed.path,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Signed GINI request. Multipart callers must pass the form separately:
 * the signature always uses an empty body, matching the GINI file-upload rule.
 */
export async function performGiniRequest({
  method = "GET",
  path,
  query = "",
  form = null,
  extraHeaders = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = await resolveGiniConfig();
  if (!config.baseUrl || !config.clientId || !config.clientSecret) {
    throw new GiniConnectionError("Connect GINI API first", { status: 409, code: "connection_required" });
  }
  const verb = String(method || "GET").trim().toUpperCase();
  const signed = signGiniRequest({
    method: verb,
    path,
    body: "",
    timestamp: giniTimestampSeconds(),
    clientSecret: config.clientSecret,
  });
  const headers = {
    ...giniAuthHeaders({
      clientId: config.clientId,
      signature: signed.signature,
      timestamp: signed.timestamp,
    }),
    ...extraHeaders,
  };
  delete headers["Content-Type"];
  delete headers["content-type"];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.baseUrl}${signed.path}${query || ""}`, {
      method: signed.method,
      headers,
      body: verb === "GET" || verb === "DELETE" ? undefined : form || undefined,
      redirect: "manual",
      signal: controller.signal,
    });
    const contentType = response.headers?.get?.("content-type") || "";
    const text = String(await response.text());
    const status = Number(response.status) || 0;
    const json = safeJson(text, contentType);
    const secrets = [config.clientSecret, signed.signature, config.clientId];
    const safeBodySnippet = buildSafeBodySnippet(text, contentType, secrets);
    return {
      status,
      contentType,
      text: text.slice(0, 20000),
      json,
      signedPath: signed.path,
      requestId: safeRequestId(response),
      edgeBlocked: isEdgeBlock(status, contentType, text),
      safeErrorMessage: buildSafeErrorMessage(json, safeBodySnippet, secrets),
      safeBodySnippet,
    };
  } finally {
    clearTimeout(timer);
  }
}

function categorySummary(json) {
  const normalized = normalizeGiniCategories(json);
  if (!normalized.ok) {
    return {
      ok: false,
      topLevelCount: 0,
      subcategoryAccess: false,
      message: normalized.message || "Category response was not a category tree.",
    };
  }
  return {
    ok: true,
    topLevelCount: normalized.topLevelCount,
    subcategoryAccess: true,
    message: "",
  };
}

export async function fetchGiniCategoryTree() {
  const config = await resolveGiniConfig();
  const current = await getGiniConnectionPublic();
  if (current.status !== "connected" || !config.baseUrl || !config.clientId || !config.clientSecret) {
    return { connectionRequired: true, categories: [] };
  }
  const response = await giniGet(config.baseUrl, GINI_CATEGORIES_PATH, {
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  const normalized = normalizeGiniCategories(response.json);
  if (response.status !== 200 || !normalized.ok) {
    throw new GiniConnectionError("Could not load GINI categories.", {
      status: 400,
      code: "categories_unavailable",
    });
  }
  return { connectionRequired: false, categories: normalized.categories };
}

async function rememberTest(patch) {
  await GiniConnection.findOneAndUpdate(
    { singletonKey: "default" },
    { $set: { singletonKey: "default", ...patch } },
    { upsert: true, setDefaultsOnInsert: true }
  );
}

function resultPayload(fields) {
  return {
    ok: Boolean(fields.ok),
    status: fields.status,
    message: sanitizeGiniText(fields.message, fields.secrets),
    method: "GET",
    endpoint: fields.endpoint || GINI_PING_PATH,
    httpStatus: Number(fields.httpStatus) || 0,
    baseUrl: fields.baseUrl || "",
    alternateHost: fields.baseUrl ? alternateGiniBaseUrl(fields.baseUrl) : alternateGiniBaseUrl(GINI_DEFAULT_BASE_URL),
    retryAfter: fields.retryAfter ?? null,
    categories: fields.categories || null,
  };
}

export async function testGiniConnection(input = {}) {
  const config = await resolveGiniConfig({
    baseUrl: input.baseUrl,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
  });
  const secrets = [config.clientSecret];
  if (!config.baseUrl) {
    return resultPayload({
      ok: false,
      status: "connection_failed",
      message: config.baseUrlError || "Base URL is not an official GINI host.",
      httpStatus: 400,
      secrets,
    });
  }
  if (!configuredFrom(config.clientId, config.clientSecret)) {
    return resultPayload({
      ok: false,
      status: "not_configured",
      message: "Client ID and Client Secret are required before testing the connection.",
      baseUrl: config.baseUrl,
      secrets,
    });
  }

  const timeoutMs = Number(input.timeoutMs) > 0 ? Number(input.timeoutMs) : DEFAULT_TIMEOUT_MS;
  let ping;
  try {
    ping = await giniGet(config.baseUrl, GINI_PING_PATH, {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      timeoutMs,
    });
  } catch (err) {
    const hostProblem = isHostRoutingError(err);
    const timedOut = isTimeout(err);
    const status = hostProblem ? "host_unverified" : "connection_failed";
    const message = hostProblem
      ? GINI_HOST_UNVERIFIED_MESSAGE
      : timedOut
        ? "Connection failed. The GINI request timed out."
        : "Connection failed.";
    await rememberTest({
      lastStatus: status,
      lastAuthOk: false,
      lastError: message,
      lastHttpStatus: 0,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
      lastCategoriesOk: false,
      lastCategoriesCount: 0,
      lastCategoriesError: "",
    });
    return resultPayload({
      ok: false,
      status,
      message,
      baseUrl: config.baseUrl,
      httpStatus: 0,
      secrets,
    });
  }

  if (ping.status >= 300 && ping.status < 400) {
    await rememberTest({
      lastStatus: "host_unverified",
      lastAuthOk: false,
      lastError: GINI_HOST_UNVERIFIED_MESSAGE,
      lastHttpStatus: ping.status,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
    });
    return resultPayload({
      ok: false,
      status: "host_unverified",
      message: GINI_HOST_UNVERIFIED_MESSAGE,
      baseUrl: config.baseUrl,
      httpStatus: ping.status,
      secrets,
    });
  }

  if (isEdgeBlock(ping.status, ping.contentType, ping.text)) {
    const message = "GINI edge/request blocked.";
    await rememberTest({
      lastStatus: "edge_blocked",
      lastAuthOk: false,
      lastError: message,
      lastHttpStatus: ping.status,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
    });
    return resultPayload({
      ok: false,
      status: "edge_blocked",
      message,
      baseUrl: config.baseUrl,
      httpStatus: ping.status,
      secrets,
    });
  }

  if (ping.status === 404) {
    const message = `GET ${GINI_PING_PATH} was not available on this host. ${GINI_HOST_UNVERIFIED_MESSAGE}`;
    await rememberTest({
      lastStatus: "host_unverified",
      lastAuthOk: false,
      lastError: message,
      lastHttpStatus: 404,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
    });
    return resultPayload({
      ok: false,
      status: "host_unverified",
      message,
      baseUrl: config.baseUrl,
      httpStatus: 404,
      secrets,
    });
  }

  if (ping.status === 401 || ping.status === 403 || ping.status === 429 || ping.status >= 500) {
    const retryAfter = ping.status === 429 ? retryAfterSeconds(ping.response) : null;
    const mapped =
      ping.status === 401
        ? { status: "auth_failed", message: "Authentication failed." }
        : ping.status === 403
          ? { status: "forbidden", message: "Access forbidden / credentials not authorized." }
          : ping.status === 429
            ? {
                status: "rate_limited",
                message:
                  retryAfter == null
                    ? "Rate limited."
                    : `Rate limited. Wait ${retryAfter} seconds, then retry.`,
              }
            : { status: "server_error", message: "GINI service temporarily unavailable." };
    await rememberTest({
      lastStatus: mapped.status,
      lastAuthOk: false,
      lastError: mapped.message,
      lastHttpStatus: ping.status,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
      lastCategoriesOk: false,
      lastCategoriesCount: 0,
      lastCategoriesError: "",
    });
    return resultPayload({
      ok: false,
      status: mapped.status,
      message: mapped.message,
      baseUrl: config.baseUrl,
      httpStatus: ping.status,
      retryAfter,
      secrets,
    });
  }

  const pingOk = ping.status === 200 && ping.json?.data?.ok === true;
  if (!pingOk) {
    const message = "Connection failed. GINI ping did not return a successful read-only response.";
    await rememberTest({
      lastStatus: "connection_failed",
      lastAuthOk: false,
      lastError: message,
      lastHttpStatus: ping.status,
      lastEndpoint: GINI_PING_PATH,
      lastTestedAt: new Date(),
    });
    return resultPayload({
      ok: false,
      status: "connection_failed",
      message,
      baseUrl: config.baseUrl,
      httpStatus: ping.status,
      secrets,
    });
  }

  let categories = { ok: false, topLevelCount: 0, subcategoryAccess: false, message: "" };
  try {
    const categoryResponse = await giniGet(config.baseUrl, GINI_CATEGORIES_PATH, {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      timeoutMs,
    });
    if (categoryResponse.status === 200) {
      categories = categorySummary(categoryResponse.json);
      if (!categories.ok) categories.message = "Category response was not a category tree.";
    } else if (categoryResponse.status === 401) {
      categories = { ok: false, topLevelCount: 0, subcategoryAccess: false, message: "Authentication failed." };
    } else if (categoryResponse.status === 403) {
      categories = {
        ok: false,
        topLevelCount: 0,
        subcategoryAccess: false,
        message: "Access forbidden / credentials not authorized.",
      };
    } else if (categoryResponse.status === 429) {
      categories = { ok: false, topLevelCount: 0, subcategoryAccess: false, message: "Rate limited." };
    } else if (categoryResponse.status >= 500) {
      categories = {
        ok: false,
        topLevelCount: 0,
        subcategoryAccess: false,
        message: "GINI service temporarily unavailable.",
      };
    } else {
      categories = {
        ok: false,
        topLevelCount: 0,
        subcategoryAccess: false,
        message: "Category read failed.",
      };
    }
  } catch {
    categories = { ok: false, topLevelCount: 0, subcategoryAccess: false, message: "Connection failed." };
  }

  const now = new Date();
  await rememberTest({
    lastStatus: "connected",
    lastAuthOk: true,
    lastError: "",
    lastHttpStatus: 200,
    lastEndpoint: GINI_PING_PATH,
    lastTestedAt: now,
    lastSuccessAt: now,
    lastCategoriesOk: categories.ok,
    lastCategoriesCount: categories.topLevelCount,
    lastCategoriesError: categories.ok ? "" : categories.message,
  });

  return resultPayload({
    ok: true,
    status: "connected",
    message: "Connected successfully.",
    baseUrl: config.baseUrl,
    httpStatus: 200,
    endpoint: GINI_PING_PATH,
    categories,
    secrets,
  });
}
