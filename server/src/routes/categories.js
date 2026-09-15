import { Router } from "express";
import { Category } from "../models/Category.js";
import { Product } from "../models/Product.js";
import { getSiteSettings } from "../models/SiteSettings.js";
import { toPublicCategory } from "../utils/categoryView.js";
import { publicProductFilter } from "../utils/productView.js";

export const categoriesRouter = Router();

categoriesRouter.get("/", async (_req, res) => {
  try {
    const [categories, settings, counts] = await Promise.all([
      Category.find({ isActive: { $ne: false } }).sort({ createdAt: 1 }),
      getSiteSettings(),
      Product.aggregate([
        { $match: publicProductFilter() },
        { $group: { _id: "$category._id", count: { $sum: 1 } } },
      ]),
    ]);
    const countMap = Object.fromEntries(counts.map((row) => [String(row._id), row.count]));
    res.json({
      layout: settings.categoryLayout || "pills",
      categoryLimit: Number(settings.categoryLimit) || 0,
      categories: categories.map((doc) => {
        const item = toPublicCategory(doc);
        return { ...item, count: countMap[String(item.id)] || 0 };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load categories" });
  }
});
