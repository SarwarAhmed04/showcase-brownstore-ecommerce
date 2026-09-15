export function asObject(doc) {
  if (!doc) return {};
  return typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
}

export function emptyOverrides() {
  return {
    sku: null,
    price: null,
    discountPrice: null,
    stock: null,
    outOfStock: false,
    isActive: null,
    name: null,
    description: null,
    brand: null,
    category: null,
    subCategory: null,
    collectionName: null,
    variants: null,
    warranty: null,
    keyword: null,
    badge: null,
    is_featured: null,
    is_new_arrival: null,
    is_hot: null,
    is_best_seller: null,
  };
}

export function localizedHasValue(value) {
  if (!value || typeof value !== "object") return false;
  return Boolean(
    String(value.ku || "").trim() ||
      String(value.en || "").trim() ||
      String(value.ar || "").trim()
  );
}

export function pickLocalized(over, source) {
  const src = source && typeof source === "object" ? source : {};
  const ov = over && typeof over === "object" ? over : {};
  return {
    ku: String(ov.ku || "").trim() || src.ku || "",
    en: String(ov.en || "").trim() || src.en || "",
    ar: String(ov.ar || "").trim() || src.ar || "",
  };
}

function sameLocalized(a, b) {
  const left = pickLocalized(null, a);
  const right = pickLocalized(null, b);
  return left.ku === right.ku && left.en === right.en && left.ar === right.ar;
}

function toNumOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function mergeEntity(source, over) {
  const src = source && typeof source === "object" ? source : {};
  const extra = over && typeof over === "object" ? over : {};
  return {
    ...src,
    ...extra,
    name: localizedHasValue(extra.name) ? pickLocalized(extra.name, src.name) : src.name,
  };
}

function clone(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

export function applyOverrides(raw, overrides = {}) {
  const src = raw && typeof raw === "object" ? raw : {};
  const over = overrides && typeof overrides === "object" ? overrides : {};
  const next = { ...src };

  if (localizedHasValue(over.name)) next.name = pickLocalized(over.name, src.name);
  if (localizedHasValue(over.description)) {
    next.description = pickLocalized(over.description, src.description);
  }

  next.sku = emptyToNull(over.sku) || src.sku || src.itemCode || "";

  if (over.price != null && over.price !== "") next.price = Number(over.price);
  if (over.discountPrice != null && over.discountPrice !== "") {
    next.discountPrice = Number(over.discountPrice);
  } else if (over.price != null && over.price !== "") {
    next.discountPrice = 0;
  }

  if (Array.isArray(over.variants)) next.variants = clone(over.variants);

  if (over.stock != null && over.stock !== "") next.stock = Number(over.stock);
  if (over.outOfStock === true || over.outOfStock === false) {
    next.outOfStock = over.outOfStock === true;
  } else {
    next.outOfStock = Boolean(src.outOfStock);
  }

  if (over.isActive === true || over.isActive === false) next.isActive = over.isActive;

  for (const key of ["brand", "category", "subCategory", "collectionName"]) {
    if (over[key] != null && typeof over[key] === "object") {
      next[key] = mergeEntity(src[key], over[key]);
    }
  }

  if (over.warranty != null && over.warranty !== "") next.warranty = over.warranty;
  if (Array.isArray(over.keyword)) next.keyword = over.keyword;
  if (over.badge != null) next.badge = String(over.badge);

  for (const flag of ["is_featured", "is_new_arrival", "is_hot", "is_best_seller"]) {
    if (over[flag] === true || over[flag] === false) next[flag] = over[flag];
  }

  return next;
}

const PATCH_KEYS = [
  "sku",
  "price",
  "discountPrice",
  "stock",
  "outOfStock",
  "isActive",
  "name",
  "description",
  "brand",
  "category",
  "subCategory",
  "collectionName",
  "variants",
  "warranty",
  "keyword",
  "badge",
  "is_featured",
  "is_new_arrival",
  "is_hot",
  "is_best_seller",
];

function sanitizeLocalized(value) {
  if (!value || typeof value !== "object") return null;
  const next = {
    ku: String(value.ku || "").trim(),
    en: String(value.en || "").trim(),
    ar: String(value.ar || "").trim(),
  };
  return localizedHasValue(next) ? next : null;
}

function sanitizeEntity(value) {
  if (!value || typeof value !== "object") return null;
  const name = sanitizeLocalized(value.name);
  const next = { ...value };
  if (name) next.name = name;
  return next;
}

export function mergeOverridePatch(prev, body = {}) {
  const next = { ...emptyOverrides(), ...(prev && typeof prev === "object" ? prev : {}) };

  if ("sku" in body) next.sku = emptyToNull(body.sku);
  if ("price" in body) {
    const price = toNumOrNull(body.price);
    if (body.price !== "" && body.price != null && price == null) {
      const err = new Error("Invalid price");
      err.status = 400;
      throw err;
    }
    next.price = price;
  }
  if ("discountPrice" in body) {
    const discountPrice = toNumOrNull(body.discountPrice);
    if (body.discountPrice !== "" && body.discountPrice != null && discountPrice == null) {
      const err = new Error("Invalid discount price");
      err.status = 400;
      throw err;
    }
    next.discountPrice = discountPrice;
  }
  if ("stock" in body) {
    const stock = toNumOrNull(body.stock);
    if (body.stock !== "" && body.stock != null && stock == null) {
      const err = new Error("Invalid stock");
      err.status = 400;
      throw err;
    }
    next.stock = stock;
  }
  if ("outOfStock" in body) next.outOfStock = Boolean(body.outOfStock);
  if ("isActive" in body) next.isActive = boolOrNull(body.isActive);
  if ("name" in body) next.name = sanitizeLocalized(body.name);
  if ("description" in body) next.description = sanitizeLocalized(body.description);
  if ("brand" in body) next.brand = sanitizeEntity(body.brand);
  if ("category" in body) next.category = sanitizeEntity(body.category);
  if ("subCategory" in body) next.subCategory = sanitizeEntity(body.subCategory);
  if ("collectionName" in body) next.collectionName = sanitizeEntity(body.collectionName);
  if ("variants" in body) next.variants = Array.isArray(body.variants) ? clone(body.variants) : null;
  if ("warranty" in body) next.warranty = body.warranty == null || body.warranty === "" ? null : body.warranty;
  if ("keyword" in body) next.keyword = Array.isArray(body.keyword) ? body.keyword.map(String) : null;
  if ("badge" in body) next.badge = emptyToNull(body.badge);
  for (const flag of ["is_featured", "is_new_arrival", "is_hot", "is_best_seller"]) {
    if (flag in body) next[flag] = boolOrNull(body[flag]);
  }
  if (Array.isArray(body.reset)) {
    for (const key of body.reset) {
      if (!PATCH_KEYS.includes(key)) continue;
      next[key] = key === "outOfStock" ? false : null;
    }
  }
  return next;
}

export function snapshotOverrides(overrides = {}) {
  const raw = overrides && typeof overrides === "object" ? overrides : {};
  return {
    sku: emptyToNull(raw.sku),
    price: raw.price == null || raw.price === "" ? null : Number(raw.price),
    discountPrice: raw.discountPrice == null || raw.discountPrice === "" ? null : Number(raw.discountPrice),
    stock: raw.stock == null || raw.stock === "" ? null : Number(raw.stock),
    outOfStock: raw.outOfStock === true,
    isActive: raw.isActive === true || raw.isActive === false ? raw.isActive : null,
    name: sanitizeLocalized(raw.name),
    description: sanitizeLocalized(raw.description),
    brand: raw.brand && typeof raw.brand === "object" ? raw.brand : null,
    category: raw.category && typeof raw.category === "object" ? raw.category : null,
    subCategory: raw.subCategory && typeof raw.subCategory === "object" ? raw.subCategory : null,
    collectionName: raw.collectionName && typeof raw.collectionName === "object" ? raw.collectionName : null,
    variants: Array.isArray(raw.variants) ? raw.variants : null,
    warranty: raw.warranty == null || raw.warranty === "" ? null : raw.warranty,
    keyword: Array.isArray(raw.keyword) ? raw.keyword : null,
    badge: emptyToNull(raw.badge),
    is_featured: raw.is_featured === true || raw.is_featured === false ? raw.is_featured : null,
    is_new_arrival: raw.is_new_arrival === true || raw.is_new_arrival === false ? raw.is_new_arrival : null,
    is_hot: raw.is_hot === true || raw.is_hot === false ? raw.is_hot : null,
    is_best_seller: raw.is_best_seller === true || raw.is_best_seller === false ? raw.is_best_seller : null,
  };
}

export function hasCustomOverrides(overrides = {}) {
  const snap = snapshotOverrides(overrides);
  return PATCH_KEYS.some((key) => {
    if (key === "outOfStock") return snap.outOfStock === true;
    const value = snap[key];
    if (value == null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === "object") return Object.keys(value).length > 0;
    return true;
  });
}

export function overrideChanges(before, after) {
  const changes = [];
  const keys = [
    "sku",
    "price",
    "discountPrice",
    "stock",
    "outOfStock",
    "isActive",
    "name",
    "description",
    "badge",
    "is_featured",
    "is_new_arrival",
    "is_hot",
    "is_best_seller",
  ];
  for (const field of keys) {
    const from = before?.[field];
    const to = after?.[field];
    if (JSON.stringify(from ?? null) !== JSON.stringify(to ?? null)) {
      changes.push({ field, from: from ?? "", to: to ?? "" });
    }
  }
  return changes;
}

export { sameLocalized };
