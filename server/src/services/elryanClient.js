import {
  ELRYAN_DEFAULT_TIMEOUT_MS,
  ELRYAN_OFFICIAL_BASE_URLS,
  elryanEnvironmentConfig,
} from "../utils/elryanConstants.js";
import { sanitizeElryanText } from "../utils/elryanRedact.js";

let fetchImpl = globalThis.fetch.bind(globalThis);

/** @param {typeof fetch | null} fn Test helper. */
export function setElryanFetch(fn) {
  fetchImpl = typeof fn === "function" ? fn : globalThis.fetch.bind(globalThis);
}

export class ElryanClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ElryanClientError";
    this.status = Number(details.status) || 400;
    this.code = details.code || "";
    this.classification = details.classification || "READ";
    this.httpStatus = Number(details.httpStatus) || 0;
    if (details.details !== undefined) this.details = details.details;
  }
}

export function validateElryanBaseUrl(raw) {
  const value = String(raw || "").trim().replace(/\/+$/, "");
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
  const normalized = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  if (!ELRYAN_OFFICIAL_BASE_URLS.includes(normalized)) {
    return {
      ok: false,
      message:
        "Base URL must be the official staging or production marketplace-api host (.../api).",
    };
  }
  return { ok: true, baseUrl: normalized };
}

export function joinElryanUrl(baseUrl, path, query) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const suffix = String(path || "");
  if (!suffix.startsWith("/")) {
    throw new ElryanClientError("Elryan path must start with /", { code: "invalid_path" });
  }
  const url = new URL(`${base}${suffix}`);
  if (query && typeof query === "object") {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function classifyFromOptions(options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  if (options.classification === "WRITE" || options.classification === "READ") {
    return options.classification;
  }
  return method === "GET" || method === "HEAD" ? "READ" : "WRITE";
}

async function parseBody(response) {
  const text = await response.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

/**
 * Low-level marketplace-api request.
 * @param {{ baseUrl: string, apiKey: string, path: string, method?: string, query?: object, body?: any, timeoutMs?: number, classification?: 'READ'|'WRITE', retries?: number }} opts
 */
export async function elryanRequest(opts = {}) {
  const classification = classifyFromOptions(opts);
  const validated = validateElryanBaseUrl(opts.baseUrl);
  if (!validated.ok) {
    throw new ElryanClientError(validated.message, { code: "invalid_base_url", classification });
  }
  const apiKey = String(opts.apiKey || "").trim();
  if (!apiKey && !opts.allowMissingApiKey) {
    throw new ElryanClientError("Awaiting Elryan API Access", {
      status: 409,
      code: "api_access_pending",
      classification,
    });
  }

  const method = String(opts.method || "GET").toUpperCase();
  const url = joinElryanUrl(validated.baseUrl, opts.path, opts.query);
  const timeoutMs =
    Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
      ? Number(opts.timeoutMs)
      : ELRYAN_DEFAULT_TIMEOUT_MS;

  const retries =
    classification === "READ" && Number.isInteger(opts.retries) && opts.retries > 0
      ? Math.min(opts.retries, 2)
      : 0;

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        Accept: "application/json",
      };
      if (apiKey) headers["x-api-key"] = apiKey;
      let body;
      if (opts.body != null && method !== "GET" && method !== "HEAD") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const parsed = await parseBody(response);
      const ok = response.status >= 200 && response.status < 300;
      const retryAfter = response.headers?.get?.("retry-after") || response.headers?.get?.("Retry-After") || "";
      return {
        ok,
        classification,
        method,
        path: opts.path,
        url: sanitizeElryanText(url, [apiKey], 500),
        httpStatus: response.status,
        json: parsed.json,
        text: sanitizeElryanText(parsed.text, [apiKey], 800),
        retryAfter: retryAfter ? String(retryAfter) : "",
        attempt: attempt + 1,
      };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const abort = err?.name === "AbortError";
      if (attempt < retries && !abort) continue;
      throw new ElryanClientError(
        sanitizeElryanText(abort ? "Elryan request timed out" : err?.message || "Elryan network error", [
          apiKey,
        ]),
        {
          status: 502,
          code: abort ? "timeout" : "network_error",
          classification,
          httpStatus: 0,
        }
      );
    }
  }
  throw lastError || new ElryanClientError("Elryan request failed", { classification });
}

export function elryanBaseForEnvironment(environment) {
  return elryanEnvironmentConfig(environment).baseUrl;
}
