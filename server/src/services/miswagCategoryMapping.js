import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "../models/PlatformTaxonomyNotice.js";
import { Product } from "../models/Product.js";
import { discoverBrownCollections } from "../utils/brownTaxonomy.js";
import { productScopeIds } from "../utils/platformEligibility.js";
import { isTaxonomyComplete } from "../utils/platformTaxonomyFields.js";
import { resolveTaxonomyNotices } from "../utils/taxonomyNotices.js";
import { MiswagError, miswagCategoryLevel } from "./miswag.js";

const PARTNER = "miswag";

function clean(value) {
  return String(value || "").trim();
}

function localizedText(name) {
  if (typeof name === "string") return name;
  return [name?.en, name?.ku, name?.ar].map((value) => String(value || "")).join(" ");
}

function joinPath(parts) {
  return parts.map((part) => clean(localizedText(part))).filter(Boolean).join(" → ");
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function paginate(rows, page, limit) {
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / limit) || 1);
  const safePage = Math.min(Math.max(1, page), pages);
  return {
    rows: rows.slice((safePage - 1) * limit, safePage * limit),
    pagination: { page: safePage, limit, total, pages },
  };
}

/** Valid Miswag leaf category IDs for product create: L3-... or L4-... */
export function isValidMiswagMappedCategoryId(categoryId) {
  const id = clean(categoryId);
  const level = miswagCategoryLevel(id);
  return Boolean(id) && (level === "L3" || level === "L4");
}

export function normalizeMiswagMappingValues(input = {}) {
  const categoryId = clean(input.categoryId || input.miswagCategoryId || input.id);
  if (!isValidMiswagMappedCategoryId(categoryId)) {
    throw new MiswagError("Miswag category_id must be an L3-... or L4-... id.", {
      status: 400,
      code: "invalid_category_id",
    });
  }
  const level = miswagCategoryLevel(categoryId) || clean(input.categoryLevel || input.level);
  return {
    categoryId,
    categoryName: clean(input.categoryName || input.name).slice(0, 500),
    categoryPath: clean(input.categoryPath || input.path).slice(0, 1000),
    categoryLevel: level,
  };
}

export async function loadMiswagCategoryMappingMap() {
  const rows = await PlatformTaxonomyConfig.find({ partner: PARTNER })
    .select("brownCollectionId values")
    .lean();
  const map = new Map();
  for (const row of rows) {
    const collectionId = clean(row.brownCollectionId);
    const values = row.values || {};
    const categoryId = clean(values.categoryId);
    if (!collectionId || !isValidMiswagMappedCategoryId(categoryId)) continue;
    map.set(collectionId, {
      categoryId,
      categoryName: clean(values.categoryName),
      categoryPath: clean(values.categoryPath),
      categoryLevel: clean(values.categoryLevel) || miswagCategoryLevel(categoryId),
    });
  }
  return map;
}

export function resolveMappedMiswagCategory(product, mappingByCollection) {
  const collectionId = productScopeIds(product).collection;
  if (!collectionId) {
    return {
      ok: false,
      reason: "Miswag category mapping missing",
      code: "category_mapping_missing",
    };
  }
  const mapped = mappingByCollection?.get?.(collectionId);
  if (!mapped?.categoryId || !isValidMiswagMappedCategoryId(mapped.categoryId)) {
    return {
      ok: false,
      reason: "Miswag category mapping missing",
      code: "category_mapping_missing",
    };
  }
  return {
    ok: true,
    category: {
      id: mapped.categoryId,
      name: mapped.categoryName || mapped.categoryId,
      path: mapped.categoryPath || "",
      level: mapped.categoryLevel || miswagCategoryLevel(mapped.categoryId),
      source: "manual_mapping",
    },
  };
}

async function countOpenCollectionNotices() {
  return PlatformTaxonomyNotice.countDocuments({
    partner: PARTNER,
    status: "open",
    scope: "collection",
  });
}

async function listOpenCollectionNotices(limit = 100) {
  const [notices, count] = await Promise.all([
    PlatformTaxonomyNotice.find({
      partner: PARTNER,
      status: "open",
      scope: "collection",
    })
      .sort({ firstSeenAt: -1 })
      .limit(limit)
      .lean(),
    countOpenCollectionNotices(),
  ]);
  return {
    count,
    notices: notices.map((row) => ({
      id: String(row._id),
      partner: row.partner,
      scope: row.scope,
      targetId: row.targetId,
      name: row.name || "",
      path: row.path || "",
      firstSeenAt: row.firstSeenAt,
      status: row.status,
      message: "New BrownStore collection needs Miswag category mapping",
    })),
  };
}

export async function listMiswagCategoryMappings({
  q = "",
  status = "all",
  page = 1,
  limit = 20,
} = {}) {
  const [{ collections }, configs, openNotices] = await Promise.all([
    discoverBrownCollections(),
    PlatformTaxonomyConfig.find({ partner: PARTNER }).lean(),
    listOpenCollectionNotices(100),
  ]);
  const byCollection = new Map(
    configs.map((row) => [clean(row.brownCollectionId), row.values || {}])
  );

  let rows = collections.map((row) => {
    const id = clean(row.brownCollectionId);
    const values = byCollection.get(id) || {};
    const mapped = isTaxonomyComplete(PARTNER, values);
    const path = joinPath([row.brownCategoryName, row.brownSubCategoryName, row.brownCollectionName]);
    return {
      id,
      brownCollectionId: id,
      name: row.brownCollectionName,
      categoryName: row.brownCategoryName,
      subCategoryName: row.brownSubCategoryName,
      path,
      productCount: Number(row.productCount) || 0,
      mapped,
      status: mapped ? "mapped" : "missing",
      miswag: mapped
        ? {
            categoryId: clean(values.categoryId),
            categoryName: clean(values.categoryName),
            categoryPath: clean(values.categoryPath),
            categoryLevel: clean(values.categoryLevel) || miswagCategoryLevel(values.categoryId),
          }
        : null,
      values,
    };
  });

  const mappedCount = rows.filter((row) => row.mapped).length;
  const needle = clean(q).toLowerCase();
  if (needle) {
    rows = rows.filter((row) => {
      const hay = [
        row.path,
        localizedText(row.name),
        localizedText(row.categoryName),
        localizedText(row.subCategoryName),
        row.miswag?.categoryId,
        row.miswag?.categoryName,
        row.miswag?.categoryPath,
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }
  if (status === "mapped" || status === "configured") rows = rows.filter((row) => row.mapped);
  if (status === "missing" || status === "unmapped") rows = rows.filter((row) => !row.mapped);

  rows.sort((a, b) => {
    if (a.mapped !== b.mapped) return a.mapped ? 1 : -1;
    return a.path.localeCompare(b.path);
  });

  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
  const safePage = Math.max(1, Number(page) || 1);

  return {
    ...paginate(rows, safePage, safeLimit),
    counts: {
      total: collections.length,
      mapped: mappedCount,
      missing: Math.max(0, collections.length - mappedCount),
      newCollectionAlerts: openNotices.count,
    },
    notices: openNotices.notices,
    noticeCount: openNotices.count,
  };
}

export async function saveMiswagCategoryMapping(brownCollectionId, input = {}) {
  const collectionId = clean(brownCollectionId);
  if (!collectionId) {
    throw new MiswagError("Choose a BrownStore collection.", { status: 400, code: "missing_collection" });
  }
  const values = normalizeMiswagMappingValues(input);
  const exists = await Product.exists({
    $expr: {
      $eq: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, collectionId],
    },
  });
  if (!exists) {
    throw new MiswagError("That BrownStore collection was not found.", {
      status: 404,
      code: "collection_not_found",
    });
  }

  const saved = await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner: PARTNER, brownCollectionId: collectionId },
    { $set: { partner: PARTNER, brownCollectionId: collectionId, values } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    await resolveTaxonomyNotices(PARTNER);
  } catch (err) {
    console.error("Miswag mapping notice resolve failed:", err?.message || err);
  }

  const noticeCount = await countOpenCollectionNotices();
  return {
    id: collectionId,
    brownCollectionId: collectionId,
    mapped: isTaxonomyComplete(PARTNER, saved.values),
    values: saved.values || {},
    miswag: {
      categoryId: clean(saved.values?.categoryId),
      categoryName: clean(saved.values?.categoryName),
      categoryPath: clean(saved.values?.categoryPath),
      categoryLevel: clean(saved.values?.categoryLevel) || miswagCategoryLevel(saved.values?.categoryId),
    },
    noticeCount,
  };
}

export async function getMiswagMappingDashboardStats() {
  const listed = await listMiswagCategoryMappings({ page: 1, limit: 1 });
  return {
    totalCollections: listed.counts.total,
    mapped: listed.counts.mapped,
    missingMapping: listed.counts.missing,
    newCollectionAlerts: listed.counts.newCollectionAlerts,
  };
}

/** Escape helper exported for tests that search mappings. */
export { escapeRegex, listOpenCollectionNotices as listOpenMiswagCollectionNotices };
