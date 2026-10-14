import { PlatformCategory } from "../models/PlatformCategory.js";
import { PlatformCategoryMapping } from "../models/PlatformCategoryMapping.js";
import { discoverBrownCollections } from "../utils/brownTaxonomy.js";
import { MISWAG_PARTNER } from "./miswag.js";

const GENERIC = new Set([
  "accessories",
  "accessory",
  "other",
  "others",
  "general",
  "home",
  "products",
  "product",
  "items",
  "item",
  "misc",
  "miscellaneous",
]);

const AUTO_CONFIDENCE = 95;
const REVIEW_CONFIDENCE = 75;
const AMBIGUOUS_GAP = 4;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\u064B-\u0652]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/&/g, " and ")
    .replace(/[_./,+|:;]+/g, " ")
    .replace(/-/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fold(word) {
  if (!/^[a-z0-9]+$/.test(word)) return word;
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function tokensOf(value) {
  return normalizeText(value).split(" ").filter(Boolean).map(fold);
}

function meaningful(tokens) {
  return tokens.filter((token) => token.length >= 3 && !GENERIC.has(token));
}

function labelsOf(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  return [value.en, value.ar, value.ku].filter(Boolean);
}

function samePhrase(left, right) {
  const a = meaningful(tokensOf(left));
  const b = meaningful(tokensOf(right));
  if (!a.length || a.length !== b.length) return false;
  return a.join(" ") === b.join(" ");
}

function overlap(needles, haystack) {
  const left = [...new Set(meaningful(needles))];
  const right = new Set(meaningful(haystack));
  if (!left.length || !right.size) return 0;
  let hits = 0;
  for (const token of left) if (right.has(token)) hits += 1;
  return hits / left.length;
}

function prepareCategory(category) {
  const pathParts = String(category.path || "")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean);
  const leafLabels = [category.nameEn, category.nameAr, category.alias, pathParts.at(-1)].filter(Boolean);
  const leafTokens = leafLabels.flatMap((label) => meaningful(tokensOf(label)));
  const pathTokens = pathParts.flatMap((part) => tokensOf(part));
  const pathContextTokens = pathParts.slice(0, -1).flatMap((part) => tokensOf(part));
  return {
    externalId: String(category.externalId || category.id || ""),
    nameEn: category.nameEn || category.name_en || "",
    nameAr: category.nameAr || category.name_ar || "",
    alias: category.alias || "",
    path: category.path || "",
    active: category.active !== false,
    leafLabels,
    leafTokens: [...new Set(leafTokens)],
    pathTokens,
    pathContextTokens,
  };
}

function scorePair(collection, category) {
  const collectionLabels = labelsOf(collection.brownCollectionName);
  const collectionTokens = collectionLabels.flatMap((label) => tokensOf(label));
  const subTokens = labelsOf(collection.brownSubCategoryName).flatMap((label) => tokensOf(label));
  const categoryTokens = labelsOf(collection.brownCategoryName).flatMap((label) => tokensOf(label));
  const leafExact = collectionLabels.some((label) =>
    category.leafLabels.some((candidate) => samePhrase(label, candidate))
  );
  const leafOverlap = overlap(collectionTokens, category.leafTokens);
  const subOverlap = overlap(subTokens, category.pathTokens);
  const categoryOverlap = overlap(categoryTokens, category.pathTokens);
  const brownHasContext = meaningful(subTokens).length + meaningful(categoryTokens).length > 0;
  const miswagHasContext = meaningful(category.pathContextTokens).length > 0;

  let score = 0;
  let matchMethod = "none";
  if (leafExact) {
    score = 90;
    matchMethod = "exact_collection";
    if (subOverlap >= 0.5) score += 7;
    else if (categoryOverlap >= 0.5) score += 5;
    else if (!brownHasContext) score += 6;
    else if (subOverlap === 0 && categoryOverlap === 0 && miswagHasContext) score = 78;
    else score += 4;
    score = Math.min(score, 99);
  } else if (leafOverlap > 0) {
    score = Math.round(leafOverlap * 80);
    matchMethod = "partial_collection";
    if (subOverlap >= 0.5) score += 6;
    if (categoryOverlap >= 0.5) score += 3;
    if (leafOverlap < 0.5) score = Math.min(score, 70);
    score = Math.min(score, 94);
  }

  if (!leafExact && meaningful(collectionTokens).length === 0) score = 0;
  return { score, matchMethod, category };
}

export function prepareMiswagCategories(categories) {
  const prepared = (categories || [])
    .filter((category) => category && category.active !== false)
    .map(prepareCategory)
    .filter((category) => category.externalId);
  const byToken = new Map();
  prepared.forEach((category, index) => {
    for (const token of category.leafTokens) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(index);
    }
  });
  return { prepared, byToken };
}

export function chooseMiswagCategory(collection, prepared, byToken = new Map()) {

  const wanted = new Set(
    labelsOf(collection.brownCollectionName).flatMap((label) => meaningful(tokensOf(label)))
  );
  const candidateIndexes = new Set();
  for (const token of wanted) {
    for (const index of byToken.get(token) || []) candidateIndexes.add(index);
  }

  const ranked = [...candidateIndexes]
    .map((index) => scorePair(collection, prepared[index]))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.category.externalId.localeCompare(b.category.externalId));

  const best = ranked[0];
  const second = ranked[1];
  if (!best) {
    return {
      externalCategoryId: "",
      externalCategoryName: "",
      externalPath: "",
      confidence: 0,
      status: "unmapped",
      matchMethod: "none",
    };
  }

  let status = best.score >= AUTO_CONFIDENCE ? "auto_mapped" : best.score >= REVIEW_CONFIDENCE ? "needs_review" : "unmapped";
  let matchMethod = best.matchMethod;
  if (second && best.score - second.score <= AMBIGUOUS_GAP && best.score >= REVIEW_CONFIDENCE && status === "auto_mapped") {
    status = "needs_review";
    matchMethod = "ambiguous";
  }
  if (collection.ambiguousHierarchy && status === "auto_mapped") {
    status = "needs_review";
    matchMethod = "ambiguous_hierarchy";
  }
  if (status === "unmapped") {
    return {
      externalCategoryId: "",
      externalCategoryName: "",
      externalPath: "",
      confidence: best.score,
      status,
      matchMethod,
    };
  }

  const name = best.category.nameEn || best.category.nameAr || best.category.alias;
  return {
    externalCategoryId: best.category.externalId,
    externalCategoryName: name,
    externalPath: best.category.path,
    confidence: best.score,
    status,
    matchMethod,
  };
}

function mappingFields(collection, suggestion) {
  return {
    brownCategoryId: collection.brownCategoryId || "",
    brownCategoryName: collection.brownCategoryName,
    brownSubCategoryId: collection.brownSubCategoryId || "",
    brownSubCategoryName: collection.brownSubCategoryName,
    brownCollectionName: collection.brownCollectionName,
    externalCategoryId: suggestion.externalCategoryId || "",
    externalCategoryName: suggestion.externalCategoryName || "",
    externalPath: suggestion.externalPath || "",
    confidence: suggestion.confidence || 0,
    status: suggestion.status,
    matchMethod: suggestion.matchMethod || "",
    verifiedAt: null,
    verifiedBy: "",
  };
}

async function loadActiveCategories() {
  return PlatformCategory.find({ partner: MISWAG_PARTNER, active: { $ne: false } })
    .select("externalId alias nameEn nameAr path active")
    .lean();
}

export async function mapCollectionRows(collections, { preserveManual = true } = {}) {
  const { prepared, byToken } = prepareMiswagCategories(await loadActiveCategories());
  const ids = collections.map((collection) => collection.brownCollectionId);
  const existing = await PlatformCategoryMapping.find({
    partner: MISWAG_PARTNER,
    brownCollectionId: { $in: ids },
  })
    .select("brownCollectionId status matchMethod")
    .lean();
  const known = new Map(existing.map((doc) => [doc.brownCollectionId, doc]));
  const ops = [];
  const summary = {
    examined: collections.length,
    created: 0,
    updated: 0,
    skippedVerified: 0,
    skippedManual: 0,
    autoMapped: 0,
    needsReview: 0,
    unmapped: 0,
  };

  for (const collection of collections) {
    const current = known.get(collection.brownCollectionId);
    if (current?.status === "verified") {
      summary.skippedVerified += 1;
      continue;
    }
    if (preserveManual && current?.matchMethod === "manual") {
      summary.skippedManual += 1;
      continue;
    }
    const suggestion = chooseMiswagCategory(collection, prepared, byToken);
    summary[suggestion.status === "auto_mapped" ? "autoMapped" : suggestion.status === "needs_review" ? "needsReview" : "unmapped"] += 1;
    const fields = mappingFields(collection, suggestion);
    if (current) {
      summary.updated += 1;
      ops.push({
        updateOne: {
          filter: {
            partner: MISWAG_PARTNER,
            brownCollectionId: collection.brownCollectionId,
            status: { $ne: "verified" },
          },
          update: { $set: fields },
        },
      });
    } else {
      summary.created += 1;
      ops.push({
        updateOne: {
          filter: { partner: MISWAG_PARTNER, brownCollectionId: collection.brownCollectionId },
          update: {
            $set: fields,
            $setOnInsert: {
              partner: MISWAG_PARTNER,
              brownCollectionId: collection.brownCollectionId,
            },
          },
          upsert: true,
        },
      });
    }
  }

  if (ops.length) await PlatformCategoryMapping.bulkWrite(ops, { ordered: false });
  return summary;
}

export async function mapAllCollections() {
  const { collections } = await discoverBrownCollections();
  return mapCollectionRows(collections);
}

export async function mapOneCollection(collectionId) {
  const { collections } = await discoverBrownCollections();
  const collection = collections.find((item) => item.brownCollectionId === String(collectionId));
  if (!collection) {
    const err = new Error("BrownStore collection was not found.");
    err.status = 404;
    throw err;
  }
  const existing = await PlatformCategoryMapping.findOne({
    partner: MISWAG_PARTNER,
    brownCollectionId: collection.brownCollectionId,
  }).lean();
  if (existing?.status === "verified") {
    return { skippedVerified: 1, status: "verified", collectionId: collection.brownCollectionId };
  }
  const [summary] = [await mapCollectionRows([collection], { preserveManual: false })];
  return { ...summary, collectionId: collection.brownCollectionId };
}

export async function mapNewMiswagCollections() {
  const { collections } = await discoverBrownCollections();
  const existingIds = await PlatformCategoryMapping.distinct("brownCollectionId", {
    partner: MISWAG_PARTNER,
  });
  const known = new Set(existingIds.map((id) => String(id)));
  const fresh = collections.filter((collection) => !known.has(collection.brownCollectionId));
  if (!fresh.length) return { created: 0, examined: 0, skippedVerified: 0 };
  return mapCollectionRows(fresh);
}

function haystack(collection, mapping) {
  return [
    collection?.brownCollectionName?.en,
    collection?.brownCollectionName?.ar,
    collection?.brownCollectionName?.ku,
    collection?.brownSubCategoryName?.en,
    collection?.brownSubCategoryName?.ar,
    collection?.brownCategoryName?.en,
    collection?.brownCategoryName?.ar,
    mapping?.externalCategoryName,
    mapping?.externalPath,
    mapping?.externalCategoryId,
  ]
    .join(" ")
    .toLowerCase();
}

export async function listMappings({ status = "", q = "", page = 1, limit = 25 } = {}) {
  const { collections, diagnostics } = await discoverBrownCollections();
  const stored = await PlatformCategoryMapping.find({ partner: MISWAG_PARTNER }).lean();
  const byId = new Map(stored.map((doc) => [doc.brownCollectionId, doc]));
  const query = String(q || "").trim().toLowerCase();
  const wanted = String(status || "").trim();

  const rows = collections
    .map((collection) => {
      const mapping = byId.get(collection.brownCollectionId);
      const rowStatus = mapping?.status || "unmapped";
      return {
        ...collection,
        externalCategoryId: mapping?.externalCategoryId || "",
        externalCategoryName: mapping?.externalCategoryName || "",
        externalPath: mapping?.externalPath || "",
        confidence: Number(mapping?.confidence) || 0,
        status: rowStatus,
        matchMethod: mapping?.matchMethod || "",
        verifiedAt: mapping?.verifiedAt || null,
        verifiedBy: mapping?.verifiedBy || "",
        updatedAt: mapping?.updatedAt || null,
      };
    })
    .filter((row) => {
      if (wanted === "mapped") return row.status === "auto_mapped" || row.status === "verified";
      if (wanted && row.status !== wanted) return false;
      if (!query) return true;
      return haystack(row, row).includes(query);
    });

  const size = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const start = (current - 1) * size;
  return {
    mappings: rows.slice(start, start + size),
    pagination: {
      page: current,
      limit: size,
      total: rows.length,
      pages: Math.max(1, Math.ceil(rows.length / size)),
    },
    diagnostics,
  };
}

export async function mappingSummary() {
  const { collections, diagnostics } = await discoverBrownCollections();
  const stored = await PlatformCategoryMapping.find({ partner: MISWAG_PARTNER })
    .select("brownCollectionId status")
    .lean();
  const byId = new Map(stored.map((doc) => [doc.brownCollectionId, doc.status]));
  const counts = { auto_mapped: 0, verified: 0, needs_review: 0, unmapped: 0 };
  for (const collection of collections) counts[byId.get(collection.brownCollectionId) || "unmapped"] += 1;
  const latest = await PlatformCategory.findOne({ partner: MISWAG_PARTNER })
    .sort({ lastSyncedAt: -1 })
    .select("lastSyncedAt")
    .lean();
  const miswagCategories = await PlatformCategory.countDocuments({ partner: MISWAG_PARTNER });
  return {
    collections: collections.length,
    mapped: counts.auto_mapped + counts.verified,
    autoMapped: counts.auto_mapped,
    verified: counts.verified,
    needsReview: counts.needs_review,
    unmapped: counts.unmapped,
    miswagCategories,
    lastCategorySync: latest?.lastSyncedAt || null,
    diagnostics,
  };
}

export async function assignMapping(collectionId, externalCategoryId) {
  const { collections } = await discoverBrownCollections();
  const collection = collections.find((item) => item.brownCollectionId === String(collectionId));
  if (!collection) {
    const err = new Error("BrownStore collection was not found.");
    err.status = 404;
    throw err;
  }

  const externalId = String(externalCategoryId || "").trim();
  if (!externalId) {
    const doc = await PlatformCategoryMapping.findOneAndUpdate(
      { partner: MISWAG_PARTNER, brownCollectionId: collection.brownCollectionId },
      {
        $set: {
          ...mappingFields(collection, {
            externalCategoryId: "",
            externalCategoryName: "",
            externalPath: "",
            confidence: 0,
            status: "unmapped",
            matchMethod: "manual",
          }),
        },
        $setOnInsert: { partner: MISWAG_PARTNER, brownCollectionId: collection.brownCollectionId },
      },
      { upsert: true, new: true }
    ).lean();
    return doc;
  }

  const category = await PlatformCategory.findOne({ partner: MISWAG_PARTNER, externalId }).lean();
  if (!category) {
    const err = new Error("That Miswag category is not in the local cache. Sync or import categories first.");
    err.status = 404;
    throw err;
  }

  const doc = await PlatformCategoryMapping.findOneAndUpdate(
    { partner: MISWAG_PARTNER, brownCollectionId: collection.brownCollectionId },
    {
      $set: {
        brownCategoryId: collection.brownCategoryId,
        brownCategoryName: collection.brownCategoryName,
        brownSubCategoryId: collection.brownSubCategoryId,
        brownSubCategoryName: collection.brownSubCategoryName,
        brownCollectionName: collection.brownCollectionName,
        externalCategoryId: category.externalId,
        externalCategoryName: category.nameEn || category.nameAr || category.alias,
        externalPath: category.path || "",
        confidence: 100,
        status: "needs_review",
        matchMethod: "manual",
        verifiedAt: null,
        verifiedBy: "",
      },
      $setOnInsert: { partner: MISWAG_PARTNER, brownCollectionId: collection.brownCollectionId },
    },
    { upsert: true, new: true }
  ).lean();
  return doc;
}

export async function verifyMapping(collectionId, userLabel = "") {
  const doc = await PlatformCategoryMapping.findOne({
    partner: MISWAG_PARTNER,
    brownCollectionId: String(collectionId),
  });
  if (!doc) {
    const err = new Error("Save a Miswag category before verifying this collection.");
    err.status = 404;
    throw err;
  }
  if (!doc.externalCategoryId) {
    const err = new Error("Choose a Miswag category before verifying this collection.");
    err.status = 400;
    throw err;
  }
  doc.status = "verified";
  doc.verifiedAt = new Date();
  doc.verifiedBy = String(userLabel || "");
  if (!doc.matchMethod) doc.matchMethod = "manual";
  await doc.save();
  return doc.toObject();
}
