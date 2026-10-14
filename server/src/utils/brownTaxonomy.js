import { Product } from "../models/Product.js";

function localizedName(name) {
  if (typeof name === "string") {
    const value = name.trim();
    return { ku: value, en: value, ar: value };
  }
  const fallback = String(name?.en || name?.ku || name?.ar || "").trim();
  return {
    ku: String(name?.ku || fallback),
    en: String(name?.en || fallback),
    ar: String(name?.ar || fallback),
  };
}

function cleanIds(ids) {
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

export async function collectionDiagnostics() {
  const [row] = await Product.aggregate([
    {
      $group: {
        _id: null,
        totalProducts: { $sum: 1 },
        productsWithCollection: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $ifNull: ["$collectionName._id", null] }, null] },
                  { $ne: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, ""] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);
  const totalProducts = Number(row?.totalProducts) || 0;
  const productsWithCollection = Number(row?.productsWithCollection) || 0;
  const distinct = await Product.distinct("collectionName._id", {
    "collectionName._id": { $exists: true, $nin: [null, ""] },
  });
  return {
    totalProducts,
    productsWithCollection,
    productsWithoutCollection: Math.max(0, totalProducts - productsWithCollection),
    distinctCollections: distinct.filter((id) => id != null && String(id).trim() !== "").length,
  };
}

export async function discoverBrownCollections() {
  const [rows, diagnostics] = await Promise.all([
    Product.aggregate([
      {
        $match: {
          "collectionName._id": { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: { $toString: "$collectionName._id" },
          name: { $first: "$collectionName.name" },
          subCategoryId: {
            $first: { $toString: { $ifNull: ["$subCategory._id", ""] } },
          },
          subCategoryName: { $first: "$subCategory.name" },
          subCategoryIds: {
            $addToSet: { $toString: { $ifNull: ["$subCategory._id", ""] } },
          },
          categoryId: { $first: { $toString: { $ifNull: ["$category._id", ""] } } },
          categoryName: { $first: "$category.name" },
          categoryIds: {
            $addToSet: { $toString: { $ifNull: ["$category._id", ""] } },
          },
          productCount: { $sum: 1 },
        },
      },
      { $sort: { "name.en": 1, "name.ku": 1, "name.ar": 1 } },
    ]),
    collectionDiagnostics(),
  ]);

  const collections = rows
    .filter((row) => row._id)
    .map((row) => {
      const categoryIds = cleanIds(row.categoryIds);
      const subCategoryIds = cleanIds(row.subCategoryIds);
      return {
        brownCollectionId: String(row._id),
        brownCollectionName: localizedName(row.name),
        brownSubCategoryId: String(row.subCategoryId || ""),
        brownSubCategoryName: localizedName(row.subCategoryName),
        brownCategoryId: String(row.categoryId || ""),
        brownCategoryName: localizedName(row.categoryName),
        productCount: Number(row.productCount) || 0,
        ambiguousHierarchy: categoryIds.length > 1 || subCategoryIds.length > 1,
      };
    });

  return { collections, diagnostics };
}
