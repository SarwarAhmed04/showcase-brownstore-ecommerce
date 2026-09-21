import { Router } from "express";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { CATEGORY_LAYOUTS, getSiteSettings } from "../models/SiteSettings.js";
import { requireAdmin } from "../middleware/auth.js";
import { isPrimaryAdmin, toAdminAccount, verifyApiKeyPin } from "../utils/adminUser.js";
import { User } from "../models/User.js";
import bcrypt from "bcryptjs";
import { toAdminProduct, toResolvedProduct } from "../utils/productView.js";
import {
  mergeOverridePatch,
  snapshotOverrides,
  overrideChanges,
  hasCustomOverrides,
  emptyOverrides,
} from "../utils/overrides.js";
import {
  removeLocalCategoryImage,
  removeLocalPartnerImage,
  saveCategoryImageFile,
  savePartnerImageFile,
  toAdminCategory,
} from "../utils/categoryView.js";
import { removeLocalBannerImage, saveBannerImageFile } from "../utils/bannerFiles.js";
import {
  Banner,
  applyCopy,
  applyDuration,
  copyFields,
  ensureBanners,
  isBannerAlign,
  isBannerSlot,
  pickLoc,
  sanitizeBannerLink,
  toAdminBanner,
} from "../models/Banner.js";
import {
  fetchIbsherCategories,
  fetchIbsherProducts,
  mapIbsherProduct,
} from "../services/ibsher.js";
import { Commission, COMMISSION_SCOPES } from "../models/Commission.js";
import { Partner } from "../models/Partner.js";
import { PlatformProduct } from "../models/PlatformProduct.js";
import {
  ALL_TARGET_ID,
  ALL_TARGET_NAME,
  commissionTargets,
  findTarget,
  sortCommissions,
  toAdminCommission,
} from "../utils/commission.js";
import {
  generateApiKey,
  isPartnerSlug,
  toAdminPartner,
  uniquePartnerSlug,
} from "../utils/partnerAuth.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { Activity } from "../models/Activity.js";
import {
  activityFilter,
  localizedName,
  logActivity,
  partnerDisplayName,
  toAdminActivity,
} from "../utils/activity.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

adminRouter.get("/stats", async (_req, res) => {
  try {
    const hidden = { "overrides.outOfStock": true };
    const [
      products,
      categories,
      featured,
      newArrivals,
      outOfStock,
      latest,
      recent,
    ] = await Promise.all([
      Product.countDocuments(),
      Category.countDocuments(),
      Product.countDocuments({ is_featured: true }),
      Product.countDocuments({ is_new_arrival: true }),
      Product.countDocuments(hidden),
      Product.findOne().sort({ lastSyncedAt: -1 }).select("lastSyncedAt"),
      Product.find().sort({ updatedAt: -1 }).limit(8),
    ]);
    res.json({
      products,
      categories,
      featured,
      newArrivals,
      outOfStock,
      visible: Math.max(0, products - outOfStock),
      lastSyncedAt: latest?.lastSyncedAt || null,
      recent: recent.map(toAdminProduct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load stats" });
  }
});

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const sellingPriceExpr = {
  $let: {
    vars: {
      override: { $ifNull: ["$overrides.price", null] },
      listed: { $ifNull: ["$price", 0] },
      disc: { $ifNull: ["$discountPrice", 0] },
    },
    in: {
      $cond: [
        { $ne: ["$$override", null] },
        "$$override",
        {
          $cond: [
            { $and: [{ $gt: ["$$disc", 0] }, { $lt: ["$$disc", "$$listed"] }] },
            "$$disc",
            "$$listed",
          ],
        },
      ],
    },
  },
};

function parseMoney(value) {
  if (value == null || String(value).trim() === "") return null;
  const raw = String(value).replace(/[^\d.]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function adminProductFilter(query) {
  const and = [];
  const q = String(query.q || "").trim();
  const brand = String(query.brand || "").trim();
  const category = String(query.category || "").trim();
  const availability = String(query.availability || "").trim();
  let minPrice = parseMoney(query.minPrice);
  let maxPrice = parseMoney(query.maxPrice);
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    const swap = minPrice;
    minPrice = maxPrice;
    maxPrice = swap;
  }

  if (q) {
    const rx = new RegExp(escapeRegex(q), "i");
    and.push({
      $or: [
        { "name.ku": rx },
        { "name.en": rx },
        { "name.ar": rx },
        { itemCode: rx },
        { "overrides.sku": rx },
        { "brand.name.ku": rx },
        { "brand.name.en": rx },
        { "brand.name.ar": rx },
        { keyword: rx },
      ],
    });
  }
  if (brand) {
    and.push({
      $expr: { $eq: [{ $toString: { $ifNull: ["$brand._id", ""] } }, brand] },
    });
  }
  if (category) {
    and.push({
      $expr: { $eq: [{ $toString: { $ifNull: ["$category._id", ""] } }, category] },
    });
  }
  if (availability === "out") and.push({ "overrides.outOfStock": true });
  if (availability === "in") and.push({ "overrides.outOfStock": { $ne: true } });

  const priceConds = [];
  if (minPrice != null) priceConds.push({ $gte: [sellingPriceExpr, minPrice] });
  if (maxPrice != null) priceConds.push({ $lte: [sellingPriceExpr, maxPrice] });
  if (priceConds.length === 1) and.push({ $expr: priceConds[0] });
  else if (priceConds.length > 1) and.push({ $expr: { $and: priceConds } });

  return and.length ? { $and: and } : {};
}

async function productFacets() {
  const [brands, categories] = await Promise.all([
    Product.aggregate([
      { $match: { "brand._id": { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { $toString: "$brand._id" },
          name: { $first: "$brand.name" },
        },
      },
      { $sort: { "name.en": 1, "name.ku": 1 } },
    ]),
    Product.aggregate([
      { $match: { "category._id": { $exists: true, $ne: null } } },
      {
        $group: {
          _id: { $toString: "$category._id" },
          name: { $first: "$category.name" },
        },
      },
      { $sort: { "name.en": 1, "name.ku": 1 } },
    ]),
  ]);
  return {
    brands: brands.map((item) => ({ id: item._id, name: item.name })),
    categories: categories.map((item) => ({ id: item._id, name: item.name })),
  };
}

adminRouter.get("/products", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const filter = adminProductFilter(req.query);

    const [items, total, facets] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
      productFacets(),
    ]);

    res.json({
      products: items.map(toAdminProduct),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
      facets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load admin products" });
  }
});

adminRouter.get("/activity", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const group = String(req.query.group || "").trim();
    const filter = activityFilter(group);
    const [items, total] = await Promise.all([
      Activity.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Activity.countDocuments(filter),
    ]);
    res.json({
      activities: items.map(toAdminActivity),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load activity" });
  }
});

adminRouter.get("/products/:id", async (req, res) => {
  try {
    const product =
      (await Product.findById(req.params.id).catch(() => null)) ||
      (await Product.findOne({ ibsherId: req.params.id }));
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }
    res.json({ product: toAdminProduct(product) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load product" });
  }
});

adminRouter.patch("/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const prev = product.overrides && typeof product.overrides === "object" ? product.overrides : {};
    const next = mergeOverridePatch(prev, req.body);
    const before = toResolvedProduct(product);
    product.overrides = next;
    product.markModified("overrides");
    const after = toResolvedProduct(product);
    const changes = overrideChanges(before, after);

    await product.save();
    if (changes.length) {
      await logActivity(req, "product.update", {
        productId: product._id.toString(),
        name: localizedName(product.name),
        sku: after.sku || product.itemCode || "",
        changes,
      });
    }
    res.json({ product: toAdminProduct(product) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: err.message || "Failed to update product" });
  }
});

adminRouter.get("/categories", async (_req, res) => {
  try {
    const [categories, settings] = await Promise.all([
      Category.find().sort({ createdAt: 1 }),
      getSiteSettings(),
    ]);
    res.json({
      layout: settings.categoryLayout || "pills",
      categoryLimit: Number(settings.categoryLimit) || 0,
      layouts: CATEGORY_LAYOUTS,
      categories: categories.map(toAdminCategory),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load categories" });
  }
});

adminRouter.patch("/settings", async (req, res) => {
  try {
    const settings = await getSiteSettings();
    if ("categoryLayout" in req.body) {
      const layout = String(req.body.categoryLayout || "");
      if (!CATEGORY_LAYOUTS.includes(layout)) {
        return res.status(400).json({ message: "Invalid layout" });
      }
      settings.categoryLayout = layout;
    }
    if ("categoryLimit" in req.body) {
      const n = Number(req.body.categoryLimit);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ message: "Invalid limit" });
      }
      settings.categoryLimit = Math.floor(n);
    }
    await settings.save();
    await logActivity(req, "settings.update", {
      categoryLayout: settings.categoryLayout,
      categoryLimit: settings.categoryLimit || 0,
    });
    res.json({
      layout: settings.categoryLayout,
      categoryLimit: settings.categoryLimit || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to save settings" });
  }
});

adminRouter.patch("/categories/:id", async (req, res) => {
  try {
    const category = await Category.findOne({ ibsherId: req.params.id });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }
    const next = {
      ...(category.overrides?.toObject?.() || category.overrides || {}),
      name: {
        ku: category.overrides?.name?.ku || "",
        en: category.overrides?.name?.en || "",
        ar: category.overrides?.name?.ar || "",
      },
      image: category.overrides?.image || "",
    };
    if (req.body.name && typeof req.body.name === "object") {
      next.name = {
        ku: String(req.body.name.ku ?? next.name.ku ?? "").trim(),
        en: String(req.body.name.en ?? next.name.en ?? "").trim(),
        ar: String(req.body.name.ar ?? next.name.ar ?? "").trim(),
      };
    }
    if (req.body.clearImage) {
      removeLocalCategoryImage(next.image);
      next.image = "";
    }
    category.overrides = next;
    await category.save();
    await logActivity(req, "category.update", {
      categoryId: category.ibsherId,
      name: localizedName(
        next.name?.ku || next.name?.en || next.name?.ar ? next.name : category.name
      ),
      clearedImage: Boolean(req.body.clearImage),
    });
    res.json({ category: toAdminCategory(category) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update category" });
  }
});

adminRouter.post("/categories/:id/image", async (req, res) => {
  try {
    const category = await Category.findOne({ ibsherId: req.params.id });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }
    const stored = saveCategoryImageFile(category.ibsherId, req.body.image);
    const next = {
      ...(category.overrides?.toObject?.() || category.overrides || {}),
      name: {
        ku: category.overrides?.name?.ku || "",
        en: category.overrides?.name?.en || "",
        ar: category.overrides?.name?.ar || "",
      },
      image: stored,
    };
    removeLocalCategoryImage(category.overrides?.image);
    category.overrides = next;
    await category.save();
    await logActivity(req, "category.image", {
      categoryId: category.ibsherId,
      name: localizedName(category.name),
    });
    res.json({ category: toAdminCategory(category) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: err.message || "Failed to upload image" });
  }
});

adminRouter.get("/banners", async (_req, res) => {
  try {
    const docs = await ensureBanners();
    res.json({ banners: docs.map(toAdminBanner) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load banners" });
  }
});

adminRouter.post("/banners/:slot/image", async (req, res) => {
  try {
    const slot = isBannerSlot(req.params.slot);
    if (!slot) return res.status(400).json({ message: "Slot must be 1 to 5" });
    const docs = await ensureBanners();
    const banner = docs.find((doc) => doc.slot === slot);
    const stored = saveBannerImageFile(slot, req.body.image);
    removeLocalBannerImage(banner.image);
    banner.image = stored;
    await banner.save();
    await logActivity(req, "banner.image", { slot });
    res.json({ banner: toAdminBanner(banner), banners: (await Banner.find().sort({ slot: 1 })).map(toAdminBanner) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: err.message || "Failed to upload banner" });
  }
});

adminRouter.delete("/banners/:slot/image", async (req, res) => {
  try {
    const slot = isBannerSlot(req.params.slot);
    if (!slot) return res.status(400).json({ message: "Slot must be 1 to 5" });
    const docs = await ensureBanners();
    const banner = docs.find((doc) => doc.slot === slot);
    removeLocalBannerImage(banner.image);
    banner.image = "";
    await banner.save();
    await logActivity(req, "banner.image", { slot, cleared: true });
    res.json({ banner: toAdminBanner(banner), banners: (await Banner.find().sort({ slot: 1 })).map(toAdminBanner) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to remove banner" });
  }
});

adminRouter.patch("/banners/:slot", async (req, res) => {
  try {
    const from = isBannerSlot(req.params.slot);
    if (!from) return res.status(400).json({ message: "Slot must be 1 to 5" });
    const docs = await ensureBanners();
    const source = docs.find((doc) => doc.slot === from);
    if (req.body.title) source.title = pickLoc(req.body.title, source.title);
    if (req.body.subtitle) source.subtitle = pickLoc(req.body.subtitle, source.subtitle);
    if (isBannerAlign(req.body.textAlign)) source.textAlign = req.body.textAlign;
    if ("link" in req.body) {
      const rawLink = String(req.body.link || "").trim();
      const link = sanitizeBannerLink(rawLink);
      if (rawLink && !link) return res.status(400).json({ message: "Invalid link" });
      source.link = link;
    }
    if ("duration" in req.body) applyDuration(source, req.body.duration);

    const to = isBannerSlot(req.body.slot);
    if (to && to !== from) {
      const target = docs.find((doc) => doc.slot === to);
      const sourceCopy = copyFields(source);
      applyCopy(source, copyFields(target));
      applyCopy(target, sourceCopy);
      await target.save();
    }

    await source.save();
    await logActivity(req, "banner.image", {
      slot: to && to !== from ? to : from,
      from: to && to !== from ? from : undefined,
    });
    res.json({ banners: (await Banner.find().sort({ slot: 1 })).map(toAdminBanner) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update banner" });
  }
});

export async function syncFromIbsher() {
  const [categories, products] = await Promise.all([
    fetchIbsherCategories(),
    fetchIbsherProducts(),
  ]);

  for (const cat of categories) {
    await Category.updateOne(
      { ibsherId: cat._id },
      {
        $set: {
          ibsherId: cat._id,
          name: cat.name,
          images: cat.images || [],
          isActive: cat.isActive !== false,
        },
      },
      { upsert: true }
    );
  }

  const ops = products.map((item) => {
    const mapped = mapIbsherProduct(item);
    return {
      updateOne: {
        filter: { ibsherId: mapped.ibsherId },
        update: {
          $set: mapped,
          $setOnInsert: {
            overrides: emptyOverrides(),
          },
        },
        upsert: true,
      },
    };
  });

  for (let i = 0; i < ops.length; i += 200) {
    await Product.bulkWrite(ops.slice(i, i + 200), { ordered: false });
  }

  return {
    categories: categories.length,
    products: products.length,
  };
}

adminRouter.post("/sync", async (req, res) => {
  try {
    const result = await syncFromIbsher();
    await logActivity(req, "catalog.sync", {
      products: result.products,
      categories: result.categories,
    });
    res.json({ message: "Sync complete", ...result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ message: err.message || "Sync failed" });
  }
});

function parsePercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < -99 || n > 500) return null;
  return Math.round(n * 100) / 100;
}

async function loadPartnerOr404(slug, res) {
  const value = String(slug || "").toLowerCase();
  if (!isPartnerSlug(value)) {
    res.status(400).json({ message: "Unknown partner" });
    return null;
  }
  const partner = await Partner.findOne({ slug: value });
  if (!partner) {
    res.status(404).json({ message: "Partner not found" });
    return null;
  }
  return partner;
}

async function partnerCounts() {
  const [ruleCounts, customCounts] = await Promise.all([
    Commission.aggregate([{ $group: { _id: "$partner", rules: { $sum: 1 } } }]),
    PlatformProduct.aggregate([{ $group: { _id: "$partner", customized: { $sum: 1 } } }]),
  ]);
  return {
    rules: Object.fromEntries(ruleCounts.map((row) => [row._id, row.rules])),
    customized: Object.fromEntries(customCounts.map((row) => [row._id, row.customized])),
  };
}

function withPartnerCounts(doc, req, counts) {
  return toAdminPartner(doc, req, {
    rulesCount: counts.rules[doc.slug] || 0,
    customizedCount: counts.customized[doc.slug] || 0,
  });
}

adminRouter.get("/partners", async (req, res) => {
  try {
    const [partners, counts] = await Promise.all([
      Partner.find().sort({ name: 1 }),
      partnerCounts(),
    ]);
    res.json({
      partners: partners.map((doc) => withPartnerCounts(doc, req, counts)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load partners" });
  }
});

adminRouter.get("/platforms", async (req, res) => {
  try {
    const [partners, counts] = await Promise.all([
      Partner.find().sort({ createdAt: 1, name: 1 }),
      partnerCounts(),
    ]);
    res.json({
      platforms: partners.map((doc) => withPartnerCounts(doc, req, counts)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load platforms" });
  }
});

adminRouter.post("/platforms", async (req, res) => {
  try {
    const name = String(req.body.name || req.body.title || "").trim();
    if (!name) {
      return res.status(400).json({ message: "Name is required" });
    }
    const slug = await uniquePartnerSlug(name);
    let image = "";
    if (req.body.image) {
      image = savePartnerImageFile(slug, req.body.image);
    }
    const partner = await Partner.create({
      slug,
      name,
      image,
      isActive: true,
    });
    await logActivity(req, "platform.create", {
      partner: partner.slug,
      partnerName: partner.name,
    });
    res.status(201).json({ platform: toAdminPartner(partner, req) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: err.message || "Failed to create platform" });
  }
});

adminRouter.patch("/platforms/:slug", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    if ("name" in req.body) {
      const name = String(req.body.name || "").trim();
      if (!name) return res.status(400).json({ message: "Name is required" });
      partner.name = name;
    }
    if ("isActive" in req.body) partner.isActive = Boolean(req.body.isActive);
    if (req.body.clearImage) {
      removeLocalPartnerImage(partner.image);
      partner.image = "";
    }
    if (req.body.image) {
      const stored = savePartnerImageFile(partner.slug, req.body.image);
      removeLocalPartnerImage(partner.image);
      partner.image = stored;
    }
    await partner.save();
    await logActivity(req, "platform.update", {
      partner: partner.slug,
      partnerName: partner.name,
    });
    res.json({ platform: toAdminPartner(partner, req) });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({ message: err.message || "Failed to update platform" });
  }
});

adminRouter.delete("/platforms/:slug", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    removeLocalPartnerImage(partner.image);
    await Promise.all([
      Commission.deleteMany({ partner: partner.slug }),
      PlatformProduct.deleteMany({ partner: partner.slug }),
      partner.deleteOne(),
    ]);
    await logActivity(req, "platform.delete", {
      partner: partner.slug,
      partnerName: partner.name,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete platform" });
  }
});

adminRouter.get("/platforms/:slug", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const [items, targets, counts] = await Promise.all([
      Commission.find({ partner: partner.slug }),
      commissionTargets(),
      partnerCounts(),
    ]);
    const dto = withPartnerCounts(partner, req, counts);
    res.json({
      platform: dto,
      partner: dto,
      commissions: sortCommissions(items.map(toAdminCommission)),
      targets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load platform" });
  }
});

function toPlatformProductDto(product, extra, rules) {
  const preview = partnerPricePreview(product, rules, extra);
  return {
    ...toAdminProduct(product, extra),
    platformOverrides: snapshotOverrides(extra),
    customized: hasCustomOverrides(extra),
    commissionRate: preview.rate,
    storePrice: preview.storePrice,
    platformPrice: preview.price,
    customPrice: preview.customPrice,
  };
}

adminRouter.get("/platforms/:slug/products", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const filter = adminProductFilter(req.query);
    const [items, total, facets, rules] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
      productFacets(),
      Commission.find({ partner: partner.slug, isActive: { $ne: false } }),
    ]);
    const rows = await PlatformProduct.find({
      partner: partner.slug,
      product: { $in: items.map((item) => item._id) },
    });
    const map = new Map(rows.map((row) => [String(row.product), row.overrides || {}]));
    res.json({
      platform: toAdminPartner(partner, req),
      products: items.map((item) => toPlatformProductDto(item, map.get(String(item._id)) || {}, rules)),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
      facets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load platform products" });
  }
});

adminRouter.get("/platforms/:slug/products/:id", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const product =
      (await Product.findById(req.params.id).catch(() => null)) ||
      (await Product.findOne({ ibsherId: req.params.id }));
    if (!product) return res.status(404).json({ message: "Product not found" });
    const [row, rules] = await Promise.all([
      PlatformProduct.findOne({ partner: partner.slug, product: product._id }),
      Commission.find({ partner: partner.slug, isActive: { $ne: false } }),
    ]);
    res.json({
      platform: toAdminPartner(partner, req),
      product: toPlatformProductDto(product, row?.overrides || {}, rules),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load platform product" });
  }
});

adminRouter.patch("/platforms/:slug/products/:id", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    const existing = await PlatformProduct.findOne({
      partner: partner.slug,
      product: product._id,
    });
    const next = mergeOverridePatch(existing?.overrides || {}, req.body);
    const row = await PlatformProduct.findOneAndUpdate(
      { partner: partner.slug, product: product._id },
      { $set: { partner: partner.slug, product: product._id, overrides: next } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const rules = await Commission.find({ partner: partner.slug, isActive: { $ne: false } });
    await logActivity(req, "platform.product", {
      partner: partner.slug,
      partnerName: partner.name,
      productId: product._id.toString(),
      name: localizedName(product.name),
    });
    res.json({
      product: toPlatformProductDto(product, row.overrides || {}, rules),
    });
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      message: err.message || "Failed to update platform product",
    });
  }
});

adminRouter.delete("/platforms/:slug/products/:id", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const product = await Product.findById(req.params.id);
    if (!product) return res.status(404).json({ message: "Product not found" });
    await PlatformProduct.deleteOne({ partner: partner.slug, product: product._id });
    const rules = await Commission.find({ partner: partner.slug, isActive: { $ne: false } });
    res.json({ product: toPlatformProductDto(product, {}, rules) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to reset platform product" });
  }
});

adminRouter.post("/partners/:slug/api-key", async (req, res) => {
  try {
    if (!isPrimaryAdmin(req.user)) {
      return res.status(403).json({ message: "Only the primary admin can manage API keys" });
    }
    if (!verifyApiKeyPin(req.body?.pin)) {
      return res.status(403).json({ message: "Invalid PIN" });
    }
    const partner = await loadPartnerOr404(String(req.params.slug || "").toLowerCase(), res);
    if (!partner) return;
    const hadKey = Boolean(partner.apiKeyHash);
    const generated = generateApiKey(partner.slug);
    partner.apiKeyHash = generated.hash;
    partner.apiKeyPrefix = generated.prefix;
    await partner.save();
    await logActivity(req, "partner.api_key", {
      partner: partner.slug,
      partnerName: partnerDisplayName(partner.slug),
      regenerated: hadKey,
    });
    res.json({
      partner: toAdminPartner(partner, req),
      apiKey: generated.key,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to generate API key" });
  }
});

adminRouter.get("/commissions", async (req, res) => {
  try {
    const partnerSlug = String(req.query.partner || "").toLowerCase();
    if (!partnerSlug) {
      const [partners, counts] = await Promise.all([
        Partner.find().sort({ name: 1 }),
        partnerCounts(),
      ]);
      return res.json({
        partners: partners.map((doc) => withPartnerCounts(doc, req, counts)),
      });
    }

    const partner = await loadPartnerOr404(partnerSlug, res);
    if (!partner) return;

    const [items, targets] = await Promise.all([
      Commission.find({ partner: partner.slug }),
      commissionTargets(),
    ]);
    res.json({
      partner: toAdminPartner(partner, req),
      platform: toAdminPartner(partner, req),
      commissions: sortCommissions(items.map(toAdminCommission)),
      targets,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load commissions" });
  }
});

adminRouter.post("/commissions", async (req, res) => {
  try {
    const partnerSlug = String(req.body.partner || req.query.partner || "").toLowerCase();
    const partner = await loadPartnerOr404(partnerSlug, res);
    if (!partner) return;

    const scope = String(req.body.scope || "");
    const percentage = parsePercentage(req.body.percentage);
    if (!COMMISSION_SCOPES.includes(scope)) {
      return res.status(400).json({ message: "Invalid scope" });
    }
    if (percentage == null) {
      return res.status(400).json({ message: "Invalid percentage" });
    }

    let targetId = String(req.body.targetId || "").trim();
    if (scope === "all") targetId = ALL_TARGET_ID;
    if (!targetId) {
      return res.status(400).json({ message: "Select a target" });
    }

    const targets = await commissionTargets();
    const target = findTarget(targets, scope, targetId);
    if (!target) {
      return res.status(404).json({ message: "Target not found" });
    }

    const categoryId =
      scope === "all" ? "" : scope === "category" ? target.id : target.categoryId || "";
    const subCategoryId =
      scope === "collection"
        ? target.subCategoryId || ""
        : scope === "subcategory"
          ? target.id
          : "";

    const item = await Commission.findOneAndUpdate(
      { partner: partner.slug, scope, targetId },
      {
        $set: {
          partner: partner.slug,
          scope,
          targetId,
          targetName: scope === "all" ? ALL_TARGET_NAME : target.name,
          categoryId,
          subCategoryId,
          percentage,
          isActive: req.body.isActive !== false,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await logActivity(req, "commission.save", {
      partner: partner.slug,
      partnerName: partnerDisplayName(partner.slug),
      scope,
      targetName: localizedName(scope === "all" ? ALL_TARGET_NAME : target.name),
      percentage,
      isActive: item.isActive !== false,
    });

    res.json({ commission: toAdminCommission(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to save commission" });
  }
});

adminRouter.patch("/commissions/:id", async (req, res) => {
  try {
    const item = await Commission.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Commission not found" });
    }
    if ("percentage" in req.body) {
      const percentage = parsePercentage(req.body.percentage);
      if (percentage == null) {
        return res.status(400).json({ message: "Invalid percentage" });
      }
      item.percentage = percentage;
    }
    if ("isActive" in req.body) {
      item.isActive = Boolean(req.body.isActive);
    }
    await item.save();
    await logActivity(req, "commission.toggle", {
      partner: item.partner,
      partnerName: partnerDisplayName(item.partner),
      scope: item.scope,
      targetName: localizedName(item.scope === "all" ? ALL_TARGET_NAME : item.targetName),
      percentage: item.percentage,
      isActive: item.isActive !== false,
    });
    res.json({ commission: toAdminCommission(item) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update commission" });
  }
});

adminRouter.delete("/commissions/:id", async (req, res) => {
  try {
    const item = await Commission.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ message: "Commission not found" });
    }
    const snapshot = {
      partner: item.partner,
      partnerName: partnerDisplayName(item.partner),
      scope: item.scope,
      targetName: localizedName(item.scope === "all" ? ALL_TARGET_NAME : item.targetName),
      percentage: item.percentage,
    };
    await item.deleteOne();
    await logActivity(req, "commission.delete", snapshot);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete commission" });
  }
});

adminRouter.get("/accounts", async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: 1 });
    res.json({
      canDelete: isPrimaryAdmin(req.user),
      accounts: users.map(toAdminAccount),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load accounts" });
  }
});

adminRouter.post("/accounts", async (req, res) => {
  try {
    const email = String(req.body.email || "").toLowerCase().trim();
    const password = String(req.body.password || "");
    if (!email || !email.includes("@")) {
      return res.status(400).json({ message: "Invalid email" });
    }
    if (password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters" });
    }
    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(409).json({ message: "Email already exists" });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({ email, passwordHash, role: "admin" });
    await logActivity(req, "account.create", { email });
    res.status(201).json({ account: toAdminAccount(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to create account" });
  }
});

adminRouter.delete("/accounts/:id", async (req, res) => {
  try {
    if (!isPrimaryAdmin(req.user)) {
      return res.status(403).json({ message: "Only the primary admin can delete accounts" });
    }
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "Account not found" });
    }
    if (isPrimaryAdmin(user)) {
      return res.status(400).json({ message: "The primary admin cannot be deleted" });
    }
    const email = String(user.email || "").toLowerCase();
    await user.deleteOne();
    await logActivity(req, "account.delete", { email });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to delete account" });
  }
});
