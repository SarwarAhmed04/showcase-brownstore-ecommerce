import { Router } from "express";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { Commission } from "../models/Commission.js";
import { PlatformProduct } from "../models/PlatformProduct.js";
import { publicProductFilter, isPubliclyVisible } from "../utils/productView.js";
import { toPublicCategory } from "../utils/categoryView.js";
import { requirePartner, requestOrigin } from "../utils/partnerAuth.js";
import { toPartnerProduct } from "../utils/partnerCatalog.js";

export const partnersRouter = Router();

partnersRouter.use("/:slug", requirePartner);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function absolutize(origin, url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${origin}${path}`;
}

async function loadPartnerRules(slug) {
  return Commission.find({ partner: slug, isActive: { $ne: false } });
}

async function overrideMapFor(slug, productIds) {
  if (!productIds.length) return new Map();
  const rows = await PlatformProduct.find({
    partner: slug,
    product: { $in: productIds },
  });
  return new Map(rows.map((row) => [String(row.product), row.overrides || {}]));
}

partnersRouter.get("/:slug/products", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();
    const origin = requestOrigin(req);
    const slug = req.partner.slug;

    const filter = publicProductFilter();
    if (category) {
      filter["category._id"] = category;
    }
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { "name.ku": rx },
        { "name.en": rx },
        { "name.ar": rx },
        { itemCode: rx },
        { "overrides.sku": rx },
        { keyword: rx },
      ];
    }

    const [items, total, rules] = await Promise.all([
      Product.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
      loadPartnerRules(slug),
    ]);

    const overrides = await overrideMapFor(
      slug,
      items.map((item) => item._id)
    );

    const products = items
      .map((item) => {
        const extra = overrides.get(String(item._id));
        if (!isPubliclyVisible(item, extra)) return null;
        return toPartnerProduct(item, rules, origin, extra);
      })
      .filter(Boolean);

    res.json({
      partner: slug,
      products,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load products" });
  }
});

partnersRouter.get("/:slug/products/:id", async (req, res) => {
  try {
    const origin = requestOrigin(req);
    const slug = req.partner.slug;
    const product =
      (await Product.findById(req.params.id).catch(() => null)) ||
      (await Product.findOne({ ibsherId: req.params.id }));

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const row = await PlatformProduct.findOne({ partner: slug, product: product._id });
    const extra = row?.overrides || {};
    if (!isPubliclyVisible(product, extra)) {
      return res.status(404).json({ message: "Product not found" });
    }

    const rules = await loadPartnerRules(slug);
    res.json({
      partner: slug,
      product: toPartnerProduct(product, rules, origin, extra),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load product" });
  }
});

partnersRouter.get("/:slug/categories", async (req, res) => {
  try {
    const origin = requestOrigin(req);
    const categories = await Category.find({ isActive: { $ne: false } }).sort({
      createdAt: 1,
    });
    res.json({
      partner: req.partner.slug,
      categories: categories.map((doc) => {
        const item = toPublicCategory(doc);
        return { ...item, image: absolutize(origin, item.image) };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load categories" });
  }
});
