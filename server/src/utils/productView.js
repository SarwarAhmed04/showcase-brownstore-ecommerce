const CDN = process.env.IBSHER_CDN || "https://cdn.ibsher.com";

export function cdnUrl(path) {
  if (!path) return "";
  if (String(path).startsWith("http")) return path;
  return `${CDN}${path}`;
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

export function toPublicProduct(doc) {
  const raw = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const overrides = raw.overrides || {};
  const sourceStock = computeStock(raw.variants);
  const sku = overrides.sku || raw.itemCode || "";
  const price = overrides.price != null ? overrides.price : raw.price;
  const discountPrice = overrides.price != null ? 0 : raw.discountPrice || 0;
  const stock = overrides.stock != null ? overrides.stock : sourceStock;
  const sellingPrice =
    discountPrice > 0 && discountPrice < price ? discountPrice : price;

  const firstImage =
    mapVariants(raw.variants)[0]?.images?.find((i) => i.isMain)?.url ||
    mapVariants(raw.variants)[0]?.images?.[0]?.url ||
    "";

  return {
    id: raw._id,
    ibsherId: raw.ibsherId,
    name: raw.name,
    description: raw.description,
    sku,
    itemCode: raw.itemCode,
    price,
    discountPrice,
    sellingPrice,
    stock,
    inStock: stock > 0,
    image: firstImage,
    variants: mapVariants(raw.variants),
    category: raw.category,
    subCategory: raw.subCategory,
    collectionName: raw.collectionName,
    brand: raw.brand,
    status: raw.status,
    warranty: raw.warranty,
    keyword: raw.keyword,
    is_featured: raw.is_featured,
    is_new_arrival: raw.is_new_arrival,
    is_hot: raw.is_hot,
    is_best_seller: raw.is_best_seller,
    badge: raw.badge,
    isActive: raw.isActive,
    overrides: {
      sku: overrides.sku ?? null,
      price: overrides.price ?? null,
      stock: overrides.stock ?? null,
    },
    lastSyncedAt: raw.lastSyncedAt,
    updatedAt: raw.updatedAt,
  };
}
