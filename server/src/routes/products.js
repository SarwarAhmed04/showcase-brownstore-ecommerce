import { Router } from "express";
import { Product } from "../models/Product.js";
import { toPublicProduct, publicProductFilter, isPubliclyVisible } from "../utils/productView.js";

export const productsRouter = Router();

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function listParam(value) {
  return []
    .concat(value || [])
    .flatMap((item) => String(item).split(","))
    .map((item) => item.trim())
    .filter(Boolean);
}

function applyCatalogFilters(filter, query) {
  const ids = listParam(query.ids);
  const categories = listParam(query.category);
  const brands = listParam(query.brand);
  const q = String(query.q || "").trim();
  const deals = String(query.deals || "") === "1";

  if (ids.length) {
    filter.$or = [
      { _id: { $in: ids.filter((id) => id.length === 24) } },
      { ibsherId: { $in: ids } },
    ];
  }
  if (categories.length) {
    filter["category._id"] = categories.length === 1 ? categories[0] : { $in: categories };
  }
  if (brands.length) {
    filter.$and = (filter.$and || []).concat([
      {
        $or: [
          { "brand._id": { $in: brands } },
          { "brand.name.en": { $in: brands } },
          { "brand.name.ku": { $in: brands } },
          { "brand.name.ar": { $in: brands } },
        ],
      },
    ]);
  }
  if (deals) {
    const dealMatch = {
      $or: [
        { discountPrice: { $gt: 0 } },
        { is_hot: true },
        { "overrides.is_hot": true },
        { badge: { $nin: [null, ""] } },
      ],
    };
    filter.$and = (filter.$and || []).concat([dealMatch]);
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
  return filter;
}

function sortSpecFor(sort) {
  if (sort === "name") return { "name.en": 1 };
  if (sort === "discount") return { is_hot: -1, discountPrice: -1, createdAt: -1 };
  if (sort === "featured") return { is_featured: -1, is_best_seller: -1, createdAt: -1 };
  return { createdAt: -1 };
}

productsRouter.get("/", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const sort = String(req.query.sort || "newest");
    const filter = applyCatalogFilters(publicProductFilter(), req.query);

    const facetFilter = applyCatalogFilters(publicProductFilter(), {
      q: req.query.q,
      deals: req.query.deals,
      ids: req.query.ids,
      category: listParam(req.query.category).length <= 1 ? req.query.category : undefined,
    });

    const [items, total, facetRows] = await Promise.all([
      Product.find(filter)
        .sort(sortSpecFor(sort))
        .skip((page - 1) * limit)
        .limit(limit),
      Product.countDocuments(filter),
      Product.aggregate([
        { $match: facetFilter },
        {
          $facet: {
            brands: [
              { $match: { "brand.name.en": { $nin: [null, ""] } } },
              {
                $group: {
                  _id: {
                    id: "$brand._id",
                    en: "$brand.name.en",
                    ku: "$brand.name.ku",
                    ar: "$brand.name.ar",
                  },
                  count: { $sum: 1 },
                },
              },
              { $sort: { count: -1 } },
              { $limit: 48 },
            ],
            categories: [
              { $group: { _id: "$category._id", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
            ],
          },
        },
      ]),
    ]);

    const facets = facetRows[0] || { brands: [], categories: [] };

    res.json({
      products: items.map(toPublicProduct).filter(Boolean),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit) || 1,
      },
      facets: {
        brands: (facets.brands || []).map((row) => ({
          id: String(row._id?.id || row._id?.en || ""),
          name: {
            en: row._id?.en || "",
            ku: row._id?.ku || "",
            ar: row._id?.ar || "",
          },
          count: row.count,
        })),
        categories: (facets.categories || []).map((row) => ({
          id: String(row._id || ""),
          count: row.count,
        })),
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

    if (!product || !isPubliclyVisible(product)) {
      return res.status(404).json({ message: "Product not found" });
    }

    const related = await Product.find({
      _id: { $ne: product._id },
      ...publicProductFilter(),
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
