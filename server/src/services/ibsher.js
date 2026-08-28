const API = process.env.IBSHER_API || "https://api.ibsher.com/api/v1/client";

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Ibsher ${res.status} ${url}`);
  }
  return res.json();
}

export async function fetchIbsherCategories() {
  const json = await fetchJson(`${API}/category`);
  return json.category || json.categories || [];
}

export async function fetchIbsherProducts() {
  const first = await fetchJson(`${API}/product?limit=50&page=1`);
  const products = [...(first.product || [])];
  const totalPages = first.pagination?.totalPages || 1;

  for (let page = 2; page <= totalPages; page += 1) {
    const json = await fetchJson(`${API}/product?limit=50&page=${page}`);
    products.push(...(json.product || []));
  }

  return products;
}

export function mapIbsherProduct(p) {
  return {
    ibsherId: p._id,
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
