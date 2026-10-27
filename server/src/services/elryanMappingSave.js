import { Product } from "../models/Product.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { discoverBrownCollections } from "../utils/brownTaxonomy.js";
import { ELRYAN_CATALOG_SYNC } from "../utils/elryanConstants.js";
import {
  elryanMappingDiff,
  elryanMappingIsComplete,
  elryanValuesForEnvironment,
  mergeElryanEnvironmentMapping,
  normalizeElryanMappingEnvironment,
} from "../utils/elryanTaxonomyMapping.js";
import { resolveTaxonomyNotices } from "../utils/taxonomyNotices.js";
import { ElryanClientError } from "./elryanClient.js";
import { getElryanConnectionPublic } from "./elryanConnection.js";
import { elryanAttributeCompatibility } from "./elryanMappingPreview.js";

function localized(name) {
  if (!name) return { en: "", ar: "", ku: "" };
  if (typeof name === "string") return { en: name, ar: name, ku: name };
  return {
    en: String(name.en || ""),
    ar: String(name.ar || ""),
    ku: String(name.ku || ""),
  };
}

function categoryKind(row) {
  if (row?.isParent === true) return "parent";
  if (row?.isParent === false) return "leaf";
  return "unknown";
}

async function loadBrownCollection(brownCollectionId) {
  const id = String(brownCollectionId || "").trim();
  if (!id) {
    throw new ElryanClientError("brownCollectionId is required", {
      status: 400,
      code: "collection_required",
    });
  }
  const exists = await Product.exists({
    $expr: {
      $eq: [{ $toString: { $ifNull: ["$collectionName._id", ""] } }, id],
    },
  });
  if (!exists) {
    throw new ElryanClientError("That BrownStore collection was not found", {
      status: 404,
      code: "collection_not_found",
    });
  }
  const { collections } = await discoverBrownCollections();
  const row = collections.find((item) => String(item.brownCollectionId) === id);
  return (
    row || {
      brownCollectionId: id,
      brownCollectionName: { en: id },
      brownCategoryName: {},
      brownSubCategoryName: {},
      productCount: 0,
    }
  );
}

async function loadSnapshotForEnvironment(environment) {
  const env = normalizeElryanMappingEnvironment(environment);
  // Phase 3 snapshot model is staging-only today.
  if (env !== ELRYAN_CATALOG_SYNC.ENVIRONMENT) {
    throw new ElryanClientError(
      `No ${env} Elryan category catalog snapshot is available. Fetch a ${env} catalog before saving ${env} mappings. Staging category IDs cannot be reused in production.`,
      { status: 409, code: "catalog_env_unavailable" }
    );
  }
  const snapshot = await ElryanCategoryCatalogSnapshot.findOne({ environment: env })
    .select("status coverage uniqueCount categories")
    .lean();
  const categories = Array.isArray(snapshot?.categories) ? snapshot.categories : [];
  if (!categories.length) {
    throw new ElryanClientError(
      "No staging Elryan category catalog snapshot yet. Fetch the full catalog first.",
      { status: 409, code: "catalog_snapshot_missing" }
    );
  }
  return { snapshot, categories, environment: env };
}

export function findCategoryInSnapshot(categories, categoryId) {
  const id = String(categoryId ?? "").trim();
  if (!id) return null;
  return (
    categories.find((row) => String(row?.id ?? row?._id ?? row?.categoryId ?? "") === id) || null
  );
}

/**
 * Paginated search over the environment snapshot (no heuristic ranking override).
 */
export async function searchElryanSnapshotCategories({
  q = "",
  limit = 30,
  offset = 0,
  leafOnly = false,
} = {}) {
  const connection = await getElryanConnectionPublic();
  const environment = normalizeElryanMappingEnvironment(connection.environment);
  const { categories } = await loadSnapshotForEnvironment(environment);

  const needle = String(q || "").trim().toLowerCase();
  let rows = categories.map((row) => ({
    categoryId: row.id ?? row._id ?? null,
    categoryName: String(row.name || ""),
    hierarchy: String(row.hierarchy || ""),
    parentId: row.parentId ?? null,
    isParent: row.isParent === true ? true : row.isParent === false ? false : null,
    kind: categoryKind(row),
    level: row.level ?? null,
    attributeSetId: row.attributeSetId ?? null,
    attributeSet: row.attributeSet || "",
  }));

  if (leafOnly) rows = rows.filter((row) => row.isParent === false);
  if (needle) {
    rows = rows.filter((row) => {
      const hay = `${row.categoryId} ${row.categoryName} ${row.hierarchy}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  // Prefer leaves in result order without hiding parents unless leafOnly.
  rows.sort((a, b) => {
    if (a.isParent === false && b.isParent !== false) return -1;
    if (b.isParent === false && a.isParent !== false) return 1;
    return String(a.categoryName).localeCompare(String(b.categoryName));
  });

  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(100, Math.max(1, Number(limit) || 30));
  return {
    environment,
    totalMatching: rows.length,
    offset: start,
    limit: take,
    categories: rows.slice(start, start + take),
    snapshot: {
      uniqueCount: categories.length,
      status: "complete",
    },
  };
}

/**
 * Build a pre-save review payload (no persistence).
 */
export async function previewElryanMappingSave({
  brownCollectionId,
  categoryId,
  includeAttributes = true,
} = {}) {
  const connection = await getElryanConnectionPublic();
  const environment = normalizeElryanMappingEnvironment(connection.environment);
  const brown = await loadBrownCollection(brownCollectionId);
  const { categories } = await loadSnapshotForEnvironment(environment);
  const category = findCategoryInSnapshot(categories, categoryId);
  if (!category) {
    throw new ElryanClientError(
      `Category ${categoryId} was not found in the ${environment} Elryan catalog snapshot. Arbitrary IDs are not accepted.`,
      { status: 400, code: "category_not_in_snapshot" }
    );
  }

  const kind = categoryKind(category);
  const blockers = [];
  const warnings = [];
  if (kind === "parent") {
    blockers.push(
      "Selected Elryan category is a parent (isParent=true). Save is blocked unless a leaf category is chosen. The OpenAPI product flows expect a concrete category id."
    );
  }
  if (kind === "unknown") {
    warnings.push("isParent is unknown on this snapshot row — prefer a confirmed leaf when possible.");
  }

  let attributes = null;
  if (includeAttributes) {
    try {
      attributes = await elryanAttributeCompatibility(category.id ?? categoryId);
      warnings.push(
        ...(attributes.blockers || []).map((b) => `Attribute note: ${b}`)
      );
    } catch (err) {
      warnings.push(`Attribute inspection failed: ${err?.message || "error"}`);
    }
  }

  const existingDoc = await PlatformTaxonomyConfig.findOne({
    partner: "elryan",
    brownCollectionId: String(brown.brownCollectionId),
  }).lean();
  const previous = elryanValuesForEnvironment(existingDoc?.values, environment);
  const next = {
    categoryId: String(category.id ?? categoryId),
    categoryName: String(category.name || ""),
    categoryHierarchy: String(category.hierarchy || ""),
    attributeSetId:
      category.attributeSetId != null && category.attributeSetId !== ""
        ? String(category.attributeSetId)
        : attributes?.attributeSetId != null
          ? String(attributes.attributeSetId)
          : "",
    elryanEnvironment: environment,
  };
  const changes = elryanMappingDiff(previous, next);
  const hasExisting = Boolean(previous.categoryId);

  return {
    environment,
    canSave: blockers.length === 0,
    blockers,
    warnings,
    requiresOverwriteConfirmation: hasExisting && changes.length > 0,
    brownStore: {
      brownCollectionId: String(brown.brownCollectionId),
      collectionName: localized(brown.brownCollectionName),
      categoryName: localized(brown.brownCategoryName),
      subCategoryName: localized(brown.brownSubCategoryName),
      productCount: Number(brown.productCount) || 0,
      taxonomyPath: [
        brown.brownCategoryName?.en || brown.brownCategoryName?.ar,
        brown.brownSubCategoryName?.en || brown.brownSubCategoryName?.ar,
        brown.brownCollectionName?.en || brown.brownCollectionName?.ar,
      ]
        .filter(Boolean)
        .join(" → "),
    },
    elryan: {
      ...next,
      kind,
      isParent: category.isParent === true ? true : category.isParent === false ? false : null,
      level: category.level ?? null,
      parentId: category.parentId ?? null,
    },
    previousMapping: previous,
    changes,
    attributes,
    notes: [
      "Saving writes BrownStore taxonomy config only — nothing is sent to Elryan.",
      "Category mapping validity is separate from brand/colour/warranty/pricing/image readiness.",
    ],
  };
}

/**
 * Persist a verified Elryan mapping. Requires confirm:true.
 * Requires overwrite:true when replacing an existing mapping for this environment.
 */
export async function saveElryanVerifiedMapping({
  brownCollectionId,
  categoryId,
  confirm,
  overwrite,
  source = "manual",
} = {}) {
  if (confirm !== true) {
    throw new ElryanClientError("Saving requires explicit confirm:true after reviewing the mapping.", {
      status: 400,
      code: "confirm_required",
    });
  }

  const review = await previewElryanMappingSave({
    brownCollectionId,
    categoryId,
    includeAttributes: true,
  });
  if (!review.canSave) {
    throw new ElryanClientError(review.blockers.join(" "), {
      status: 400,
      code: "mapping_blocked",
    });
  }
  if (review.requiresOverwriteConfirmation && overwrite !== true) {
    throw new ElryanClientError(
      "An Elryan mapping already exists for this collection and environment. Pass overwrite:true after confirming the diff.",
      { status: 409, code: "overwrite_required", details: { changes: review.changes, previous: review.previousMapping } }
    );
  }

  const collectionId = review.brownStore.brownCollectionId;
  const environment = review.environment;
  const existing = await PlatformTaxonomyConfig.findOne({
    partner: "elryan",
    brownCollectionId: collectionId,
  }).lean();

  const merged = mergeElryanEnvironmentMapping(existing?.values, environment, review.elryan);

  const saved = await PlatformTaxonomyConfig.findOneAndUpdate(
    { partner: "elryan", brownCollectionId: collectionId },
    {
      $set: {
        partner: "elryan",
        brownCollectionId: collectionId,
        values: merged,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  try {
    await resolveTaxonomyNotices("elryan");
  } catch (err) {
    console.error("Elryan taxonomy notice resolve failed:", err?.message || err);
  }

  const readBack = elryanValuesForEnvironment(saved.values, environment);
  const configured = elryanMappingIsComplete(saved.values, environment);

  return {
    ok: true,
    partner: "elryan",
    environment,
    source: String(source || "manual"),
    brownCollectionId: collectionId,
    configured,
    values: readBack,
    previousMapping: review.previousMapping,
    changes: review.changes,
    warnings: review.warnings,
    readBackConfirmed:
      readBack.categoryId === String(review.elryan.categoryId) &&
      readBack.categoryHierarchy === String(review.elryan.categoryHierarchy || ""),
    sentToElryan: false,
    productWrites: false,
  };
}
