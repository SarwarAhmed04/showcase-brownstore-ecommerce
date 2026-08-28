import { Router } from "express";
import { Product } from "../models/Product.js";
import { Category } from "../models/Category.js";
import { requireAdmin } from "../middleware/auth.js";
import { toPublicProduct } from "../utils/productView.js";
import {
  fetchIbsherCategories,
  fetchIbsherProducts,
  mapIbsherProduct,
} from "../services/ibsher.js";

export const adminRouter = Router();
adminRouter.use(requireAdmin);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

adminRouter.get("/products", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    const q = String(req.query.q || "").trim();
    const filter = {};
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { "name.ku": rx },
        { "name.en": rx },
        { "name.ar": rx },
        { itemCode: rx },
        { "overrides.sku": rx },
      ];
    }

    const [items, total] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1 })
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
    res.status(500).json({ message: "Failed to load admin products" });
  }
});

adminRouter.patch("/products/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    const next = { ...(product.overrides?.toObject?.() || product.overrides || {}) };

    if ("sku" in req.body) {
      const sku = req.body.sku;
      next.sku = sku === "" || sku == null ? null : String(sku).trim();
    }
    if ("price" in req.body) {
      const price = req.body.price;
      next.price =
        price === "" || price == null ? null : Number(price);
      if (next.price != null && Number.isNaN(next.price)) {
        return res.status(400).json({ message: "Invalid price" });
      }
    }
    if ("stock" in req.body) {
      const stock = req.body.stock;
      next.stock =
        stock === "" || stock == null ? null : Number(stock);
      if (next.stock != null && Number.isNaN(next.stock)) {
        return res.status(400).json({ message: "Invalid stock" });
      }
    }

    product.overrides = next;
    await product.save();
    res.json({ product: toPublicProduct(product) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update product" });
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
            overrides: { sku: null, price: null, stock: null },
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

adminRouter.post("/sync", async (_req, res) => {
  try {
    const result = await syncFromIbsher();
    res.json({ message: "Sync complete", ...result });
  } catch (err) {
    console.error(err);
    res.status(502).json({ message: err.message || "Sync failed" });
  }
});
