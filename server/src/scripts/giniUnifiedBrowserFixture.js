/**
 * Local-only BrownStore admin with fixture products and a mocked GINI API.
 * It never calls merchant.gini.iq. Production write gates stay closed because
 * NODE_ENV is not production; the unified flags apply only to this process.
 */
process.env.NODE_ENV = "development";
process.env.JWT_SECRET = "gini-unified-browser-fixture";
process.env.ADMIN_EMAIL = "karim@brown.com";
process.env.ADMIN_PASSWORD = "karim0fadmin";
process.env.GINI_UNIFIED_SYNC_WRITES_ENABLED = "true";
process.env.GINI_ALLOW_LIVE_UNIFIED_SYNC = "true";
process.env.GINI_VARIANT_SYNC_WRITES_ENABLED = "true";
process.env.GINI_ALLOW_LIVE_VARIANT_SYNC = "true";

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Product } from "../models/Product.js";
import { Partner } from "../models/Partner.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { GiniConnection } from "../models/GiniConnection.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { authRouter } from "../routes/auth.js";
import { adminRouter } from "../routes/admin.js";
import { partnersRouter } from "../routes/partners.js";
import { requireAdmin } from "../middleware/auth.js";
import { seedAdmin } from "../seedAdmin.js";
import { seedPartners } from "../seedPartners.js";
import { giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { proposeVariantSku } from "../utils/giniVariantCatalog.js";
import { saveGiniConnection, setGiniCategoryRetryScale, setGiniFetch } from "../services/giniConnection.js";
import { setGiniMediaFetch } from "../services/giniSyncOne.js";

const PORT = 5055;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const TREE = {
  data: [{ id: 1, name: "Home", slug: "home", is_active: 1, subcategories: [{ id: 10, name: "Blenders", slug: "blenders", is_active: 1 }] }],
  meta: { last_page: 1 },
};
const remote = new Map();
const writes = [];

function parentBody(sku, extra = {}) {
  return {
    id: extra.id,
    sku,
    price: extra.price,
    quantity: extra.quantity,
    is_visible: extra.visible === false ? 0 : 1,
    variants: extra.variants || [],
  };
}

function jsonResponse(status, body) {
  const text = JSON.stringify(body);
  return {
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "content-type" ? "application/json" : null) },
    async text() {
      return text;
    },
  };
}

function skuFromPath(path) {
  const clean = String(path).split("?")[0];
  const marker = "/products/";
  const index = clean.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(clean.slice(index + marker.length).replace(/\/variants$|\/stock$/, ""));
}

async function textFields(form) {
  const fields = {};
  if (!form?.entries) return fields;
  for (const [key, value] of form.entries()) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

setGiniCategoryRetryScale(0);
setGiniMediaFetch(async () => ({
  status: 200,
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key === "content-type") return "image/png";
      if (key === "content-length") return String(PNG.length);
      return null;
    },
  },
  async arrayBuffer() {
    return Uint8Array.from(PNG).buffer;
  },
}));
setGiniFetch(async (url, options = {}) => {
  const method = String(options.method || "GET").toUpperCase();
  const target = new URL(String(url));
  if (target.hostname !== "merchant.gini.iq") throw new Error(`fixture blocked live GINI host ${target.hostname}`);
  const path = target.pathname;
  writes.push({ method, path });
  if (method === "GET" && path.endsWith("/ping")) return jsonResponse(200, { data: { ok: true } });
  if (method === "GET" && path.endsWith("/categories")) return jsonResponse(200, TREE);
  if (method === "GET" && path.endsWith("/attributes/3696")) {
    return jsonResponse(200, { data: { id: "3696", name: "Color", values: [{ value: "Black" }, { value: "Blue" }, { value: "White" }] } });
  }
  if (method === "GET" && path.endsWith("/products")) {
    const searched = giniSkuKey(target.searchParams.get("search") || "");
    const found = searched ? remote.get(searched) : null;
    const data = found
      ? [{ id: found.id, sku: found.sku, price: found.price, quantity: found.quantity, is_visible: found.is_visible }]
      : [];
    return jsonResponse(200, { data, meta: { last_page: 1 } });
  }
  const sku = skuFromPath(path);
  const key = giniSkuKey(sku);
  const current = remote.get(key);
  if (method === "GET" && path.endsWith("/variants")) {
    if (!current) return jsonResponse(404, { message: "Product not found." });
    return jsonResponse(200, { data: current.variants || [] });
  }
  if (method === "GET" && path.includes("/products/")) {
    if (!current) return jsonResponse(404, { message: "Product not found." });
    return jsonResponse(200, { data: { id: current.id, sku: current.sku, price: current.price, quantity: current.quantity, is_visible: current.is_visible } });
  }
  if (method === "POST" && path.endsWith("/products")) {
    const fields = await textFields(options.body);
    const created = {
      id: fields.sku === "NEW-VAR" ? "801" : fields.sku === "NEW-IMPORT" ? "901" : "701",
      sku: fields.sku,
      price: Number(fields.price),
      quantity: Number(fields.quantity),
      is_visible: Number(fields.is_visible),
      variants: [],
    };
    remote.set(giniSkuKey(fields.sku), created);
    return jsonResponse(201, { data: { id: created.id, sku: created.sku } });
  }
  if (method === "PUT" && path.endsWith("/variants")) {
    const fields = await textFields(options.body);
    const rows = [];
    for (let index = 0; index < 10; index += 1) {
      const child = fields[`variants[${index}][sku]`];
      if (!child) continue;
      rows.push({
        id: String(810 + index),
        sku: child,
        price: Number(fields[`variants[${index}][price]`]),
        quantity: Number(fields[`variants[${index}][quantity]`]),
        attributes: [{ attribute_id: fields[`variants[${index}][attributes][0][attribute_id]`], value: fields[`variants[${index}][attributes][0][value]`] }],
      });
    }
    current.variants = rows;
    return jsonResponse(200, { data: rows });
  }
  if (method === "PUT") {
    const body = JSON.parse(String(options.body || "{}"));
    if (Object.hasOwn(body, "is_visible")) throw new Error("visibility write");
    if (body.price != null) current.price = body.price;
    if (body.quantity != null) current.quantity = body.quantity;
    return jsonResponse(200, { data: { id: current.id, sku: current.sku, price: current.price, quantity: current.quantity, is_visible: current.is_visible } });
  }
  if (method === "PATCH") {
    const body = JSON.parse(String(options.body || "{}"));
    if (Object.hasOwn(body, "is_visible")) throw new Error("visibility write");
    const row = (current.variants || []).find((item) => String(item.id) === String(body.variant_id));
    if (!row) return jsonResponse(404, { message: "missing variant" });
    if (body.price != null) row.price = body.price;
    if (body.quantity != null) row.quantity = body.quantity;
    return jsonResponse(200, { data: row });
  }
  return jsonResponse(404, { message: "unexpected" });
});

function simpleVariant() {
  return [{
    _id: new mongoose.Types.ObjectId(),
    color: { en: "white", ar: "", ku: "" },
    images: [{ url: "/uploads/products/simple.webp", isMain: true }],
    sizes: [{ _id: new mongoose.Types.ObjectId(), size: "medium", stockQuantity: 5 }],
  }];
}

function colors(itemCode) {
  return ["Black", "Blue"].map((color, index) => ({
    _id: new mongoose.Types.ObjectId(),
    color: { en: color, ar: color, ku: color },
    images: [{ url: `/uploads/products/${itemCode}-${color}.webp`, isMain: true }],
    sizes: [{ _id: new mongoose.Types.ObjectId(), size: "One", stockQuantity: index === 0 ? 4 : 3 }],
  }));
}

async function makeProduct(itemCode, variants, price) {
  return Product.create({
    ibsherId: `ibs-${itemCode}`,
    itemCode,
    name: { en: `${itemCode} name`, ar: `${itemCode} اسم`, ku: itemCode },
    description: { en: "English description.", ar: "وصف عربي للمنتج", ku: "وەسف" },
    price,
    discountPrice: 0,
    brand: { _id: "brand-cosrx", name: "COSRX" },
    category: { _id: "cat-beauty", name: { en: "Beauty" } },
    subCategory: { _id: "sub-skin", name: { en: "Skin" } },
    collectionName: { _id: "col-acne", name: { en: "Acne" } },
    isActive: true,
    variants,
  });
}

async function approveChildren(product) {
  for (const variant of product.variants) {
    for (const size of variant.sizes) {
      const sku = proposeVariantSku(product.itemCode, variant.color.en, size.size, { multipleSizes: false });
      await GiniVariantIdentity.create({
        productId: String(product._id),
        parentSku: product.itemCode,
        parentSkuKey: giniSkuKey(product.itemCode),
        sourceVariantId: String(variant._id),
        sourceSizeId: String(size._id),
        proposedSku: sku,
        proposedSkuKey: giniSkuKey(sku),
        approvedSku: sku,
        approvedSkuKey: giniSkuKey(sku),
        confirmedGiniVariantId: product.itemCode === "UPD-VAR" ? (variant.color.en === "Black" ? "301" : "302") : "",
        attributeId: "3696",
        attributeName: "Color",
        attributeValue: variant.color.en,
        status: "approved",
      });
    }
  }
}

const memory = await MongoMemoryServer.create();
await mongoose.connect(memory.getUri());
await seedAdmin();
await seedPartners();
await Partner.updateOne({ slug: "gini" }, { $set: { isActive: true } });
await PlatformTaxonomyConfig.create({
  partner: "gini",
  brownCollectionId: "col-acne",
  values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" },
});
await makeProduct("NEW-SIMPLE", simpleVariant(), 6500);
const createdVariant = await makeProduct("NEW-VAR", colors("NEW-VAR"), 1000);
const updatedVariant = await makeProduct("UPD-VAR", colors("UPD-VAR"), 1000);
await makeProduct("UPD-SIMPLE", simpleVariant(), 6500);
await makeProduct("NEW-EXTRA", simpleVariant(), 6500);
await makeProduct("BLOCKED-SIZE", [{
  _id: new mongoose.Types.ObjectId(),
  color: { en: "White", ar: "أبيض", ku: "سپی" },
  images: [{ url: "/uploads/products/blocked.webp", isMain: true }],
  sizes: [
    { _id: new mongoose.Types.ObjectId(), size: "small", stockQuantity: 1 },
    { _id: new mongoose.Types.ObjectId(), size: "medium", stockQuantity: 2 },
  ],
}], 1000);
await approveChildren(createdVariant);
await approveChildren(updatedVariant);
await GiniVariantParentOwner.create({
  skuKey: giniSkuKey("UPD-VAR"),
  parentSku: "UPD-VAR",
  productId: String(updatedVariant._id),
  giniProductId: "601",
  visibility: "visible",
  status: "verified_remote",
  approvalNote: "Fixture owner for an Excel-imported parent.",
});
remote.set("upd-simple", parentBody("UPD-SIMPLE", { id: "501", price: 6000, quantity: 5, visible: true }));
remote.set("upd-var", parentBody("UPD-VAR", {
  id: "601",
  price: 1000,
  quantity: 7,
  visible: true,
  variants: [
    { id: "301", sku: "UPD-VAR-BLACK", price: 750, quantity: 4, attributes: [{ attribute_id: "3696", value: "Black" }] },
    { id: "302", sku: "UPD-VAR-BLUE", price: 1000, quantity: 3, attributes: [{ attribute_id: "3696", value: "Blue" }] },
  ],
}));
await saveGiniConnection({ baseUrl: "https://merchant.gini.iq", clientId: "fixture-client", clientSecret: "fixture-secret-not-live" });
await GiniConnection.updateOne({ singletonKey: "default" }, {
  $set: { lastStatus: "connected", lastTestedAt: new Date(), lastSuccessAt: new Date(), lastCategoriesOk: true, lastCategoriesCount: 1 },
});

const starts = [];
const app = express();
app.use(cors({ origin: "http://localhost:5174", credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use((req, _res, next) => {
  if (req.method === "POST" && req.path === "/api/admin/platforms/gini/sync-all/unified/start") {
    starts.push({
      previewJobId: String(req.body?.previewJobId || ""),
      productIds: Array.isArray(req.body?.productIds) ? req.body.productIds.map(String) : null,
    });
  }
  next();
});
app.get("/api/health", (_req, res) => res.json({ ok: true, fixture: "gini-unified", productionWritesEnabled: false }));
app.post("/api/admin/fixture/gini-next", requireAdmin, async (_req, res) => {
  const existing = await Product.findOne({ itemCode: "NEW-IMPORT" }).lean();
  if (!existing) await makeProduct("NEW-IMPORT", simpleVariant(), 6500);
  await Product.updateOne({ itemCode: "UPD-SIMPLE" }, { $set: { price: 9000 } });
  res.json({ imported: "NEW-IMPORT", changed: "UPD-SIMPLE", price: 9000 });
});
app.get("/api/admin/fixture/gini-log", requireAdmin, (_req, res) => {
  res.json({
    writes: writes.filter((row) => row.method !== "GET"),
    starts,
    products: [...remote.values()].map((row) => ({ sku: row.sku, id: row.id, price: row.price, quantity: row.quantity, is_visible: row.is_visible })),
  });
});
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);
app.use("/api/partners", partnersRouter);

app.listen(PORT, "127.0.0.1", () => {
  console.log(`GINI fixture admin listening on http://127.0.0.1:${PORT}`);
});
