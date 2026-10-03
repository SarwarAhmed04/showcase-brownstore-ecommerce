const CLIENT_API = () => process.env.IBSHER_API || "https://api.ibsher.com/api/v1/client";
const ADMIN_API = () => process.env.IBSHER_ADMIN_API || "https://api.ibsher.com/api/v1/admin";
const PAGE_LIMIT = 100;
const CONCURRENCY = 4;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  absorb(res) {
    const lines =
      typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of lines) {
      const pair = String(line).split(";")[0] || "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      this.values.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.values.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

export function adminCatalogConfigured() {
  return Boolean(
    String(process.env.IBSHER_ADMIN_EMAIL || "").trim() &&
      String(process.env.IBSHER_ADMIN_PASSWORD || "").trim()
  );
}

function listFrom(json) {
  const products = Array.isArray(json?.products) ? json.products : [];
  const product = Array.isArray(json?.product) ? json.product : [];
  return products.length >= product.length ? products : product;
}

function categoriesFrom(json) {
  if (Array.isArray(json?.category)) return json.category;
  if (Array.isArray(json?.categories)) return json.categories;
  return [];
}

async function requestJson(url, jar, attempt = 0) {
  const headers = { accept: "application/json" };
  const cookie = jar?.header();
  if (cookie) headers.cookie = cookie;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    if (attempt < 4) {
      await delay(500 * (attempt + 1));
      return requestJson(url, jar, attempt + 1);
    }
    throw err;
  }

  jar?.absorb(res);

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await delay(500 * (attempt + 1));
    return requestJson(url, jar, attempt + 1);
  }

  if (res.status === 401 && jar && adminCatalogConfigured() && attempt < 2) {
    await loginAdmin(jar);
    return requestJson(url, jar, attempt + 1);
  }

  if (!res.ok) {
    throw new Error(`Catalog request failed (${res.status}) ${url}`);
  }

  return res.json();
}

async function loginAdmin(jar) {
  const email = String(process.env.IBSHER_ADMIN_EMAIL || "").trim();
  const password = String(process.env.IBSHER_ADMIN_PASSWORD || "");
  const res = await fetch(`${ADMIN_API()}/user/login`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  jar.absorb(res);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(body.message || "ibsher admin login failed");
  }
  if (!jar.header()) {
    throw new Error("ibsher admin login did not return a session");
  }
}

function pageUrl(base, page, params) {
  const query = new URLSearchParams();
  query.set("limit", String(PAGE_LIMIT));
  query.set("page", String(page));
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") query.set(key, String(value));
  }
  return `${base}?${query}`;
}

async function streamPages(base, jar, params, onPage) {
  const first = await requestJson(pageUrl(base, 1, params), jar);
  const remoteTotal = Number(first.pagination?.totalProducts ?? first.pagination?.total) || 0;
  const totalPages = Math.max(1, Number(first.pagination?.totalPages) || 1);
  if (totalPages > 5000) {
    throw new Error(`Catalog page count looks wrong (${totalPages})`);
  }

  let received = listFrom(first).length;
  await onPage(listFrom(first), { page: 1, totalPages, remoteTotal });

  let next = 2;
  async function worker() {
    while (next <= totalPages) {
      const page = next;
      next += 1;
      const json = await requestJson(pageUrl(base, page, params), jar);
      const batch = listFrom(json);
      received += batch.length;
      await onPage(batch, { page, totalPages, remoteTotal });
      if (page % 25 === 0 || page === totalPages) {
        console.log(`ibsher catalog page ${page}/${totalPages}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, Math.max(0, totalPages - 1)) }, () =>
    worker()
  );
  await Promise.all(workers);
  return { remoteTotal, received, totalPages };
}

async function collectCategories(base, jar) {
  const first = await requestJson(pageUrl(base, 1, {}), jar);
  const items = [...categoriesFrom(first)];
  const totalPages = Math.max(1, Number(first.pagination?.totalPages) || 1);
  for (let page = 2; page <= totalPages; page += 1) {
    const json = await requestJson(pageUrl(base, page, {}), jar);
    items.push(...categoriesFrom(json));
  }
  return items;
}

const VENDOR_CACHE_MS = 10 * 60 * 1000;
let vendorNameCache = { at: 0, items: null };

export async function fetchIbsherVendors() {
  if (!adminCatalogConfigured()) return [];
  if (vendorNameCache.items && Date.now() - vendorNameCache.at < VENDOR_CACHE_MS) {
    return vendorNameCache.items;
  }
  const jar = new CookieJar();
  await loginAdmin(jar);
  const json = await requestJson(`${ADMIN_API()}/user/vendor`, jar);
  const list = Array.isArray(json) ? json : [];
  const items = list
    .map((vendor) => ({
      id: String(vendor?._id || vendor?.id || "").trim(),
      name: String(vendor?.name || "").trim(),
    }))
    .filter((vendor) => vendor.id && vendor.name);
  vendorNameCache = { at: Date.now(), items };
  return items;
}

export async function fetchIbsherCategories() {
  if (adminCatalogConfigured()) {
    const jar = new CookieJar();
    await loginAdmin(jar);
    try {
      return await collectCategories(`${ADMIN_API()}/category`, jar);
    } catch (err) {
      console.warn("Admin categories unavailable:", err.message);
    }
  }
  return collectCategories(`${CLIENT_API()}/category`, null);
}

export async function streamIbsherCatalog(onProducts) {
  if (adminCatalogConfigured()) {
    const jar = new CookieJar();
    await loginAdmin(jar);
    let categories = [];
    try {
      categories = await collectCategories(`${ADMIN_API()}/category`, jar);
    } catch (err) {
      console.warn("Admin categories unavailable:", err.message);
      categories = await collectCategories(`${CLIENT_API()}/category`, null);
    }
    const pages = await streamPages(
      `${ADMIN_API()}/product`,
      jar,
      { status: "published" },
      onProducts
    );
    return { ...pages, categories, source: "admin", limited: false };
  }

  const pages = await streamPages(`${CLIENT_API()}/product`, null, {}, onProducts);
  const categories = await collectCategories(`${CLIENT_API()}/category`, null);
  return { ...pages, categories, source: "client", limited: true };
}

export function mapIbsherProduct(p) {
  return {
    ibsherId: String(p._id || p.id || ""),
    name: p.name || { en: "", ar: "", ku: "" },
    description: p.description || { en: "", ar: "", ku: "" },
    itemCode: p.itemCode || "",
    price: Number(p.price) || 0,
    discountPrice: Number(p.discountPrice) || 0,
    variants: p.variants || [],
    category: p.category || null,
    subCategory: p.subCategory || null,
    collectionName: p.collectionName || null,
    brand: p.brand || null,
    status: p.status || "published",
    warranty: p.warranty || null,
    keyword: p.keyword || [],
    is_featured: Boolean(p.is_featured),
    is_new_arrival: Boolean(p.is_new_arrival),
    is_hot: Boolean(p.is_hot),
    is_best_seller: Boolean(p.is_best_seller),
    badge: p.badge || "",
    isActive: p.isActive !== false,
    rating: Number(p.rating) || 0,
    points: Number(p.points) || 0,
    cashback: Number(p.cashback) || 0,
    createdBy: p.createdBy || null,
    sourceUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
    lastSyncedAt: new Date(),
  };
}
