import { tName } from "../i18n";

const TONES = [
  "166 124 82",
  "138 90 48",
  "196 148 92",
  "120 84 56",
  "180 132 76",
  "104 72 48",
  "210 168 110",
  "148 104 64",
];

export function adaptProduct(p, lang = "en") {
  if (!p) return null;
  const catId = String(p.category?._id || p.category?.id || p.category || "");
  const images = [];
  for (const variant of p.variants || []) {
    for (const img of variant.images || []) {
      if (img?.url) images.push(img.url);
    }
  }
  if (p.image && !images.includes(p.image)) images.unshift(p.image);

  const specs = {};
  if (p.sku) specs.SKU = p.sku;
  if (tName(p.brand?.name, lang)) specs.Brand = tName(p.brand.name, lang);
  if (tName(p.category?.name, lang)) specs.Category = tName(p.category.name, lang);
  if (p.warranty != null && p.warranty !== "") {
    const w = p.warranty;
    specs.Warranty =
      typeof w === "string" || typeof w === "number"
        ? String(w)
        : tName(w, lang) || String(w.value || w.text || "");
    if (!specs.Warranty) delete specs.Warranty;
  }
  if (p.stock != null) specs.Stock = String(p.stock);
  if (p.itemCode && p.itemCode !== p.sku) specs.Code = String(p.itemCode);

  return {
    id: String(p.id),
    slug: String(p.id),
    name: tName(p.name, lang) || "",
    brand: tName(p.brand?.name, lang) || "",
    img: images[0] || p.image || "",
    gallery: images.length ? images : [p.image].filter(Boolean),
    price: null,
    oldPrice: null,
    onDeal: Boolean(p.onDeal || p.is_hot),
    stock: p.inStock ? "in" : "out",
    category: catId,
    desc: tName(p.description, lang) || "",
    sku: p.sku || "",
    rating: Number(p.rating) || 0,
    reviews: Number(p.reviews) || 0,
    featured: Boolean(p.is_featured || p.is_best_seller),
    badge: p.badge || (p.is_new_arrival ? "New" : p.is_hot ? "Hot" : ""),
    specs,
    tags: [p.keyword].filter(Boolean),
    colors: (p.variants || []).map((v) => v.color).filter(Boolean),
    raw: p,
  };
}

export function adaptCategory(c, lang, index = 0) {
  return {
    id: String(c.id),
    slug: String(c.id),
    name: tName(c.name, lang) || "",
    cover: c.image || "",
    tagline: "",
    tone: TONES[index % TONES.length],
    icon: "grid",
    count: Number(c.count) || 0,
  };
}
