import { Router } from "express";
import { Category } from "../models/Category.js";
import { cdnUrl } from "../utils/productView.js";

export const categoriesRouter = Router();

categoriesRouter.get("/", async (_req, res) => {
  try {
    const categories = await Category.find({ isActive: { $ne: false } }).sort({
      createdAt: 1,
    });
    res.json({
      categories: categories.map((c) => ({
        id: c.ibsherId,
        name: c.name,
        image: cdnUrl(c.images?.[0]?.url),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load categories" });
  }
});
