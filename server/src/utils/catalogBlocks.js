import { CatalogBlock } from "../models/CatalogBlock.js";
import { Product } from "../models/Product.js";
import { entityId } from "./platformEligibility.js";

const CACHE_TTL_MS = 5000;
let cache = { at: 0, value: null };

function cleanId(value) {
  return String(value || "").trim();
}

export function emptyCatalogBlocks() {
  return {
    vendors: new Set(),
    vendorBrands: new Set(),
  };
}

export function vendorBrandKey(vendorId, brandId) {
  return `${cleanId(vendorId)}\0${cleanId(brandId)}`;
}

export function invalidateCatalogBlockCache() {
  cache = { at: 0, value: null };
}

export async function loadCatalogBlocks({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_TTL_MS) return cache.value;
  const rows = await CatalogBlock.find({}).select("vendorId brandId").lean();
  const blocks = emptyCatalogBlocks();
  for (const row of rows) {
    const vendorId = cleanId(row.vendorId);
    if (!vendorId) continue;
    const brandId = cleanId(row.brandId);
    if (!brandId) blocks.vendors.add(vendorId);
    else blocks.vendorBrands.add(vendorBrandKey(vendorId, brandId));
  }
  cache = { at: now, value: blocks };
  return blocks;
}

export function productCatalogIds(product) {
  const raw = typeof product?.toObject === "function" ? product.toObject() : product || {};
  return {
    vendorId: entityId(raw.createdBy),
    brandId: entityId(raw.brand),
  };
}

export function isCatalogBlocked(product, blocks) {
  if (!blocks) return false;
  const { vendorId, brandId } = productCatalogIds(product);
  if (!vendorId) return false;
  if (blocks.vendors?.has(vendorId)) return true;
  if (brandId && blocks.vendorBrands?.has(vendorBrandKey(vendorId, brandId))) return true;
  return false;
}

function idExpr(path) {
  return { $toString: { $ifNull: [`$${path}`, ""] } };
}

/** Mongo clause that keeps only products NOT blocked by catalog rules. */
export function catalogBlockMongoClause(blocks) {
  if (!blocks) return null;
  const vendors = [...(blocks.vendors || [])].map(cleanId).filter(Boolean);
  const pairs = [...(blocks.vendorBrands || [])]
    .map((key) => {
      const [vendorId, brandId] = String(key).split("\0");
      return { vendorId: cleanId(vendorId), brandId: cleanId(brandId) };
    })
    .filter((row) => row.vendorId && row.brandId);

  const nor = [];
  if (vendors.length) {
    nor.push({ $expr: { $in: [idExpr("createdBy._id"), vendors] } });
  }
  for (const pair of pairs) {
    nor.push({
      $expr: {
        $and: [
          { $eq: [idExpr("createdBy._id"), pair.vendorId] },
          { $eq: [idExpr("brand._id"), pair.brandId] },
        ],
      },
    });
  }
  if (!nor.length) return null;
  return nor.length === 1 ? { $nor: nor } : { $nor: nor };
}

export function mergeCatalogBlocksIntoFilter(filter, blocks) {
  const clause = catalogBlockMongoClause(blocks);
  if (!clause) return filter && typeof filter === "object" ? filter : {};
  if (!filter || typeof filter !== "object" || !Object.keys(filter).length) return clause;
  return { $and: [filter, clause] };
}

function localizedName(value, fallback = "") {
  if (value && typeof value === "object") {
    return {
      en: String(value.en || value.ku || value.ar || fallback),
      ku: String(value.ku || value.en || value.ar || fallback),
      ar: String(value.ar || value.en || value.ku || fallback),
    };
  }
  const text = String(value || fallback || "").trim();
  return { en: text, ku: text, ar: text };
}

export async function listVendorControlRows({ q = "" } = {}) {
  const needle = cleanId(q).toLowerCase();
  const [blocks, groups] = await Promise.all([
    loadCatalogBlocks({ force: true }),
    Product.aggregate([
      {
        $group: {
          _id: {
            vendorId: { $toString: { $ifNull: ["$createdBy._id", ""] } },
            brandId: { $toString: { $ifNull: ["$brand._id", ""] } },
          },
          products: { $sum: 1 },
          vendorName: { $first: "$createdBy.name" },
          vendorEmail: { $first: "$createdBy.email" },
          brandName: { $first: "$brand.name" },
        },
      },
    ]).allowDiskUse(true),
  ]);

  const byVendor = new Map();
  for (const row of groups) {
    const vendorId = cleanId(row._id?.vendorId);
    if (!vendorId) continue;
    const brandId = cleanId(row._id?.brandId);
    let vendor = byVendor.get(vendorId);
    if (!vendor) {
      const fallback =
        (typeof row.vendorName === "string" && row.vendorName) ||
        (typeof row.vendorEmail === "string" && row.vendorEmail.trim()) ||
        vendorId;
      vendor = {
        id: vendorId,
        name: localizedName(row.vendorName, fallback),
        productCount: 0,
        active: !blocks.vendors.has(vendorId),
        brands: [],
      };
      byVendor.set(vendorId, vendor);
    }
    vendor.productCount += Number(row.products) || 0;
    if (!brandId) continue;
    const brandBlocked = blocks.vendorBrands.has(vendorBrandKey(vendorId, brandId));
    vendor.brands.push({
      id: brandId,
      name: localizedName(row.brandName, brandId),
      productCount: Number(row.products) || 0,
      active: vendor.active ? !brandBlocked : false,
      blockedByVendor: !vendor.active,
    });
  }

  let rows = [...byVendor.values()].map((vendor) => {
    vendor.brands.sort((a, b) =>
      String(a.name.en || a.id).localeCompare(String(b.name.en || b.id), undefined, {
        sensitivity: "base",
      })
    );
    return vendor;
  });
  rows.sort((a, b) =>
    String(a.name.en || a.id).localeCompare(String(b.name.en || b.id), undefined, {
      sensitivity: "base",
    })
  );

  if (needle) {
    rows = rows.filter((vendor) => {
      const vendorText = `${vendor.name.en} ${vendor.name.ku} ${vendor.name.ar} ${vendor.id}`.toLowerCase();
      if (vendorText.includes(needle)) return true;
      return vendor.brands.some((brand) =>
        `${brand.name.en} ${brand.name.ku} ${brand.name.ar} ${brand.id}`.toLowerCase().includes(needle)
      );
    });
  }

  return {
    rows,
    counts: {
      vendors: rows.length,
      inactiveVendors: rows.filter((row) => !row.active).length,
      inactiveBrands: rows.reduce(
        (sum, row) => sum + row.brands.filter((brand) => !brand.active && !brand.blockedByVendor).length,
        0
      ),
    },
  };
}

export async function setVendorBlock(vendorId, active) {
  const id = cleanId(vendorId);
  if (!id) {
    const error = new Error("Choose a vendor");
    error.status = 400;
    throw error;
  }
  if (active) {
    await CatalogBlock.deleteOne({ vendorId: id, brandId: "" });
  } else {
    await CatalogBlock.findOneAndUpdate(
      { vendorId: id, brandId: "" },
      { $set: { vendorId: id, brandId: "" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  invalidateCatalogBlockCache();
  return { vendorId: id, active: Boolean(active), scope: "vendor" };
}

export async function setVendorBrandBlock(vendorId, brandId, active) {
  const vendor = cleanId(vendorId);
  const brand = cleanId(brandId);
  if (!vendor) {
    const error = new Error("Choose a vendor");
    error.status = 400;
    throw error;
  }
  if (!brand) {
    const error = new Error("Choose a brand");
    error.status = 400;
    throw error;
  }
  const vendorBlocked = await CatalogBlock.exists({ vendorId: vendor, brandId: "" });
  if (vendorBlocked) {
    const error = new Error("Re-activate the vendor before changing brand availability");
    error.status = 409;
    error.code = "vendor_inactive";
    throw error;
  }
  if (active) {
    await CatalogBlock.deleteOne({ vendorId: vendor, brandId: brand });
  } else {
    await CatalogBlock.findOneAndUpdate(
      { vendorId: vendor, brandId: brand },
      { $set: { vendorId: vendor, brandId: brand } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
  invalidateCatalogBlockCache();
  return { vendorId: vendor, brandId: brand, active: Boolean(active), scope: "vendor_brand" };
}
