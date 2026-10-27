import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { discoverBrownCollections } from "../utils/brownTaxonomy.js";
import {
  ELRYAN_CATALOG_SYNC,
  ELRYAN_MAPPING_CONFIDENCE,
  ELRYAN_MAPPING_PREVIEW,
} from "../utils/elryanConstants.js";
import {
  elryanMappingIsComplete,
  elryanValuesForEnvironment,
  normalizeElryanMappingEnvironment,
} from "../utils/elryanTaxonomyMapping.js";
import {
  prepareElryanCatalogForMatching,
  suggestElryanCategoriesForCollection,
} from "../utils/elryanMappingSuggest.js";
import { ElryanClientError } from "./elryanClient.js";
import { elryanAttributeSetForCategory, elryanCategoryAttributes } from "./elryanCatalog.js";
import { getElryanConnectionPublic } from "./elryanConnection.js";

function localizedPath(collection) {
  const cat = collection.brownCategoryName?.en || collection.brownCategoryName?.ar || "";
  const sub = collection.brownSubCategoryName?.en || collection.brownSubCategoryName?.ar || "";
  const col = collection.brownCollectionName?.en || collection.brownCollectionName?.ar || "";
  return [cat, sub, col].filter(Boolean).join(" → ");
}

function mappingStatus(values, environment) {
  const env = normalizeElryanMappingEnvironment(environment);
  const resolved = elryanValuesForEnvironment(values, env);
  const configured = elryanMappingIsComplete(values, env);
  return {
    configured,
    status: configured ? "mapped" : "unmapped",
    values: resolved,
    elryanEnvironment: env,
  };
}

function collectionIdVariants(ids) {
  const strings = [];
  const objectIds = [];
  for (const raw of ids) {
    const id = String(raw || "").trim();
    if (!id) continue;
    strings.push(id);
    if (mongoose.Types.ObjectId.isValid(id)) {
      objectIds.push(new mongoose.Types.ObjectId(id));
    }
  }
  return { strings: [...new Set(strings)], objectIds };
}

/**
 * One indexed query for many collections (uses collectionName._id index).
 * Avoids N+1 `$expr`/`$toString` scans that bypass indexes (~179ms each on ~40k products).
 */
export async function sampleProductsForCollections(collectionIds, perCollection = 6) {
  const { strings, objectIds } = collectionIdVariants(collectionIds);
  const out = new Map();
  if (!strings.length) return out;

  const or = [{ "collectionName._id": { $in: strings } }];
  if (objectIds.length) or.push({ "collectionName._id": { $in: objectIds } });

  const rows = await Product.aggregate([
    { $match: { $or: or } },
    {
      $project: {
        name: 1,
        description: 1,
        itemCode: 1,
        _cid: { $toString: { $ifNull: ["$collectionName._id", ""] } },
      },
    },
    { $match: { _cid: { $in: strings } } },
    {
      $group: {
        _id: "$_cid",
        products: {
          $push: {
            _id: "$_id",
            name: "$name",
            description: "$description",
            sku: "$itemCode",
          },
        },
      },
    },
    {
      $project: {
        products: { $slice: ["$products", Math.max(1, perCollection)] },
      },
    },
  ]).allowDiskUse(true);

  for (const row of rows) {
    out.set(String(row._id), Array.isArray(row.products) ? row.products : []);
  }
  return out;
}

function confidenceMatches(suggestion, confidence) {
  if (!confidence) return true;
  const band = String(confidence).toUpperCase();
  if (band === "REVIEW" || band === "NEEDS_REVIEW") {
    return suggestion.overallConfidence === ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW;
  }
  return suggestion.overallConfidence === band;
}

function assertWithinDeadline(startedAt, timeoutMs) {
  if (Date.now() - startedAt <= timeoutMs) return;
  throw new ElryanClientError(
    `Elryan mapping preview timed out after ${timeoutMs}ms. Narrow search/filters or retry a smaller page.`,
    { status: 504, code: "mapping_preview_timeout" }
  );
}

/**
 * Preview-only suggestions. Never writes PlatformTaxonomyConfig.
 *
 * Performance contract:
 * - Cheap filters (q / mapped status) first
 * - Paginate before product sampling + scoring (limit applies to work, not only the response)
 * - One batched product sample query for the page
 * - Soft timeout with a clear error
 */
export async function buildElryanMappingPreview({
  q = "",
  status = "",
  confidence = "",
  brownCollectionId = "",
  limit = ELRYAN_MAPPING_PREVIEW.DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const startedAt = Date.now();
  const timeoutMs = ELRYAN_MAPPING_PREVIEW.TIMEOUT_MS;
  const take = Math.min(
    ELRYAN_MAPPING_PREVIEW.MAX_LIMIT,
    Math.max(1, Number(limit) || ELRYAN_MAPPING_PREVIEW.DEFAULT_LIMIT)
  );
  const start = Math.max(0, Number(offset) || 0);

  const connection = await getElryanConnectionPublic();
  const mappingEnvironment = normalizeElryanMappingEnvironment(connection.environment);

  const snapshot = await ElryanCategoryCatalogSnapshot.findOne({
    environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
  })
    .select("uniqueCount coverage status finishedAt updatedAt categories")
    .lean();
  const catalog = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
  if (!catalog.length) {
    throw new ElryanClientError(
      "No staging Elryan category catalog snapshot yet. Run Category Discovery → Fetch full catalog first.",
      { status: 409, code: "catalog_snapshot_missing" }
    );
  }
  if (mappingEnvironment !== ELRYAN_CATALOG_SYNC.ENVIRONMENT) {
    throw new ElryanClientError(
      `Active Elryan connection is ${mappingEnvironment}, but the category catalog snapshot is staging-only. Switch connection to staging or fetch a ${mappingEnvironment} catalog before mapping.`,
      { status: 409, code: "catalog_env_unavailable" }
    );
  }
  const preparedCatalog = prepareElryanCatalogForMatching(catalog);

  assertWithinDeadline(startedAt, timeoutMs);

  const [{ collections }, configs] = await Promise.all([
    discoverBrownCollections(),
    PlatformTaxonomyConfig.find({ partner: "elryan" }).select("brownCollectionId values").lean(),
  ]);
  const byCollection = new Map(
    configs.map((row) => [String(row.brownCollectionId), row.values || {}])
  );

  let filtered = collections;
  if (brownCollectionId) {
    filtered = filtered.filter((row) => String(row.brownCollectionId) === String(brownCollectionId));
  }
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    filtered = filtered.filter((row) => {
      const hay = `${localizedPath(row)} ${row.brownCollectionId}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  // Mapped/unmapped filter is cheap (no product reads).
  if (status === "mapped" || status === "unmapped" || status === "missing") {
    filtered = filtered.filter((row) => {
      const existing = mappingStatus(byCollection.get(String(row.brownCollectionId)), mappingEnvironment);
      if (status === "mapped") return existing.configured;
      return !existing.configured;
    });
  }

  const mappedCount = collections.filter((c) =>
    elryanMappingIsComplete(byCollection.get(String(c.brownCollectionId)), mappingEnvironment)
  ).length;

  /**
   * Paginate before heavy work. When a confidence band is requested, scan forward
   * in bounded chunks until the page is filled or MAX_COLLECTIONS_SCORED is hit.
   */
  const maxScore = Math.min(
    ELRYAN_MAPPING_PREVIEW.MAX_COLLECTIONS_SCORED,
    Math.max(take, confidence ? take * 3 : take)
  );
  const scanStart = start;
  const scanEnd = Math.min(filtered.length, scanStart + maxScore);
  const toScore = filtered.slice(scanStart, scanEnd);

  assertWithinDeadline(startedAt, timeoutMs);

  const productSamples = await sampleProductsForCollections(
    toScore.map((row) => row.brownCollectionId),
    ELRYAN_MAPPING_PREVIEW.PRODUCT_SAMPLES_PER_COLLECTION
  );

  assertWithinDeadline(startedAt, timeoutMs);

  const previews = [];
  let scored = 0;
  for (const collection of toScore) {
    assertWithinDeadline(startedAt, timeoutMs);
    scored += 1;
    const existing = mappingStatus(
      byCollection.get(String(collection.brownCollectionId)),
      mappingEnvironment
    );
    const products = productSamples.get(String(collection.brownCollectionId)) || [];
    const suggestion = suggestElryanCategoriesForCollection(
      collection,
      preparedCatalog,
      products,
      5
    );
    if (!confidenceMatches(suggestion, confidence)) continue;

    previews.push({
      brownCollectionId: collection.brownCollectionId,
      brownCollectionName: collection.brownCollectionName,
      brownCategoryName: collection.brownCategoryName,
      brownSubCategoryName: collection.brownSubCategoryName,
      taxonomyPath: localizedPath(collection),
      productCount: collection.productCount,
      ambiguousHierarchy: Boolean(collection.ambiguousHierarchy),
      existingMapping: existing,
      overallConfidence: suggestion.overallConfidence,
      candidates: suggestion.candidates,
      previewOnly: true,
      autoSave: false,
      note: "Suggestions never auto-save. Confirm and Save Mapping explicitly to persist locally.",
    });

    if (previews.length >= take) break;
  }

  const truncated = scanEnd < filtered.length || (confidence && previews.length < take && scored >= maxScore);

  return {
    environment: mappingEnvironment,
    catalog: {
      uniqueCount: snapshot.uniqueCount || catalog.length,
      coverage: snapshot.coverage || "unknown",
      status: snapshot.status || "idle",
      fetchedAt: snapshot.finishedAt || snapshot.updatedAt || null,
      environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
    },
    counts: {
      collections: collections.length,
      filtered: filtered.length,
      scored,
      previewed: previews.length,
      mapped: mappedCount,
    },
    totalMatching: confidence ? previews.length : filtered.length,
    offset: start,
    limit: take,
    rows: previews.slice(0, take),
    timingMs: Date.now() - startedAt,
    truncated,
    writesDisabled: true,
    mappingPersistence: "explicit_save_only",
    sentToElryan: false,
  };
}

/**
 * Attribute compatibility for a suggested Elryan category (read-only staging).
 * Does not invent attribute IDs; surfaces API payload fields only.
 */
export async function elryanAttributeCompatibility(categoryId) {
  const id = String(categoryId || "").trim();
  if (!id) {
    throw new ElryanClientError("categoryId is required", { status: 400, code: "category_required" });
  }
  let attributes = [];
  let attributeSet = null;
  const blockers = [];

  try {
    const attrs = await elryanCategoryAttributes(id);
    attributes = attrs.attributes || [];
  } catch (err) {
    blockers.push(`Category attributes request failed: ${err?.message || "error"}`);
  }

  try {
    const setResult = await elryanAttributeSetForCategory(id);
    attributeSet = setResult.attributeSet || null;
  } catch (err) {
    blockers.push(`Attribute set request failed: ${err?.message || "error"}`);
  }

  const setAttrs = Array.isArray(attributeSet?.attributes) ? attributeSet.attributes : [];
  const mandatory = setAttrs.filter((a) => a?.mandatory === true);

  const codes = mandatory.map((a) => String(a.code || a.name || "").toLowerCase());
  const looksBrand = codes.some((c) => c.includes("brand"));
  const looksColor = codes.some((c) => c.includes("color") || c.includes("colour"));
  const looksSize = codes.some((c) => c.includes("size"));

  if (!mandatory.length && !blockers.length) {
    blockers.push("No mandatory attributes reported for this category in the attribute set response.");
  }

  return {
    categoryId: id,
    attributeSetId: attributeSet?.id ?? null,
    attributeSetName: attributeSet?.name || "",
    productNameFormat: attributeSet?.productNameFormat || "",
    mandatoryAttributes: mandatory.map((a) => ({
      id: a.id ?? null,
      code: a.code || "",
      name: a.name || "",
      input: a.input || "",
      valueCount: Array.isArray(a.values) ? a.values.length : 0,
    })),
    categoryAttributes: attributes.map((a) => ({
      attributeId: a.attributeId ?? null,
      key: a.key || "",
      name: a.name || "",
      nameAr: a.nameAr || "",
      source: a.source || "",
      sourceCategoryId: a.sourceCategoryId ?? null,
    })),
    hints: {
      brandLikelyRequired: looksBrand,
      colourLikelyRequired: looksColor,
      sizeLikelyRequired: looksSize,
    },
    blockers,
    note:
      "Category confidence ≠ product publish readiness. Brand/colour/size/warranty/pricing/images may still block.",
    previewOnly: true,
  };
}
