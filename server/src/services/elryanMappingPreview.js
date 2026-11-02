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
  const cat =
    collection.brownCategoryName?.en ||
    collection.brownCategoryName?.ar ||
    collection.brownCategoryName?.ku ||
    "";
  const sub =
    collection.brownSubCategoryName?.en ||
    collection.brownSubCategoryName?.ar ||
    collection.brownSubCategoryName?.ku ||
    "";
  const col =
    collection.brownCollectionName?.en ||
    collection.brownCollectionName?.ar ||
    collection.brownCollectionName?.ku ||
    "";
  return [cat, sub, col].filter(Boolean).join(" → ");
}

function collectionSearchHaystack(collection) {
  return [
    localizedPath(collection),
    collection.brownCollectionId,
    collection.brownCollectionName?.en,
    collection.brownCollectionName?.ar,
    collection.brownCollectionName?.ku,
    collection.brownCategoryName?.en,
    collection.brownCategoryName?.ar,
    collection.brownCategoryName?.ku,
    collection.brownSubCategoryName?.en,
    collection.brownSubCategoryName?.ar,
    collection.brownSubCategoryName?.ku,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

/** How many cheap-filtered collections a single preview may score. */
export function elryanMappingScanBudget(take, confidenceFiltered) {
  const size = Math.max(1, Number(take) || 1);
  const widened = confidenceFiltered ? size * 3 : size;
  return Math.min(
    ELRYAN_MAPPING_PREVIEW.MAX_COLLECTIONS_SCORED,
    Math.max(size, widened)
  );
}

/**
 * Visit planned collections in order until the page is full.
 * `visit` returns a row to keep, or null to skip. Every visit counts as consumed,
 * including skips. Collections after an early full page are not visited.
 */
export function collectElryanMappingPage(planned, { take, visit }) {
  const limit = Math.max(1, Number(take) || 1);
  const rows = [];
  let consumed = 0;
  for (const item of planned || []) {
    consumed += 1;
    const row = visit(item);
    if (row) rows.push(row);
    if (rows.length >= limit) break;
  }
  return { rows, consumed, filled: rows.length >= limit };
}

/**
 * Continuation cursor for one preview page.
 * `nextOffset` is the first cheap-filtered index that was NOT scored.
 * It must not jump to the end of the planned scan window.
 * A confidence band never publishes a partial page length as an exact global total.
 */
export function finalizeElryanMappingPage({
  filteredLength,
  offset,
  plannedCount,
  consumed,
  pageMatchCount,
  confidenceFiltered,
}) {
  const length = Math.max(0, Number(filteredLength) || 0);
  const start = Math.max(0, Number(offset) || 0);
  const confidence = Boolean(confidenceFiltered);
  if (start >= length) {
    return {
      offset: start,
      nextOffset: length,
      hasMore: false,
      scanned: 0,
      scanBudget: Math.max(0, Number(plannedCount) || 0),
      pageMatchCount: 0,
      totalMatching: confidence ? null : length,
      totalMatchingExact: !confidence,
      confidenceFiltered: confidence,
      confidenceMatchCountExact: !confidence,
      truncated: false,
      progress: confidence
        ? {
            exact: false,
            pageMatches: 0,
            scannedFrom: length,
            scannedTo: length,
            filteredCollections: length,
            hasMore: false,
          }
        : { exact: true, from: 0, to: 0, total: length, hasMore: false },
    };
  }

  const room = length - start;
  const used = Math.max(0, Math.min(room, Number(consumed) || 0));
  const nextOffset = start + used;
  const hasMore = nextOffset < length;
  const matches = Math.max(0, Number(pageMatchCount) || 0);
  return {
    offset: start,
    nextOffset,
    hasMore,
    scanned: used,
    scanBudget: Math.max(0, Number(plannedCount) || 0),
    pageMatchCount: matches,
    totalMatching: confidence ? null : length,
    totalMatchingExact: !confidence,
    confidenceFiltered: confidence,
    confidenceMatchCountExact: !confidence,
    truncated: hasMore,
    progress: confidence
      ? {
          exact: false,
          pageMatches: matches,
          scannedFrom: start,
          scannedTo: nextOffset,
          filteredCollections: length,
          hasMore,
        }
      : {
          exact: true,
          from: matches ? start + 1 : 0,
          to: start + matches,
          total: length,
          hasMore,
        },
  };
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
    filtered = filtered.filter((row) => collectionSearchHaystack(row).includes(needle));
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
   * Paginate before heavy work. A confidence band may score a bounded window
   * larger than the page, but the cursor advances only through collections
   * actually scored. Unscored tail rows stay available on the next request.
   */
  const confidenceFiltered = Boolean(String(confidence || "").trim());
  const maxScore = elryanMappingScanBudget(take, confidenceFiltered);
  const scanStart = Math.min(start, filtered.length);
  const planned = filtered.slice(scanStart, Math.min(filtered.length, scanStart + maxScore));

  assertWithinDeadline(startedAt, timeoutMs);

  const productSamples = await sampleProductsForCollections(
    planned.map((row) => row.brownCollectionId),
    ELRYAN_MAPPING_PREVIEW.PRODUCT_SAMPLES_PER_COLLECTION
  );

  assertWithinDeadline(startedAt, timeoutMs);

  const collected = collectElryanMappingPage(planned, {
    take,
    visit(collection) {
      assertWithinDeadline(startedAt, timeoutMs);
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
      if (!confidenceMatches(suggestion, confidence)) return null;
      return {
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
      };
    },
  });

  const page = finalizeElryanMappingPage({
    filteredLength: filtered.length,
    offset: start,
    plannedCount: planned.length,
    consumed: collected.consumed,
    pageMatchCount: collected.rows.length,
    confidenceFiltered,
  });

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
      scored: page.scanned,
      previewed: collected.rows.length,
      mapped: mappedCount,
    },
    totalMatching: page.totalMatching,
    totalMatchingExact: page.totalMatchingExact,
    confidenceFiltered: page.confidenceFiltered,
    confidenceMatchCountExact: page.confidenceMatchCountExact,
    offset: page.offset,
    nextOffset: page.nextOffset,
    hasMore: page.hasMore,
    limit: take,
    pageMatchCount: page.pageMatchCount,
    scanned: page.scanned,
    scanBudget: page.scanBudget,
    progress: page.progress,
    rows: collected.rows,
    timingMs: Date.now() - startedAt,
    truncated: page.truncated,
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
