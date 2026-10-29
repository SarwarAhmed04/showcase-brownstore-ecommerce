import { toResolvedProduct } from "./productView.js";
import { applyCommissionRate, resolveCommissionRate, winningCommission } from "./commission.js";

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
  return urls;
}

function withoutPlatformPrice(overrides) {
  if (!overrides || typeof overrides !== "object") return overrides || null;
  return { ...overrides, price: null, discountPrice: null };
}

export function toPartnerProduct(doc, rules, origin, platformOverrides) {
  const pub = toResolvedProduct(doc, withoutPlatformPrice(platformOverrides));
  if (!pub) return null;
  const store = toResolvedProduct(doc);
  const rate = resolveCommissionRate(doc, rules);
  const price = store?.priceReview ? null : applyCommissionRate(store?.sellingPrice, rate);
  const variants = stripPrices(pub.variants || [], origin);
  const images = collectImages(variants, pub.image, origin);

  return {
    id: String(pub.id),
    sku: pub.sku || "",
    name: pub.name,
    description: pub.description,
    price,
    priceReview: Boolean(store?.priceReview),
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

function rawCommissionPrice(price, percentage) {
  const base = Number(price) || 0;
  const rate = Number(percentage);
  const safeRate = Number.isFinite(rate) ? rate : 0;
  const raw = Math.max(0, base * (1 + safeRate / 100));
  return Math.round(raw * 100) / 100;
}

function commissionSummary(rule, rate) {
  if (!rule) return null;
  return {
    scope: rule.scope,
    percentage: rate,
    targetId: String(rule.targetId || ""),
    targetName: rule.targetName || null,
    filterPath: rule.scope === "filter" ? rule.filterPath || null : null,
  };
}

export function partnerPricePreview(doc, rules) {
  const store = toResolvedProduct(doc);
  if (!store) {
    return {
      storePrice: 0,
      rate: 0,
      rawPrice: 0,
      price: 0,
      customPrice: false,
      commission: null,
      priceReview: false,
      priceReviewReason: "",
    };
  }
  const rule = winningCommission(doc, rules);
  const rate = rule && Number.isFinite(Number(rule.percentage)) ? Number(rule.percentage) : 0;
  if (store.priceReview) {
    return {
      storePrice: null,
      rate,
      rawPrice: null,
      customPrice: false,
      price: null,
      commission: commissionSummary(rule, rate),
      priceReview: true,
      priceReviewReason: store.priceReviewReason || "missing_regular_price",
    };
  }
  const storePrice = Number(store.sellingPrice) || 0;
  return {
    storePrice,
    rate,
    rawPrice: rawCommissionPrice(storePrice, rate),
    customPrice: false,
    price: applyCommissionRate(storePrice, rate),
    commission: commissionSummary(rule, rate),
    priceReview: false,
    priceReviewReason: "",
  };
}
