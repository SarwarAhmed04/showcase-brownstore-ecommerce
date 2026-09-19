import { toResolvedProduct } from "./productView.js";
import { applyCommissionRate, resolveCommissionRate } from "./commission.js";
import { snapshotOverrides } from "./overrides.js";

const PRICE_KEYS = new Set(["price", "discountPrice", "sellingPrice", "overrides"]);

function absolutize(origin, url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${origin}${path}`;
}

function stripPrices(value, origin) {
  if (Array.isArray(value)) return value.map((item) => stripPrices(item, origin));
  if (!value || typeof value !== "object") return value;

  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    if (PRICE_KEYS.has(key)) continue;
    if (key === "url" && typeof nested === "string") {
      next[key] = absolutize(origin, nested);
      continue;
    }
    next[key] = stripPrices(nested, origin);
  }
  return next;
}

function slimEntity(value) {
  if (!value || typeof value !== "object") return null;
  const id = value._id || value.id || "";
  if (!id && !value.name) return null;
  return {
    id: String(id),
    name: {
      ku: String(value.name?.ku || ""),
      en: String(value.name?.en || ""),
      ar: String(value.name?.ar || ""),
    },
  };
}

function collectImages(variants, fallback, origin) {
  const urls = [];
  const seen = new Set();
  function push(url) {
    const abs = absolutize(origin, url);
    if (!abs || seen.has(abs)) return;
    seen.add(abs);
    urls.push(abs);
  }
  for (const variant of variants || []) {
    for (const image of variant.images || []) {
      push(image.url);
    }
  }
  push(fallback);
  if (fallback) {
    const main = absolutize(origin, fallback);
    const rest = urls.filter((url) => url !== main);
    return main ? [main, ...rest] : rest;
  }
  return urls;
}

export function toPartnerProduct(doc, rules, origin, platformOverrides) {
  const pub = toResolvedProduct(doc, platformOverrides);
  if (!pub) return null;
  const snap = snapshotOverrides(platformOverrides);
  const customPrice = snap.price != null;
  const rate = customPrice ? 0 : resolveCommissionRate(doc, rules);
  const price = customPrice
    ? Number(pub.sellingPrice) || 0
    : applyCommissionRate(pub.sellingPrice, rate);
  const variants = stripPrices(pub.variants || [], origin);
  const images = collectImages(variants, pub.image, origin);

  return {
    id: String(pub.id),
    sku: pub.sku || "",
    name: pub.name,
    description: pub.description,
    price,
    stock: pub.stock,
    inStock: pub.inStock,
    images,
    category: slimEntity(pub.category),
    subCategory: slimEntity(pub.subCategory),
    collection: slimEntity(pub.collectionName),
    brand: slimEntity(pub.brand),
    variants,
  };
}

export function partnerPricePreview(doc, rules, platformOverrides) {
  const pub = toResolvedProduct(doc, platformOverrides);
  if (!pub) return { storePrice: 0, rate: 0, price: 0, customPrice: false };
  const snap = snapshotOverrides(platformOverrides);
  const customPrice = snap.price != null;
  const rate = customPrice ? 0 : resolveCommissionRate(doc, rules);
  const store = toResolvedProduct(doc);
  const storePrice = Number(store?.sellingPrice) || 0;
  return {
    storePrice,
    rate,
    customPrice,
    price: customPrice
      ? Number(pub.sellingPrice) || 0
      : applyCommissionRate(storePrice, rate),
  };
}
