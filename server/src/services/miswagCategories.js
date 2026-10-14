import { PlatformCategory } from "../models/PlatformCategory.js";
import { MISWAG_PARTNER, fetchCategoryPage, isAllowedMiswagUrl } from "./miswag.js";

const MAX_PAGES = 250;
const MAX_CATEGORIES = 50000;

export function normalizeImportedCategories(body) {
  const list = Array.isArray(body)
    ? body
    : Array.isArray(body?.categories)
      ? body.categories
      : Array.isArray(body?.data?.content)
        ? body.data.content
        : Array.isArray(body?.content)
          ? body.content
          : Array.isArray(body?.data)
            ? body.data
            : null;
  if (!list) return null;

  const byId = new Map();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const externalId = String(item.id || item.externalId || "").trim();
    if (!externalId) continue;
    byId.set(externalId, {
      externalId,
      alias: String(item.alias || ""),
      nameEn: String(item.name_en || item.nameEn || ""),
      nameAr: String(item.name_ar || item.nameAr || ""),
      description: String(item.description || ""),
      path: String(item.path || ""),
      active: item.active !== false,
    });
  }
  return [...byId.values()];
}

export async function upsertPlatformCategories(categories, syncedAt = new Date()) {
  const unique = [];
  const seen = new Set();
  for (const category of categories || []) {
    const externalId = String(category.externalId || category.id || "").trim();
    if (!externalId || seen.has(externalId)) continue;
    seen.add(externalId);
    unique.push({
      externalId,
      alias: String(category.alias || ""),
      nameEn: String(category.nameEn || category.name_en || ""),
      nameAr: String(category.nameAr || category.name_ar || ""),
      description: String(category.description || ""),
      path: String(category.path || ""),
      active: category.active !== false,
    });
  }

  let inserted = 0;
  let updated = 0;
  const chunkSize = 500;
  for (let index = 0; index < unique.length; index += chunkSize) {
    const chunk = unique.slice(index, index + chunkSize);
    const result = await PlatformCategory.bulkWrite(
      chunk.map((category) => ({
        updateOne: {
          filter: { partner: MISWAG_PARTNER, externalId: category.externalId },
          update: {
            $set: {
              alias: category.alias,
              nameEn: category.nameEn,
              nameAr: category.nameAr,
              description: category.description,
              path: category.path,
              active: category.active,
              lastSyncedAt: syncedAt,
            },
            $setOnInsert: {
              partner: MISWAG_PARTNER,
              externalId: category.externalId,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false }
    );
    inserted += result.upsertedCount || 0;
    updated += result.modifiedCount || 0;
  }

  const total = await PlatformCategory.countDocuments({ partner: MISWAG_PARTNER });
  return {
    fetched: unique.length,
    inserted,
    updated,
    total,
    lastSyncedAt: syncedAt,
  };
}

export async function fetchAllCategories() {
  let url = "/v1/categories/flat?page%5Bsize%5D=30";
  const seenUrls = new Set();
  const categories = [];
  let pages = 0;

  while (url) {
    if (pages >= MAX_PAGES || categories.length >= MAX_CATEGORIES) {
      throw new Error("Miswag category pagination exceeded the safety limit.");
    }
    if (seenUrls.has(url)) {
      throw new Error("Miswag category pagination repeated a page URL.");
    }
    seenUrls.add(url);
    pages += 1;

    const response = await fetchCategoryPage(url);
    const content = Array.isArray(response.data?.content) ? response.data.content : [];
    categories.push(...content);

    const next = response.data?.paging?.next_url || null;
    if (!next) break;
    if (!isAllowedMiswagUrl(next)) {
      throw new Error("Miswag category next_url is outside the configured API host.");
    }
    url = String(next);
  }

  return categories;
}

export async function syncMiswagCategories() {
  const remote = await fetchAllCategories();
  return upsertPlatformCategories(remote);
}

export async function importMiswagCategories(body) {
  const categories = normalizeImportedCategories(body);
  if (!categories) {
    const err = new Error("JSON must be a list of Miswag categories or an object with data.content.");
    err.status = 400;
    throw err;
  }
  if (!categories.length) {
    const err = new Error("The category file did not contain any category ids.");
    err.status = 400;
    throw err;
  }
  return upsertPlatformCategories(categories);
}

export async function searchCachedCategories(q, limit = 20) {
  const term = String(q || "").trim();
  const filter = { partner: MISWAG_PARTNER };
  if (term) {
    const rx = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { nameEn: rx },
      { nameAr: rx },
      { alias: rx },
      { path: rx },
      { externalId: rx },
    ];
  }
  const size = Math.min(Math.max(Number(limit) || 20, 1), 50);
  return PlatformCategory.find(filter).sort({ nameEn: 1, externalId: 1 }).limit(size).lean();
}

export function toPublicCategory(doc) {
  return {
    externalId: doc.externalId,
    alias: doc.alias || "",
    nameEn: doc.nameEn || "",
    nameAr: doc.nameAr || "",
    description: doc.description || "",
    path: doc.path || "",
    active: doc.active !== false,
    lastSyncedAt: doc.lastSyncedAt || null,
  };
}
