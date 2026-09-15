import {
  applyOverrides,
  asObject,
  snapshotOverrides,
} from "./overrides.js";

const CDN = process.env.IBSHER_CDN || "https://cdn.ibsher.com";
const MEDIA_PREFIX = "/media";

export function cdnUrl(path) {
  if (!path) return "";
  const raw = String(path);

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const remote = new URL(raw);
      const cdn = new URL(CDN);
      if (remote.hostname === cdn.hostname) {
        return `${MEDIA_PREFIX}${remote.pathname}${remote.search}`;
      }
    } catch {
      return raw;
    }
    return raw;
  }

  const normalized = raw.startsWith("/") ? raw : `/${raw}`;
  return `${MEDIA_PREFIX}${normalized}`;
}

export function computeStock(variants = []) {
  let total = 0;
  for (const variant of variants) {
    for (const size of variant.sizes || []) {
      total += Number(size.stockQuantity) || 0;
    }
  }
  return total;
}

function mapImages(images = []) {
  return images.map((img) => ({
    ...img,
    url: cdnUrl(img.url),
  }));
}

function mapVariants(variants = []) {
  return variants.map((variant) => ({
    ...variant,
    images: mapImages(variant.images || []),
  }));
}

export function publicProductFilter() {
  return {
    "overrides.outOfStock": { $ne: true },
    $and: [
      {
        $or: [
          { "overrides.isActive": true },
          {
            $and: [
              { "overrides.isActive": { $ne: false } },
              { isActive: { $ne: false } },
            ],
          },
        ],
      },
    ],
  };
}

export function isPubliclyVisible(doc, extraOverrides) {
  const full = toResolvedProduct(doc, extraOverrides);
  if (!full) return false;
  if (full.isActive === false) return false;
  if (full.outOfStock === true) return false;
  return true;
}

function firstImage(variants) {
  return (
    variants[0]?.images?.find((i) => i.isMain)?.url ||
    variants[0]?.images?.[0]?.url ||
    ""
  );
}

export function toResolvedProduct(doc, extraOverrides) {
  const raw = asObject(doc);
  if (!raw || (!raw._id && !raw.id && !raw.ibsherId)) return null;
  const store = applyOverrides(raw, raw.overrides);
  const merged = extraOverrides ? applyOverrides(store, extraOverrides) : store;
  const variants = mapVariants(merged.variants || []);
  const sourceStock = computeStock(merged.variants || []);
  const stock =
    merged.stock != null && Number.isFinite(Number(merged.stock))
      ? Number(merged.stock)
      : sourceStock;
  const price = Number(merged.price) || 0;
  const discountPrice = Number(merged.discountPrice) || 0;
  const sellingPrice =
    discountPrice > 0 && discountPrice < price ? discountPrice : price;
  const outOfStock = merged.outOfStock === true;
  const hasDiscount = discountPrice > 0 && discountPrice < price;

  return {
    id: raw._id,
    ibsherId: raw.ibsherId,
    name: merged.name || { ku: "", en: "", ar: "" },
    description: merged.description || { ku: "", en: "", ar: "" },
    sku: merged.sku || "",
    itemCode: raw.itemCode || "",
    price,
    discountPrice,
    sellingPrice,
    stock,
    outOfStock,
    inStock: !outOfStock && stock > 0,
    isActive: merged.isActive !== false,
    image: firstImage(variants),
    variants,
    category: merged.category,
    subCategory: merged.subCategory,
    collectionName: merged.collectionName,
    brand: merged.brand,
    status: merged.status,
    warranty: merged.warranty,
    keyword: merged.keyword || [],
    is_featured: Boolean(merged.is_featured),
    is_new_arrival: Boolean(merged.is_new_arrival),
    is_hot: Boolean(merged.is_hot),
    is_best_seller: Boolean(merged.is_best_seller),
    badge: merged.badge || "",
    rating: Number(raw.rating) || 0,
    onDeal: hasDiscount || Boolean(merged.is_hot),
    lastSyncedAt: raw.lastSyncedAt,
    updatedAt: raw.updatedAt,
  };
}

export function toAdminProduct(doc, extraOverrides) {
  const raw = asObject(doc);
  const resolved = toResolvedProduct(doc, extraOverrides);
  if (!resolved) return null;
  const store = extraOverrides ? toResolvedProduct(doc) : null;
  const sourceVariants = mapVariants((store || raw).variants || raw.variants || []);
  const source = store || {
    name: raw.name || { ku: "", en: "", ar: "" },
    description: raw.description || { ku: "", en: "", ar: "" },
    itemCode: raw.itemCode || "",
    price: Number(raw.price) || 0,
    discountPrice: Number(raw.discountPrice) || 0,
    stock: computeStock(raw.variants || []),
    variants: sourceVariants,
    brand: raw.brand,
    category: raw.category,
    subCategory: raw.subCategory,
    collectionName: raw.collectionName,
    warranty: raw.warranty,
    keyword: raw.keyword || [],
    badge: raw.badge || "",
    is_featured: Boolean(raw.is_featured),
    is_new_arrival: Boolean(raw.is_new_arrival),
    is_hot: Boolean(raw.is_hot),
    is_best_seller: Boolean(raw.is_best_seller),
    isActive: raw.isActive !== false,
  };
  return {
    ...resolved,
    source: store
      ? {
          name: store.name,
          description: store.description,
          itemCode: store.itemCode,
          sku: store.sku,
          price: store.price,
          discountPrice: store.discountPrice,
          sellingPrice: store.sellingPrice,
          stock: store.stock,
          variants: store.variants,
          brand: store.brand,
          category: store.category,
          subCategory: store.subCategory,
          collectionName: store.collectionName,
          warranty: store.warranty,
          keyword: store.keyword || [],
          badge: store.badge || "",
          is_featured: store.is_featured,
          is_new_arrival: store.is_new_arrival,
          is_hot: store.is_hot,
          is_best_seller: store.is_best_seller,
          isActive: store.isActive,
        }
      : source,
    overrides: snapshotOverrides(extraOverrides || raw.overrides),
  };
}

export function toPublicProduct(doc) {
  const full = toResolvedProduct(doc);
  if (!full) return null;
  return {
    id: full.id,
    ibsherId: full.ibsherId,
    name: full.name,
    description: full.description,
    sku: full.sku,
    itemCode: full.itemCode,
    stock: full.stock,
    outOfStock: full.outOfStock,
    inStock: full.inStock,
    image: full.image,
    variants: stripVariantPrices(full.variants),
    category: full.category,
    subCategory: full.subCategory,
    collectionName: full.collectionName,
    brand: full.brand,
    status: full.status,
    warranty: full.warranty,
    keyword: full.keyword,
    is_featured: full.is_featured,
    is_new_arrival: full.is_new_arrival,
    is_hot: full.is_hot,
    is_best_seller: full.is_best_seller,
    badge: full.badge,
    rating: full.rating,
    onDeal: full.onDeal,
    lastSyncedAt: full.lastSyncedAt,
    updatedAt: full.updatedAt,
  };
}

function stripVariantPrices(variants = []) {
  return variants.map((variant) => {
    const next = { ...variant };
    delete next.price;
    delete next.discountPrice;
    delete next.sellingPrice;
    return next;
  });
}
