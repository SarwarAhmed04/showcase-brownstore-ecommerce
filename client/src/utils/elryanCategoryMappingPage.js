/**
 * Elryan Category Mapping page helpers.
 * Navigation, BrownStore taxonomy labels, and per-card picker state.
 * Picking a category never persists a mapping.
 */
import { pickElryanCategoryState } from "./elryanSmartMappingSelect.js";

export const ELRYAN_CATEGORY_MAPPING_TAB = "elryanCategoryMapping";

/** Old Elryan category screens that now open the unified page. */
export const ELRYAN_LEGACY_CATEGORY_TABS = Object.freeze([
  "elryanCategories",
  "elryanSmartMapping",
  "mapping",
]);

export function isElryanLegacyCategoryTab(tab) {
  return ELRYAN_LEGACY_CATEGORY_TABS.includes(String(tab || ""));
}

/** Use only for the Elryan partner. GINI still uses the generic mapping tab. */
export function resolveElryanPlatformTab(tab) {
  if (isElryanLegacyCategoryTab(tab)) return ELRYAN_CATEGORY_MAPPING_TAB;
  return tab;
}

export function isElryanCategoryMappingTab(tab) {
  return tab === ELRYAN_CATEGORY_MAPPING_TAB || isElryanLegacyCategoryTab(tab);
}

export function elryanPlatformSectionEntries() {
  return [
    ["connection", "elryanApiConnection"],
    [ELRYAN_CATEGORY_MAPPING_TAB, "elryanCategoryMappingTitle"],
    ["elryanAttributes", "elryanAttributesTitle"],
    ["elryanWarrantyMapping", "elryanWarrantyMappingTitle"],
    ["elryanDimensionsMapping", "elryanDimensionsMappingTitle"],
    ["syncOne", "elryanSyncOneTitle"],
    ["syncAll", "elryanSyncAllTitle"],
  ];
}

/** One Category Mapping entry. The generic Category Setup item is omitted for Elryan only. */
export function withElryanSharedSections(elryanSections, sharedSections) {
  const elryan = Array.isArray(elryanSections) ? elryanSections : [];
  const shared = (Array.isArray(sharedSections) ? sharedSections : []).filter(
    ([id]) => id !== "mapping"
  );
  return [...elryan, ...shared];
}

export function locName(name, lang = "en") {
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  const order = [lang, "en", "ku", "ar"];
  for (const key of order) {
    const value = name?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/**
 * Category → Subcategory → Collection from BrownStore fields.
 * Missing levels are skipped. Nothing is invented when a name is absent.
 */
export function brownStoreTaxonomyPath(row, lang = "en") {
  const parts = [
    locName(row?.brownCategoryName, lang),
    locName(row?.brownSubCategoryName, lang),
    locName(row?.brownCollectionName, lang),
  ].filter(Boolean);
  if (parts.length) return parts.join(" → ");
  return String(row?.taxonomyPath || "").trim();
}

export function reviewBrownStorePath(brownStore, lang = "en") {
  if (!brownStore) return "";
  const parts = [
    locName(brownStore.categoryName, lang),
    locName(brownStore.subCategoryName, lang),
    locName(brownStore.collectionName, lang),
  ].filter(Boolean);
  if (parts.length) return parts.join(" → ");
  return String(brownStore.taxonomyPath || "").trim();
}

export function unmappedCollectionCount(counts) {
  const total = Number(counts?.collections);
  const mapped = Number(counts?.mapped);
  if (!Number.isFinite(total) || !Number.isFinite(mapped)) return null;
  return Math.max(0, total - mapped);
}

export const EMPTY_ELRYAN_CARD_DRAFT = Object.freeze({
  pickedCategoryId: "",
  pickSource: "",
  pickedSnapshot: null,
  review: null,
  overwriteAck: false,
  message: "",
  error: "",
});

export function cardDraft(drafts, collectionId) {
  const current = drafts?.[collectionId];
  if (!current) return EMPTY_ELRYAN_CARD_DRAFT;
  return current;
}

/** Only one picker stays open. Opening the same card again collapses it. */
export function toggleElryanPicker(openId, collectionId) {
  const id = String(collectionId || "");
  if (!id) return "";
  return String(openId || "") === id ? "" : id;
}

export function manualSearchBelongsTo(manualFor, collectionId) {
  return Boolean(manualFor) && String(manualFor) === String(collectionId || "");
}

export function searchHitsForCollection({ manualFor, collectionId, categories } = {}) {
  if (!manualSearchBelongsTo(manualFor, collectionId)) return [];
  return Array.isArray(categories) ? categories : [];
}

/**
 * Fill the selected category on one collection card.
 * Does not save, and does not touch any other collection's draft.
 */
export function pickCategoryOnCard(drafts, collectionId, category, source) {
  const id = String(collectionId || "");
  const prev = { ...EMPTY_ELRYAN_CARD_DRAFT, ...cardDraft(drafts, id) };
  const next = pickElryanCategoryState(prev, {
    categoryId: category?.categoryId,
    source,
    snapshot: category,
  });
  if (!next.pickedCategoryId) {
    return {
      drafts: {
        ...(drafts || {}),
        [id]: { ...prev, error: "category_required" },
      },
      autoSave: false,
      saved: false,
      picked: false,
      collectionId: id,
    };
  }
  return {
    drafts: {
      ...(drafts || {}),
      [id]: {
        ...prev,
        ...next,
        message: next.changed ? "" : prev.message,
        error: "",
      },
    },
    autoSave: false,
    saved: false,
    picked: true,
    collectionId: id,
  };
}

/** Keep the success or read-back warning on this card. Other cards stay as they were. */
export function applySaveToCardDraft(drafts, collectionId, result = {}) {
  const id = String(collectionId || "");
  const confirmed = result.claimedSuccess === true;
  return {
    ...(drafts || {}),
    [id]: {
      pickedCategoryId: "",
      pickSource: "",
      pickedSnapshot: null,
      review: null,
      overwriteAck: false,
      message: confirmed ? String(result.message || "") : "",
      error: confirmed ? "" : String(result.warning || ""),
    },
  };
}
