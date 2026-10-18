/**
 * In-memory Miswag category resolver for Sync All only.
 * Does NOT persist PlatformCategory / PlatformCategoryMapping.
 */

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’".,/\\|_+:;!?()[\]{}#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localizedBits(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  return [value.en, value.ar, value.ku, value.name].filter(Boolean);
}

function entityNames(entity) {
  if (!entity) return [];
  if (typeof entity === "string") return [entity];
  return localizedBits(entity.name || entity);
}

export function buildCategoryIndexes(categories = []) {
  const byExact = new Map();
  const byAlias = new Map();
  const list = [];
  for (const category of categories || []) {
    if (!category?.id) continue;
    if (category.level !== "L3" && category.level !== "L4") continue;
    list.push(category);
    for (const raw of [category.nameEn, category.nameAr, category.name, category.alias]) {
      const key = normalizeText(raw);
      if (!key || key.length < 2) continue;
      const bucket = byExact.get(key) || [];
      if (!bucket.some((row) => row.id === category.id)) bucket.push(category);
      byExact.set(key, bucket);
    }
    const alias = normalizeText(category.alias);
    if (alias) {
      const bucket = byAlias.get(alias) || [];
      if (!bucket.some((row) => row.id === category.id)) bucket.push(category);
      byAlias.set(alias, bucket);
    }
  }
  return { byExact, byAlias, list };
}

function uniqueExact(matches) {
  if (!matches?.length) return { status: "none" };
  const ids = new Set(matches.map((row) => row.id));
  if (ids.size === 1) return { status: "exact", category: matches[0] };
  return { status: "ambiguous", matches };
}

function keywordCandidates(indexes, terms) {
  const hits = [];
  const seen = new Set();
  for (const category of indexes.list) {
    const hay = normalizeText(
      [category.nameEn, category.nameAr, category.name, category.alias, category.path].join(" ")
    );
    const matchedTerms = terms.filter((term) => term.length >= 3 && hay.includes(term));
    if (!matchedTerms.length) continue;
    if (seen.has(category.id)) continue;
    seen.add(category.id);
    hits.push({ category, score: matchedTerms.length });
  }
  hits.sort((a, b) => b.score - a.score || a.category.id.localeCompare(b.category.id));
  return hits;
}

/**
 * Resolve one Miswag L3/L4 category for a BrownStore product.
 * Exact/alias first; keyword only if a single clear winner; otherwise skip.
 */
export function resolveMiswagCategoryForProduct(product, indexes) {
  if (!indexes?.list?.length) {
    return { ok: false, reason: "Miswag category could not be resolved safely", code: "category_index_empty" };
  }

  const queries = [
    ...entityNames(product?.collectionName),
    ...entityNames(product?.subCategory),
    ...entityNames(product?.category),
    ...localizedBits(product?.name),
  ]
    .map(normalizeText)
    .filter((value) => value.length >= 2);

  for (const query of queries) {
    const exact = uniqueExact(indexes.byExact.get(query) || []);
    if (exact.status === "exact") {
      return { ok: true, category: exact.category, matchType: "exact", query };
    }
    if (exact.status === "ambiguous") {
      return {
        ok: false,
        reason: "Miswag category could not be resolved safely",
        code: "category_ambiguous",
        query,
      };
    }
    const alias = uniqueExact(indexes.byAlias.get(query) || []);
    if (alias.status === "exact") {
      return { ok: true, category: alias.category, matchType: "alias", query };
    }
    if (alias.status === "ambiguous") {
      return {
        ok: false,
        reason: "Miswag category could not be resolved safely",
        code: "category_ambiguous",
        query,
      };
    }
  }

  const terms = [...new Set(queries.flatMap((query) => query.split(" ")).filter((part) => part.length >= 3))];
  const keywordHits = keywordCandidates(indexes, terms);
  if (keywordHits.length === 1) {
    return {
      ok: true,
      category: keywordHits[0].category,
      matchType: "keyword",
      query: terms.join(" "),
    };
  }
  if (keywordHits.length > 1 && keywordHits[0].score > keywordHits[1].score) {
    return {
      ok: true,
      category: keywordHits[0].category,
      matchType: "keyword",
      query: terms.join(" "),
    };
  }

  return {
    ok: false,
    reason: "Miswag category could not be resolved safely",
    code: keywordHits.length ? "category_ambiguous" : "category_unresolved",
  };
}
