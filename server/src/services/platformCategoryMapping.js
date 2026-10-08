import { Product } from "../models/Product.js";
import { PlatformCategory } from "../models/PlatformCategory.js";
import { PlatformCategoryMapping } from "../models/PlatformCategoryMapping.js";

const GENERIC = new Set([
  "accessories",
  "accessory",
  "other",
  "others",
  "general",
  "home",
  "misc",
  "miscellaneous",
  "اكسسوار",
  "اكسسوارات",
  "اخري",
  "اخرى",
  "عام",
  "عامه",
  "منزل",
  "المنزل",
  "ئیکسسوار",
  "ئیکسسوارات",
  "گشتی",
  "ماڵ",
]);

const STOP = new Set([
  "and",
  "the",
  "of",
  "for",
  "with",
  "a",
  "an",
  "or",
  "to",
  "in",
  "on",
  "و",
  "من",
  "في",
  "له",
]);

const STATUS_ORDER = { needs_review: 0, unmapped: 1, auto_mapped: 2, verified: 3 };

export class MappingError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function plainName(name) {
  if (typeof name === "string") return name.trim();
  if (!name || typeof name !== "object") return "";
  return String(name.en || name.ku || name.ar || "").trim();
}

function nameVariants(name) {
  if (typeof name === "string") {
    const value = name.trim();
    return value ? [value] : [];
  }
  if (!name || typeof name !== "object") return [];
  return [...new Set([name.en, name.ar, name.ku].map((value) => String(value || "").trim()).filter(Boolean))];
}

export function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP.has(token));
}

function clamp(value) {
  const number = Math.round(Number(value) || 0);
  return Math.max(0, Math.min(100, number));
}

export function statusForConfidence(confidence) {
  const score = Number(confidence) || 0;
  if (score >= 95) return "auto_mapped";
  if (score >= 75) return "needs_review";
  return "unmapped";
}

function splitPath(path) {
  return String(path || "")
    .split(/\s*(?:>|\/|\||›|»)\s*/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function prepareCategory(category) {
  const pathSegments = splitPath(category.path).map(normalizeText).filter(Boolean);
  const names = [...new Set([category.nameEn, category.nameAr, category.alias].map(normalizeText).filter(Boolean))];
  const leaf = pathSegments[pathSegments.length - 1] || names[0] || "";
  const haystack = new Set();
  for (const token of tokens([...names, ...pathSegments].join(" "))) {
    if (!GENERIC.has(token)) haystack.add(token);
  }
  return { source: category, names, pathSegments, leaf, haystack };
}

function scoreVariant(raw, parts, { allowParent = false } = {}) {
  const full = normalizeText(raw);
  if (!full || full.length < 2) return 0;
  const allTokens = tokens(full);
  if (!allTokens.length) return 0;
  const distinctiveTokens = allTokens.filter((token) => !GENERIC.has(token));
  const genericOnly = distinctiveTokens.length === 0;
  const exactLeaf = parts.names.includes(full) || (parts.leaf && parts.leaf === full);

  if (exactLeaf) {
    if (genericOnly && allTokens.length < 2) return 0;
    if (genericOnly) return 88;
    return 100;
  }

  if (genericOnly) return 0;

  if (allowParent && parts.pathSegments.includes(full)) return 92;

  for (const candidate of parts.names) {
    if (!candidate || candidate === full) continue;
    const shorter = Math.min(full.length, candidate.length);
    const longer = Math.max(full.length, candidate.length);
    const shortText = full.length <= candidate.length ? full : candidate;
    const longText = full.length > candidate.length ? full : candidate;
    if (longText.includes(shortText) && shorter >= 4 && shorter / longer >= 0.72) return 86;
  }

  const hits = distinctiveTokens.filter((token) => parts.haystack.has(token));
  if (!hits.length) return 0;
  if (hits.length === 1) return 68;
  const coverage = hits.length / distinctiveTokens.length;
  return Math.min(92, Math.round(62 + coverage * 30));
}

function levelScore(name, parts, options) {
  let best = 0;
  for (const variant of nameVariants(name)) {
    best = Math.max(best, scoreVariant(variant, parts, options));
  }
  return best;
}

export function combineConfidence(collectionScore, subScore, categoryScore) {
  const collection = clamp(collectionScore);
  const sub = clamp(subScore);
  const category = clamp(categoryScore);

  let confidence;
  if (collection >= 100) confidence = 90;
  else if (collection >= 86) confidence = 82;
  else if (collection >= 75) confidence = Math.round(collection * 0.9);
  else confidence = Math.round(collection * 0.62);

  if (sub >= 90) confidence += 6;
  else if (sub >= 70) confidence += 4;

  if (category >= 90) confidence += 4;
  else if (category >= 70) confidence += 3;

  if (collection >= 100 && sub >= 70 && category >= 70) confidence = Math.max(confidence, 98);
  else if (collection >= 100 && (sub >= 70 || category >= 70)) confidence = Math.max(confidence, 95);

  if (collection < 75) confidence = Math.min(confidence, 74);
  return clamp(confidence);
}

function externalLabel(category) {
  return String(category?.nameEn || category?.nameAr || category?.alias || "").trim();
}

function emptySuggestion() {
  return {
    externalCategoryId: "",
    externalCategoryName: "",
    externalPath: "",
    confidence: 0,
    status: "unmapped",
    matchMethod: "auto",
    verifiedAt: null,
  };
}

export function matchBrownCollection(collection, categories) {
  const prepared = (categories || [])
    .filter((category) => category && category.active !== false && category.externalId)
    .map(prepareCategory);

  let best = null;
  for (const parts of prepared) {
    const collectionScore = levelScore(collection.collectionName, parts, { allowParent: false });
    const subScore = levelScore(collection.subCategoryName, parts, { allowParent: true });
    const categoryScore = levelScore(collection.categoryName, parts, { allowParent: true });
    const confidence = combineConfidence(collectionScore, subScore, categoryScore);
    const next = { parts, confidence, collectionScore };
    if (!best || confidence > best.confidence) {
      best = next;
    } else if (confidence === best.confidence && confidence > 0) {
      if (collectionScore > best.collectionScore) best = next;
      else if (
        collectionScore === best.collectionScore &&
        String(parts.source.path || "").length > String(best.parts.source.path || "").length
      ) {
        best = next;
      }
    }
  }

  if (!best || best.confidence <= 0) return emptySuggestion();
  const category = best.parts.source;
  return {
    externalCategoryId: String(category.externalId),
    externalCategoryName: externalLabel(category),
    externalPath: String(category.path || ""),
    confidence: best.confidence,
    status: statusForConfidence(best.confidence),
    matchMethod: "auto",
    verifiedAt: null,
  };
}

function cleanId(value) {
  const id = String(value ?? "").trim();
  if (!id || id === "null" || id === "undefined") return "";
  return id;
}

export async function brownCollections() {
  const rows = await Product.aggregate([
    { $match: { "collectionName._id": { $exists: true, $ne: null } } },
    {
      $group: {
        _id: { $toString: "$collectionName._id" },
        collectionName: { $first: "$collectionName.name" },
        subCategoryId: {
          $first: {
            $toString: {
              $ifNull: ["$collectionName.subCategory", "$subCategory._id"],
            },
          },
        },
        subCategoryName: { $first: "$subCategory.name" },
        categoryId: { $first: { $toString: { $ifNull: ["$category._id", ""] } } },
        categoryName: { $first: "$category.name" },
        products: { $sum: 1 },
      },
    },
    { $sort: { "collectionName.en": 1, "collectionName.ku": 1 } },
  ]);

  return rows
    .map((row) => ({
      id: cleanId(row._id),
      collectionName: row.collectionName,
      subCategoryId: cleanId(row.subCategoryId),
      subCategoryName: row.subCategoryName,
      categoryId: cleanId(row.categoryId),
      categoryName: row.categoryName,
      products: Number(row.products) || 0,
    }))
    .filter((row) => row.id);
}

function brownFields(collection) {
  return {
    brownCategoryId: collection.categoryId || "",
    brownCategoryName: plainName(collection.categoryName),
    brownSubCategoryId: collection.subCategoryId || "",
    brownSubCategoryName: plainName(collection.subCategoryName),
    brownCollectionId: collection.id,
    brownCollectionName: plainName(collection.collectionName),
  };
}

function hierarchyLabel(fields) {
  return [fields.brownCategoryName, fields.brownSubCategoryName, fields.brownCollectionName]
    .filter(Boolean)
    .join(" › ");
}

function toRow(collection, doc) {
  const brown = brownFields(collection);
  return {
    id: doc?._id ? String(doc._id) : "",
    partner: doc?.partner || "",
    ...brown,
    hierarchy: hierarchyLabel(brown),
    externalCategoryId: doc?.externalCategoryId || "",
    externalCategoryName: doc?.externalCategoryName || "",
    externalPath: doc?.externalPath || "",
    confidence: Number(doc?.confidence) || 0,
    status: doc?.status || "unmapped",
    matchMethod: doc?.matchMethod || "",
    verifiedAt: doc?.verifiedAt || null,
    updatedAt: doc?.updatedAt || null,
  };
}

function compareRows(a, b) {
  const rank = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
  if (rank) return rank;
  return String(a.hierarchy || "").localeCompare(String(b.hierarchy || ""), "en");
}

async function lastCategorySync(partner) {
  const doc = await PlatformCategory.findOne({ partner, lastSyncedAt: { $ne: null } })
    .sort({ lastSyncedAt: -1 })
    .select("lastSyncedAt")
    .lean();
  return doc?.lastSyncedAt || null;
}

export function summarizeMappings(rows, lastSyncedAt) {
  const counts = { auto_mapped: 0, verified: 0, needs_review: 0, unmapped: 0 };
  for (const row of rows) {
    const status = Object.prototype.hasOwnProperty.call(counts, row.status) ? row.status : "unmapped";
    counts[status] += 1;
  }
  return {
    totalCollections: rows.length,
    mapped: counts.auto_mapped + counts.verified,
    autoMapped: counts.auto_mapped,
    verified: counts.verified,
    needsReview: counts.needs_review,
    unmapped: counts.unmapped,
    lastSyncedAt: lastSyncedAt || null,
  };
}

async function loadRows(partner) {
  const [collections, docs, lastSyncedAt] = await Promise.all([
    brownCollections(),
    PlatformCategoryMapping.find({ partner }).lean(),
    lastCategorySync(partner),
  ]);
  const byId = new Map(docs.map((doc) => [doc.brownCollectionId, doc]));
  const rows = collections.map((collection) => toRow(collection, byId.get(collection.id)));
  rows.sort(compareRows);
  return { rows, lastSyncedAt, collections, byId };
}

export async function categoryMappingState(partner, { status = "" } = {}) {
  const { rows, lastSyncedAt } = await loadRows(partner);
  const summary = summarizeMappings(rows, lastSyncedAt);
  const wanted = String(status || "").trim();
  const mappings = wanted ? rows.filter((row) => row.status === wanted) : rows;
  return { summary, mappings };
}

async function preparedCategories(partner) {
  const docs = await PlatformCategory.find({ partner, active: { $ne: false } }).lean();
  return docs;
}

function suggestCollection(collection, categories) {
  return matchBrownCollection(
    {
      collectionName: collection.collectionName,
      subCategoryName: collection.subCategoryName,
      categoryName: collection.categoryName,
    },
    categories
  );
}

async function requireCollection(collectionId) {
  const id = cleanId(collectionId);
  if (!id) throw new MappingError("Collection not found", 404);
  const collections = await brownCollections();
  const collection = collections.find((item) => item.id === id);
  if (!collection) throw new MappingError("Collection not found", 404);
  return collection;
}

async function bulkMapping(ops) {
  let created = 0;
  let updated = 0;
  for (let i = 0; i < ops.length; i += 200) {
    const slice = ops.slice(i, i + 200);
    try {
      const write = await PlatformCategoryMapping.bulkWrite(slice, { ordered: false });
      created += write.insertedCount || write.upsertedCount || 0;
      updated += write.modifiedCount || 0;
    } catch (err) {
      const partial = err.result || {};
      created += partial.insertedCount || partial.upsertedCount || 0;
      updated += partial.modifiedCount || 0;
      const errors = err.writeErrors || [];
      if (!errors.length || errors.some((item) => item.code !== 11000)) throw err;
    }
  }
  return { created, updated };
}

export async function saveExternalCategories(partner, items) {
  const syncedAt = new Date();
  const ops = items.map((item) => ({
    updateOne: {
      filter: { partner, externalId: item.externalId },
      update: {
        $set: {
          partner,
          externalId: item.externalId,
          alias: item.alias || "",
          nameEn: item.nameEn || "",
          nameAr: item.nameAr || "",
          description: item.description || "",
          path: item.path || "",
          active: item.active !== false,
          lastSyncedAt: syncedAt,
        },
      },
      upsert: true,
    },
  }));

  for (let i = 0; i < ops.length; i += 200) {
    await PlatformCategory.bulkWrite(ops.slice(i, i + 200), { ordered: false });
  }

  await PlatformCategory.updateMany(
    { partner, externalId: { $nin: items.map((item) => item.externalId) } },
    { $set: { active: false, lastSyncedAt: syncedAt } }
  );

  return { count: items.length, lastSyncedAt: syncedAt };
}

export async function listExternalCategories(partner, query = "") {
  const filter = { partner, active: { $ne: false } };
  const q = String(query || "").trim();
  if (q) {
    const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ nameEn: pattern }, { nameAr: pattern }, { alias: pattern }, { path: pattern }];
  }
  const docs = await PlatformCategory.find(filter)
    .sort({ path: 1, nameEn: 1 })
    .limit(q ? 40 : 10000)
    .lean();
  return docs.map((doc) => ({
    externalId: doc.externalId,
    alias: doc.alias || "",
    nameEn: doc.nameEn || "",
    nameAr: doc.nameAr || "",
    description: doc.description || "",
    path: doc.path || "",
    active: doc.active !== false,
  }));
}

export async function mapNewCollections(partner) {
  const collections = await brownCollections();
  const existing = await PlatformCategoryMapping.find({ partner }).select("brownCollectionId").lean();
  const known = new Set(existing.map((doc) => doc.brownCollectionId));
  const fresh = collections.filter((collection) => !known.has(collection.id));
  if (!fresh.length) {
    return { created: 0, autoMapped: 0, needsReview: 0, unmapped: 0 };
  }

  const categories = await preparedCategories(partner);
  const counts = { created: 0, autoMapped: 0, needsReview: 0, unmapped: 0 };
  const ops = fresh.map((collection) => {
    const suggestion = suggestCollection(collection, categories);
    if (suggestion.status === "auto_mapped") counts.autoMapped += 1;
    else if (suggestion.status === "needs_review") counts.needsReview += 1;
    else counts.unmapped += 1;
    return {
      updateOne: {
        filter: { partner, brownCollectionId: collection.id },
        update: {
          $setOnInsert: {
            partner,
            ...brownFields(collection),
            ...suggestion,
          },
        },
        upsert: true,
      },
    };
  });

  const write = await bulkMapping(ops);
  counts.created = write.created;
  return counts;
}

export async function runAutoMapping(partner) {
  const collections = await brownCollections();
  const existing = await PlatformCategoryMapping.find({ partner }).select("brownCollectionId status").lean();
  const byId = new Map(existing.map((doc) => [doc.brownCollectionId, doc]));
  const categories = await preparedCategories(partner);
  const counts = {
    created: 0,
    updated: 0,
    skipped: 0,
    autoMapped: 0,
    needsReview: 0,
    unmapped: 0,
  };
  const ops = [];

  for (const collection of collections) {
    const current = byId.get(collection.id);
    if (current && current.status !== "unmapped") {
      counts.skipped += 1;
      continue;
    }
    const suggestion = suggestCollection(collection, categories);
    if (suggestion.status === "auto_mapped") counts.autoMapped += 1;
    else if (suggestion.status === "needs_review") counts.needsReview += 1;
    else counts.unmapped += 1;

    if (!current) {
      ops.push({
        insertOne: {
          document: {
            partner,
            ...brownFields(collection),
            ...suggestion,
          },
        },
      });
    } else {
      ops.push({
        updateOne: {
          filter: { partner, brownCollectionId: collection.id, status: "unmapped" },
          update: { $set: { partner, ...brownFields(collection), ...suggestion } },
        },
      });
    }
  }

  const write = await bulkMapping(ops);
  counts.created = write.created;
  counts.updated = write.updated;
  return counts;
}

export async function rerunCollectionMapping(partner, collectionId) {
  const collection = await requireCollection(collectionId);
  const existing = await PlatformCategoryMapping.findOne({
    partner,
    brownCollectionId: collection.id,
  });
  if (existing?.status === "verified") {
    throw new MappingError("Verified mappings are not overwritten automatically", 409);
  }

  const categories = await preparedCategories(partner);
  const suggestion = suggestCollection(collection, categories);
  const fields = { partner, ...brownFields(collection), ...suggestion };

  if (!existing) {
    const created = await PlatformCategoryMapping.create(fields);
    return toRow(collection, created.toObject());
  }

  const updated = await PlatformCategoryMapping.findOneAndUpdate(
    { partner, brownCollectionId: collection.id, status: { $ne: "verified" } },
    { $set: fields },
    { new: true }
  );
  if (!updated) {
    throw new MappingError("Verified mappings are not overwritten automatically", 409);
  }
  return toRow(collection, updated.toObject());
}

export async function selectCollectionMapping(partner, collectionId, externalCategoryId) {
  const collection = await requireCollection(collectionId);
  const externalId = cleanId(externalCategoryId);
  if (!externalId) throw new MappingError("Choose a Miswag category", 400);

  const category = await PlatformCategory.findOne({
    partner,
    externalId,
    active: { $ne: false },
  }).lean();
  if (!category) {
    throw new MappingError("Miswag category not found. Sync categories first.", 404);
  }

  const doc = await PlatformCategoryMapping.findOneAndUpdate(
    { partner, brownCollectionId: collection.id },
    {
      $set: {
        partner,
        ...brownFields(collection),
        externalCategoryId: category.externalId,
        externalCategoryName: externalLabel(category),
        externalPath: category.path || "",
        confidence: 100,
        status: "needs_review",
        matchMethod: "manual",
        verifiedAt: null,
      },
    },
    { upsert: true, new: true, runValidators: true }
  );
  return toRow(collection, doc.toObject());
}

export async function verifyCollectionMapping(partner, collectionId) {
  const collection = await requireCollection(collectionId);
  const existing = await PlatformCategoryMapping.findOne({
    partner,
    brownCollectionId: collection.id,
  });
  if (!existing?.externalCategoryId) {
    throw new MappingError("Choose a Miswag category before verifying", 400);
  }

  existing.set({
    ...brownFields(collection),
    status: "verified",
    verifiedAt: existing.status === "verified" && existing.verifiedAt ? existing.verifiedAt : new Date(),
  });
  await existing.save();
  return toRow(collection, existing.toObject());
}
