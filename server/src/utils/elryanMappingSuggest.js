import { ELRYAN_MAPPING_CONFIDENCE } from "./elryanConstants.js";

const STOP = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "of",
  "for",
  "with",
  "to",
  "in",
  "on",
  "&",
  "و",
]);

export function normalizeElryanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeElryanText(value) {
  return normalizeElryanText(value)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && t.length > 1 && !STOP.has(t));
}

function localizedStrings(name) {
  if (name == null) return [];
  if (typeof name === "string") return [name];
  return [name.en, name.ar, name.ku].filter((v) => String(v || "").trim());
}

function jaccard(aTokens, bTokens) {
  const a = new Set(aTokens);
  const b = new Set(bTokens);
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function hierarchyParts(hierarchy) {
  return String(hierarchy || "")
    .split(/\s*:\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function leafName(category) {
  const parts = hierarchyParts(category?.hierarchy);
  if (parts.length) return parts[parts.length - 1];
  return String(category?.name || "");
}

function isLeafCategory(category) {
  if (category?.isParent === false) return true;
  if (category?.isParent === true) return false;
  return null;
}

/**
 * Deterministic, explainable scoring of one Elryan category vs one BrownStore collection.
 * Returns heuristic score 0..100 (not a calibrated probability) + confidence band + reasons.
 */
export function scoreElryanCategoryCandidate(collection, category, productEvidence = []) {
  const reasons = [];
  const missing = [];
  let score = 0;

  const context = collectionScoreContext(collection);
  const elryanName = String(category?.name || "");
  const hierarchy = String(category?.hierarchy || "");
  const hierarchyNorm = normalizeElryanText(hierarchy);
  const elryanNorm = normalizeElryanText(elryanName);
  const leaf = leafName(category);
  const leafNorm = normalizeElryanText(leaf);
  const leafFlag = isLeafCategory(category);

  let exactCollection = false;
  for (const entry of context.collectionNorms) {
    if (!entry.norm) continue;
    if (entry.norm === elryanNorm || entry.norm === leafNorm) {
      exactCollection = true;
      score += 48;
      reasons.push(`Exact normalized collection name match: "${entry.name}" ↔ "${leaf || elryanName}"`);
      break;
    }
  }

  let subInHierarchy = false;
  for (const entry of context.subNorms) {
    if (entry.norm && hierarchyNorm.includes(entry.norm)) {
      subInHierarchy = true;
      score += 18;
      reasons.push(`Subcategory appears in Elryan hierarchy: "${entry.name}"`);
      break;
    }
  }

  let catInHierarchy = false;
  for (const entry of context.categoryNorms) {
    if (entry.norm && hierarchyNorm.includes(entry.norm)) {
      catInHierarchy = true;
      score += 12;
      reasons.push(`Category appears in Elryan hierarchy: "${entry.name}"`);
      break;
    }
  }

  const pathTokens = context.pathTokens;
  const hierTokens = tokenizeElryanText(hierarchy);
  const nameTokens = tokenizeElryanText(elryanName);
  const jacHier = jaccard(pathTokens, hierTokens);
  const jacName = jaccard(pathTokens, nameTokens);
  if (jacHier >= 0.35) {
    score += Math.round(jacHier * 16);
    reasons.push(`Hierarchy token similarity ${(jacHier * 100).toFixed(0)}%`);
  }
  if (jacName >= 0.4) {
    score += Math.round(jacName * 10);
    reasons.push(`Name token similarity ${(jacName * 100).toFixed(0)}%`);
  }

  // Product evidence (supporting only)
  const evidenceHits = [];
  for (const entry of evidenceBlobs(productEvidence)) {
    const { product, blob } = entry;
    if (!blob) continue;
    const leafTokens = tokenizeElryanText(leaf);
    const hits = leafTokens.filter((t) => t.length > 3 && blob.includes(t));
    if (hits.length >= 2 || (leafNorm && blob.includes(leafNorm) && leafNorm.length > 4)) {
      evidenceHits.push(String(product?.name?.en || product?.name?.ar || product?.sku || product?._id || "product"));
    }
  }
  if (evidenceHits.length) {
    score += Math.min(10, evidenceHits.length * 3);
    reasons.push(`Product text mentions related terms (${evidenceHits.slice(0, 3).join(", ")})`);
  }

  if (leafFlag === true) {
    score += 6;
    reasons.push("Candidate is a leaf category (isParent=false)");
  } else if (leafFlag === false) {
    score -= 12;
    reasons.push("Candidate is a parent category — prefer a leaf for product mapping");
    missing.push("Prefer a leaf category under this parent when available");
  } else {
    missing.push("isParent unknown — leaf preference not confirmed");
  }

  if (category?.attributeSetId == null && !category?.attributeSet) {
    missing.push("Attribute set id not present on catalog row");
  }

  // Divergent leaf under a shared mid-level (e.g. Acne Patches vs Blackhead & Acne Removers)
  const leafTokens = tokenizeElryanText(leaf);
  const collectionTokens = context.collectionTokens;
  const leafJac = jaccard(collectionTokens, leafTokens);
  const divergentLeaf =
    !exactCollection &&
    hierarchyParts(hierarchy).length >= 2 &&
    leafJac < 0.55;

  let confidence = ELRYAN_MAPPING_CONFIDENCE.NO_MATCH;
  if (score >= 70 && exactCollection && (subInHierarchy || catInHierarchy) && leafFlag !== false) {
    confidence = ELRYAN_MAPPING_CONFIDENCE.HIGH;
  } else if (score >= 55 && exactCollection) {
    confidence = leafFlag === false ? ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW : ELRYAN_MAPPING_CONFIDENCE.MEDIUM;
  } else if (score >= 55 && subInHierarchy && leafJac >= 0.55) {
    confidence = leafFlag === false ? ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW : ELRYAN_MAPPING_CONFIDENCE.MEDIUM;
  } else if (score >= 40) {
    confidence = ELRYAN_MAPPING_CONFIDENCE.LOW;
  } else if (score >= 25) {
    confidence = ELRYAN_MAPPING_CONFIDENCE.LOW;
  }

  // Ambiguous near-matches must surface as NEEDS_REVIEW, never silent NO_MATCH and never HIGH.
  if (
    divergentLeaf &&
    (subInHierarchy || catInHierarchy || leafJac > 0.05 || jacName >= 0.15 || score >= 15)
  ) {
    if (score < 25) score = Math.max(score, 28);
    confidence = ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW;
    reasons.push(
      "Leaf names are not equivalent despite hierarchy overlap — human review required (not auto-equivalent)"
    );
  }

  if (!exactCollection && !subInHierarchy && !catInHierarchy && jacName >= 0.25 && confidence !== ELRYAN_MAPPING_CONFIDENCE.NO_MATCH) {
    confidence = ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW;
    reasons.push(
      "Partial name similarity without shared category/subcategory context — human review required"
    );
  }

  if (exactCollection && !subInHierarchy && !catInHierarchy && leafFlag !== false) {
    confidence = ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW;
    reasons.push("Exact name match without hierarchy context — do not assume identical product categories");
  }

  score = Math.max(0, Math.min(100, score));

  return {
    categoryId: category?.id ?? null,
    categoryName: elryanName,
    hierarchy,
    isParent: category?.isParent ?? null,
    parentId: category?.parentId ?? null,
    level: category?.level ?? null,
    attributeSetId: category?.attributeSetId ?? null,
    attributeSet: category?.attributeSet || "",
    leafPreferred: leafFlag === true,
    score,
    confidence,
    reasons,
    missing,
    productEvidence: evidenceHits.slice(0, 5),
  };
}

const MAX_FULL_SCORES_PER_COLLECTION = 250;
const scoreContextCache = new WeakMap();
const evidenceBlobCache = new WeakMap();

function collectionScoreContext(collection) {
  const cached = scoreContextCache.get(collection);
  if (cached) return cached;
  const collectionNames = localizedStrings(collection?.brownCollectionName || collection?.name);
  const categoryNames = localizedStrings(collection?.brownCategoryName || collection?.categoryName);
  const subNames = localizedStrings(collection?.brownSubCategoryName || collection?.subCategoryName);
  const context = {
    collectionNames,
    categoryNames,
    subNames,
    collectionNorms: collectionNames.map((name) => ({ name, norm: normalizeElryanText(name) })),
    subNorms: subNames.map((name) => ({ name, norm: normalizeElryanText(name) })),
    categoryNorms: categoryNames.map((name) => ({ name, norm: normalizeElryanText(name) })),
    pathTokens: [
      ...tokenizeElryanText(collectionNames.join(" ")),
      ...tokenizeElryanText(subNames.join(" ")),
      ...tokenizeElryanText(categoryNames.join(" ")),
    ],
    collectionTokens: tokenizeElryanText(collectionNames.join(" ")),
  };
  if (collection && typeof collection === "object") scoreContextCache.set(collection, context);
  return context;
}

function evidenceBlobs(productEvidence) {
  const list = Array.isArray(productEvidence) ? productEvidence : [];
  if (!list.length) return [];
  const cached = evidenceBlobCache.get(list);
  if (cached) return cached;
  const blobs = list.slice(0, 8).map((product) => ({
    product,
    blob: normalizeElryanText(
      `${product?.name?.en || ""} ${product?.name?.ar || ""} ${product?.name?.ku || ""} ${product?.description?.en || ""}`
    ),
  }));
  evidenceBlobCache.set(list, blobs);
  return blobs;
}

/** Exact trigram index for hay.includes(token) when token length is at least 3. */
export function attachElryanTrigramIndex(prepared) {
  const rows = Array.isArray(prepared) ? prepared : [];
  const hays = rows.map((row) => `${row.nameNorm} ${row.hierarchyNorm}`);
  const lists = new Map();
  hays.forEach((hay, index) => {
    const seen = new Set();
    for (let i = 0; i <= hay.length - 3; i += 1) {
      const gram = hay.slice(i, i + 3);
      if (seen.has(gram)) continue;
      seen.add(gram);
      const list = lists.get(gram);
      if (list) list.push(index);
      else lists.set(gram, [index]);
    }
  });
  rows.hays = hays;
  rows.trigramLists = lists;
  return rows;
}

function trigramOverlaps(pathTokens, prepared) {
  const counts = new Int32Array(prepared.length);
  for (const token of pathTokens) {
    if (token.length < 3) continue;
    for (const id of rowIdsContainingToken(token, prepared)) counts[id] += 1;
  }
  const relevant = [];
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] > 0) relevant.push({ row: prepared[index], overlap: counts[index] });
  }
  return relevant;
}

function rowIdsContainingToken(token, prepared) {
  const lists = prepared.trigramLists;
  const grams = [];
  for (let i = 0; i <= token.length - 3; i += 1) grams.push(token.slice(i, i + 3));
  grams.sort((left, right) => (lists.get(left)?.length || 0) - (lists.get(right)?.length || 0));
  let ids = lists.get(grams[0]);
  if (!ids?.length) return [];
  for (let i = 1; i < grams.length; i += 1) {
    const next = lists.get(grams[i]);
    if (!next?.length) return [];
    const set = new Set(next);
    ids = ids.filter((id) => set.has(id));
    if (!ids.length) return [];
  }
  const hays = prepared.hays;
  const matched = [];
  for (const id of ids) if (hays[id].includes(token)) matched.push(id);
  return matched;
}

/** Precompute norms/tokens once per request (avoids re-normalizing 1k+ rows per collection). */
export function prepareElryanCatalogForMatching(catalog) {
  return (Array.isArray(catalog) ? catalog : []).map((category) => {
    const name = String(category?.name || "");
    const hierarchy = String(category?.hierarchy || "");
    const leaf = leafName(category);
    return {
      category,
      nameNorm: normalizeElryanText(name),
      hierarchyNorm: normalizeElryanText(hierarchy),
      leafNorm: normalizeElryanText(leaf),
      hierarchyTokens: tokenizeElryanText(hierarchy),
      leafTokens: tokenizeElryanText(leaf),
    };
  });
}

function collectionPathTokens(collection) {
  const names = [
    ...localizedStrings(collection?.brownCollectionName || collection?.name),
    ...localizedStrings(collection?.brownSubCategoryName || collection?.subCategoryName),
    ...localizedStrings(collection?.brownCategoryName || collection?.categoryName),
  ];
  return tokenizeElryanText(names.join(" "));
}

function cheapOverlapCount(pathTokens, prepared) {
  if (!pathTokens.length) return 0;
  let hits = 0;
  const hay = `${prepared.nameNorm} ${prepared.hierarchyNorm}`;
  for (const token of pathTokens) {
    if (token.length < 3) continue;
    if (hay.includes(token)) hits += 1;
  }
  return hits;
}

/**
 * Score a bounded, relevance-filtered subset of the catalog.
 * Matching rules unchanged for candidates that share path tokens; unrelated rows are skipped.
 */
export function suggestElryanCategoriesForCollection(collection, catalog, productEvidence = [], limit = 5) {
  const prepared = Array.isArray(catalog) && catalog[0]?.category
    ? catalog
    : prepareElryanCatalogForMatching(catalog);
  const pathTokens = collectionPathTokens(collection);

  let pool = prepared;
  if (pathTokens.length) {
    const relevant = prepared.trigramLists
      ? trigramOverlaps(pathTokens, prepared)
      : prepared
          .map((row) => ({ row, overlap: cheapOverlapCount(pathTokens, row) }))
          .filter((item) => item.overlap > 0);
    if (relevant.length) {
      relevant.sort((a, b) => b.overlap - a.overlap);
      pool = relevant.slice(0, MAX_FULL_SCORES_PER_COLLECTION).map((item) => item.row);
    } else {
      // No token overlap — avoid full 1k+ scan; return no match quickly.
      return {
        overallConfidence: ELRYAN_MAPPING_CONFIDENCE.NO_MATCH,
        candidates: [],
        candidateCount: 0,
      };
    }
  } else if (pool.length > MAX_FULL_SCORES_PER_COLLECTION) {
    pool = pool.slice(0, MAX_FULL_SCORES_PER_COLLECTION);
  }

  const ranked = pool
    .map((row) => scoreElryanCategoryCandidate(collection, row.category, productEvidence))
    .filter((row) => row.confidence !== ELRYAN_MAPPING_CONFIDENCE.NO_MATCH || row.score >= 25)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.leafPreferred !== b.leafPreferred) return a.leafPreferred ? -1 : 1;
      return String(a.categoryName).localeCompare(String(b.categoryName));
    });

  const top = ranked.slice(0, Math.max(1, Math.min(5, limit)));
  const best = top[0] || null;
  let overall = ELRYAN_MAPPING_CONFIDENCE.NO_MATCH;
  if (!best || best.score < 25) overall = ELRYAN_MAPPING_CONFIDENCE.NO_MATCH;
  else if (top.filter((c) => c.score >= best.score - 8).length > 1 && best.confidence !== ELRYAN_MAPPING_CONFIDENCE.HIGH) {
    overall = ELRYAN_MAPPING_CONFIDENCE.NEEDS_REVIEW;
  } else overall = best.confidence;

  return {
    overallConfidence: overall,
    candidates: top,
    candidateCount: top.length,
  };
}

/** Documented example: Acne Patches vs Blackhead & Acne Removers must not auto-HIGH. */
export function acnePatchesNeedsReviewExample() {
  const collection = {
    brownCollectionName: { en: "Acne Patches", ar: "لصقات حب الشباب" },
    brownSubCategoryName: { en: "Skin Care" },
    brownCategoryName: { en: "Beauty & Personal Care" },
  };
  const category = {
    id: 999,
    name: "Blackhead & Acne Removers",
    hierarchy: "Beauty & Fragrance : Skin Care : Tools & Accessories : Blackhead & Acne Removers",
    isParent: false,
    level: 4,
  };
  return scoreElryanCategoryCandidate(collection, category, []);
}
