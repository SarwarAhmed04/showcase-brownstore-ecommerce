import { Router } from "express";
import { Product } from "../models/Product.js";
import { toPublicProduct } from "../utils/productView.js";

export const productsRouter = Router();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

productsRouter.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(48, Math.max(1, Number(req.query.limit) || 24));
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();
    const sort = String(req.query.sort || "newest");

    const filter = { isActive: { $ne: false } };
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

    let sortSpec = { createdAt: -1 };
    if (sort === "price_asc") sortSpec = { price: 1 };
    if (sort === "price_desc") sortSpec = { price: -1 };
    if (sort === "name") sortSpec = { "name.en": 1 };

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
    ]);

    res.json({
      products: items.map(toPublicProduct),
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

productsRouter.get("/:id", async (req, res) => {
  try {
    const product =
      (await Product.findById(req.params.id).catch(() => null)) ||
      (await Product.findOne({ ibsherId: req.params.id }));

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const related = await Product.find({
      _id: { $ne: product._id },
      isActive: { $ne: false },
      "category._id": product.category?._id,
    }).limit(8);

    res.json({
      product: toPublicProduct(product),
      related: related.map(toPublicProduct),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load product" });
  }
});
