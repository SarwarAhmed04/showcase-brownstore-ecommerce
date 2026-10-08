const DEFAULT_BASE_URL = "https://seller-api.miswag.com";
const MAX_PAGES = 400;

function apiKey() {
  return String(process.env.MISWAG_API_KEY || "").trim();
}

function apiSecret() {
  return String(process.env.MISWAG_API_SECRET || "").trim();
}

export function miswagConfigured() {
  return Boolean(apiKey() && apiSecret());
}

export function miswagBaseUrl() {
  return String(process.env.MISWAG_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function authHeaders() {
  return {
    accept: "application/json",
    "X-API-Key": apiKey(),
    "X-API-Secret": apiSecret(),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pageItems(body) {
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

function nextUrl(body) {
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

function resolveNext(next, current) {
  const value = String(next || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value, current);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function textValue(value) {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return String(value.en || value.name_en || value.nameEn || value.ar || value.name_ar || value.name || "").trim();
}

function segmentLabel(segment) {
  if (typeof segment === "string") return segment.trim();
  if (!segment || typeof segment !== "object") return "";
  return String(
    segment.name_en || segment.nameEn || segment.en || segment.name || segment.name_ar || segment.alias || ""
  ).trim();
}

function formatPath(path) {
  if (Array.isArray(path)) {
    return path.map(segmentLabel).filter(Boolean).join(" > ");
  }
  return textValue(path);
}

export function normalizeMiswagCategory(raw) {
  if (!raw || typeof raw !== "object") return null;
  const externalId = String(raw.id ?? raw._id ?? raw.category_id ?? raw.external_id ?? "").trim();
  if (!externalId) return null;
  const active = raw.active !== false && raw.is_active !== false && raw.isActive !== false;
  return {
    externalId,
    alias: String(raw.alias || raw.slug || "").trim(),
    nameEn: String(raw.name_en || raw.nameEn || raw.name?.en || "").trim(),
    nameAr: String(raw.name_ar || raw.nameAr || raw.name?.ar || "").trim(),
    description: textValue(raw.description || raw.description_en || raw.description_ar).slice(0, 4000),
    path: formatPath(raw.path || raw.category_path || raw.full_path || "").slice(0, 1000),
    active,
  };
}

async function requestJson(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if (attempt < 2) {
      await delay(400 * (attempt + 1));
      return requestJson(url, attempt + 1);
    }
    throw new Error("Miswag API could not be reached");
  }

  if ((res.status === 429 || res.status >= 500) && attempt < 2) {
    await delay(400 * (attempt + 1));
    return requestJson(url, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Miswag API request failed (${res.status})`);
  }

  return res.json().catch(() => {
    throw new Error("Miswag categories response was not JSON");
  });
}

export async function miswagHealth() {
  if (!miswagConfigured()) {
    return {
      ok: false,
      configured: false,
      message: "Miswag API credentials are not set",
    };
  }

  try {
    const res = await fetch(`${miswagBaseUrl()}/v1/categories/flat`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(15000),
    });
    return {
      ok: res.ok,
      configured: true,
      status: res.status,
      message: res.ok ? "" : `Miswag API request failed (${res.status})`,
    };
  } catch {
    return {
      ok: false,
      configured: true,
      message: "Miswag API could not be reached",
    };
  }
}

export async function fetchAllMiswagCategories() {
  if (!miswagConfigured()) {
    const err = new Error("Miswag API credentials are not set");
    err.status = 400;
    throw err;
  }

  let url = `${miswagBaseUrl()}/v1/categories/flat`;
  const seen = new Set();
  const byId = new Map();
  let pages = 0;

  while (url) {
    if (seen.has(url)) break;
    if (pages >= MAX_PAGES) {
      throw new Error("Miswag category sync exceeded the page limit before next_url ended");
    }
    seen.add(url);
    const body = await requestJson(url);
    pages += 1;
    const items = pageItems(body);
    if (!items.length && pages === 1) {
      const keys = body && typeof body === "object" ? Object.keys(body).join(", ") : "";
      throw new Error(
        `Miswag categories response had no category list${keys ? ` (${keys})` : ""}`
      );
    }
    for (const raw of items) {
      const mapped = normalizeMiswagCategory(raw);
      if (mapped) byId.set(mapped.externalId, mapped);
    }
    const next = resolveNext(nextUrl(body), url);
    url = next && next !== url ? next : "";
  }

  if (!byId.size) {
    throw new Error("Miswag category sync returned no categories");
  }

  console.log(`Miswag categories fetched: ${byId.size} across ${pages} page(s)`);
  return [...byId.values()];
}
