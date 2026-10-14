export const MISWAG_PARTNER = "miswag";

const DEFAULT_TIMEOUT_MS = 30000;

export class MiswagError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MiswagError";
    this.status = Number(details.status) || 0;
    this.errors = Array.isArray(details.errors) ? details.errors : [];
    this.retryAfter = Number(details.retryAfter) || 0;
    this.eventId = details.eventId || "";
    this.transient = Boolean(details.transient);
  }
}

export function miswagConfig() {
  return {
    baseUrl: String(process.env.MISWAG_BASE_URL || "https://seller-api.miswag.com")
      .trim()
      .replace(/\/$/, ""),
    apiKey: String(process.env.MISWAG_API_KEY || "").trim(),
    apiSecret: String(process.env.MISWAG_API_SECRET || "").trim(),
  };
}

// Reserved for a later switch. The IBSHER scheduler does not call product sync.
export function miswagAutoSyncEnabled() {
  return String(process.env.MISWAG_AUTO_SYNC || "").trim().toLowerCase() === "true";
}

function sanitize(message) {
  let text = String(message || "");
  const { apiKey, apiSecret } = miswagConfig();
  for (const secret of [apiKey, apiSecret]) {
    if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 500);
}

function errorList(body) {
  const raw = body?.errors;
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => sanitize(typeof item === "string" ? item : item?.message || "")).filter(Boolean);
}

function retryAfterSeconds(response) {
  const header = response.headers.get("retry-after");
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;
  return 60;
}

function statusError(status, body, response) {
  const errors = errorList(body);
  const eventId = sanitize(body?.event_id || "");
  const detail = errors[0] || sanitize(body?.message || "");

  if (status === 401) {
    return new MiswagError("Miswag authentication failed. Check MISWAG_API_KEY and MISWAG_API_SECRET.", {
      status,
      errors,
    });
  }
  if (status === 403) {
    return new MiswagError(detail || "Miswag refused this request.", { status, errors });
  }
  if (status === 404) {
    return new MiswagError(detail || "Miswag could not find that resource.", { status, errors });
  }
  if (status === 422) {
    return new MiswagError(detail || "Miswag rejected the submitted data.", { status, errors });
  }
  if (status === 429) {
    return new MiswagError("Miswag rate limit reached.", {
      status,
      errors,
      retryAfter: retryAfterSeconds(response),
      transient: true,
    });
  }
  if (status >= 500) {
    const suffix = eventId ? ` Event ${eventId}.` : "";
    return new MiswagError(`Miswag is unavailable.${suffix}`, {
      status,
      errors,
      eventId,
      transient: true,
    });
  }
  return new MiswagError(detail || `Miswag request failed (${status}).`, { status, errors });
}

export async function request(path, options = {}) {
  const { baseUrl, apiKey, apiSecret } = miswagConfig();
  if (!apiKey || !apiSecret) {
    throw new MiswagError("Miswag authentication failed. Check MISWAG_API_KEY and MISWAG_API_SECRET.", {
      status: 401,
    });
  }

  const method = options.method || "GET";
  const url = /^https?:\/\//i.test(path) ? path : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  if (!isAllowedMiswagUrl(url)) {
    throw new MiswagError("Miswag request URL is outside the configured API host.", { status: 400 });
  }

  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Accept: "application/json",
    "X-API-Key": apiKey,
    "X-API-Secret": apiSecret,
  };
  if (options.body != null) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body != null ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
      redirect: "error",
    });
  } catch (err) {
    const timeout = err?.name === "AbortError";
    throw new MiswagError(timeout ? "Miswag request timed out." : "Miswag network request failed.", {
      status: 0,
      transient: true,
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
      body = { message: sanitize(text) };
    }
  }

  if (response.status < 200 || response.status > 202) {
    throw statusError(response.status, body, response);
  }

  return {
    status: response.status,
    message: sanitize(body?.message || ""),
    data: body?.data ?? body,
    body,
    requestId: response.headers.get("request-id") || "",
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestWithRetry(path, options = {}, retries = 3) {
  let attempt = 0;
  while (true) {
    try {
      return await request(path, options);
    } catch (err) {
      const retryable = err instanceof MiswagError && err.transient && err.status !== 401 && err.status !== 403 && err.status !== 422;
      if (!retryable || attempt >= retries) throw err;
      const wait = err.status === 429
        ? Math.min((err.retryAfter || 60) * 1000, 120000)
        : Math.min(1000 * 2 ** attempt, 30000);
      await sleep(wait);
      attempt += 1;
    }
  }
}

export function isAllowedMiswagUrl(url) {
  const { baseUrl } = miswagConfig();
  try {
    return new URL(url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

export function healthCheck() {
  return request("/v1/healthcheck", { method: "HEAD" });
}

export function fetchCategoryPage(url) {
  return requestWithRetry(url || "/v1/categories/flat?page%5Bsize%5D=30");
}

export function searchBrands(query, url) {
  const path = url || `/v1/brands/search?q=${encodeURIComponent(String(query || "").trim())}`;
  return requestWithRetry(path);
}

export function listItemVariations(externalId) {
  return request(`/v1/items/${encodeURIComponent(externalId)}/variations`);
}

export function getItemVariation(externalId, variationExternalId) {
  return request(`/v1/items/${encodeURIComponent(externalId)}/variations/${encodeURIComponent(variationExternalId)}`);
}

export function createOrUpdateItem(payload) {
  return requestWithRetry("/v1/items/bulk-create", {
    method: "POST",
    body: payload,
    timeoutMs: 60000,
  });
}

export function getItem(externalId) {
  return request(`/v1/items/${encodeURIComponent(externalId)}`);
}

export function updatePrice(externalId, price) {
  return requestWithRetry(`/v1/items/${encodeURIComponent(externalId)}/price`, {
    method: "PATCH",
    body: { price },
  });
}

export function updateSizeStock(itemExternalId, variationExternalId, sizeExternalId, quantity) {
  const path = `/v1/items/${encodeURIComponent(itemExternalId)}/variations/${encodeURIComponent(variationExternalId)}/sizes/${encodeURIComponent(sizeExternalId)}/stock`;
  return requestWithRetry(path, {
    method: "PATCH",
    body: { quantity },
  });
}

export function publishItems(externalIds) {
  return requestWithRetry("/v1/items/actions/publish", {
    method: "POST",
    body: { items: externalIds },
  });
}

export function getJob(jobId) {
  return request(`/v1/jobs/${encodeURIComponent(jobId)}`);
}
