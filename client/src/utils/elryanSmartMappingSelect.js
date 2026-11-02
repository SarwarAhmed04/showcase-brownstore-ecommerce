/**
 * Pure helpers for Elryan Smart Mapping category pick / review enablement.
 * No persistence, no Elryan API calls.
 */

export function normalizeElryanCategoryPickId(categoryId) {
  if (categoryId == null) return "";
  return String(categoryId).trim();
}

export function isElryanCategoryPicked(pickedCategoryId, categoryId) {
  const picked = normalizeElryanCategoryPickId(pickedCategoryId);
  const candidate = normalizeElryanCategoryPickId(categoryId);
  return Boolean(picked) && picked === candidate;
}

export function canReviewElryanMapping(brownCollectionId, pickedCategoryId) {
  return Boolean(
    normalizeElryanCategoryPickId(brownCollectionId) &&
      normalizeElryanCategoryPickId(pickedCategoryId)
  );
}

/** Apply a manual/smart category pick without auto-saving. */
export function applyElryanCategoryPick(previousPickedId, categoryId) {
  const next = normalizeElryanCategoryPickId(categoryId);
  if (!next) {
    return {
      pickedCategoryId: normalizeElryanCategoryPickId(previousPickedId),
      changed: false,
      reviewCleared: false,
    };
  }
  const prev = normalizeElryanCategoryPickId(previousPickedId);
  return {
    pickedCategoryId: next,
    changed: prev !== next,
    reviewCleared: true,
  };
}

export const ELRYAN_COLLECTION_PAGE_SIZE = 40;
export const ELRYAN_MANUAL_PAGE_SIZE = 25;

/** Preview query. Offset is caller-controlled — never forced back to 0. */
export function elryanCollectionPreviewQuery({
  q = "",
  status = "",
  confidence = "",
  offset = 0,
  limit = ELRYAN_COLLECTION_PAGE_SIZE,
} = {}) {
  const params = {
    limit: Math.max(1, Number(limit) || ELRYAN_COLLECTION_PAGE_SIZE),
    offset: Math.max(0, Number(offset) || 0),
  };
  const needle = String(q || "").trim();
  if (needle) params.q = needle;
  if (status) params.status = status;
  if (confidence) params.confidence = confidence;
  return params;
}

export function elryanManualSearchQuery({
  q = "",
  offset = 0,
  leafOnly = false,
  limit = ELRYAN_MANUAL_PAGE_SIZE,
} = {}) {
  const params = {
    limit: Math.max(1, Number(limit) || ELRYAN_MANUAL_PAGE_SIZE),
    offset: Math.max(0, Number(offset) || 0),
  };
  const needle = String(q || "").trim();
  if (needle) params.q = needle;
  if (leafOnly) params.leafOnly = "1";
  return params;
}

export function nextManualSearchOffset({ offset = 0, limit = ELRYAN_MANUAL_PAGE_SIZE, totalMatching = 0, direction = "next" } = {}) {
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.max(1, Number(limit) || ELRYAN_MANUAL_PAGE_SIZE);
  const total = Math.max(0, Number(totalMatching) || 0);
  if (direction === "prev") {
    return { offset: Math.max(0, start - size), moved: start > 0 };
  }
  const next = start + size;
  return { offset: next, moved: next < total };
}

/**
 * Previous uses the offsets already loaded. Next uses the server cursor,
 * which may be larger than page size when a confidence scan skips non-matches.
 */
export function planCollectionPageChange({
  history,
  offset = 0,
  direction,
  nextOffset,
  hasMore = false,
} = {}) {
  const trail = (Array.isArray(history) ? history : [0])
    .map((value) => Math.max(0, Number(value) || 0));
  const known = trail.length ? trail : [0];
  const current = Math.max(0, Number(offset) || 0);
  const withCurrent = known.includes(current) ? known : [...known, current];
  if (direction === "prev") {
    const idx = withCurrent.lastIndexOf(current);
    if (idx <= 0) return { offset: withCurrent[0] ?? 0, history: withCurrent, moved: false };
    return { offset: withCurrent[idx - 1], history: withCurrent, moved: true };
  }
  if (direction === "next") {
    const cursor = Number(nextOffset);
    if (!hasMore || !Number.isFinite(cursor) || cursor <= current) {
      return { offset: current, history: withCurrent, moved: false };
    }
    const idx = withCurrent.lastIndexOf(current);
    const nextHistory = idx === withCurrent.length - 1 ? [...withCurrent, cursor] : withCurrent;
    return { offset: cursor, history: nextHistory, moved: true };
  }
  return { offset: current, history: withCurrent, moved: false };
}

export function resetCollectionPaging() {
  return { offset: 0, history: [0] };
}

export function nextUnmappedCollectionId(rows, selectedId) {
  const list = Array.isArray(rows) ? rows : [];
  const idx = list.findIndex((row) => String(row?.brownCollectionId) === String(selectedId || ""));
  const start = idx >= 0 ? idx + 1 : 0;
  for (let i = start; i < list.length; i += 1) {
    if (!list[i]?.existingMapping?.configured) return String(list[i].brownCollectionId);
  }
  return "";
}

export function pickNextUnmapped({ rows, selectedId, hasMore = false } = {}) {
  const id = nextUnmappedCollectionId(rows, selectedId);
  if (id) return { action: "select", brownCollectionId: id, needsPage: false };
  if (hasMore) return { action: "load-next", needsPage: true, brownCollectionId: "" };
  return { action: "none", needsPage: false, brownCollectionId: "" };
}

/** Changing the BrownStore collection drops the category pick and any stale review. */
export function selectElryanCollection({ brownCollectionId, keepMessage = false, message = "" } = {}) {
  return {
    selectedId: String(brownCollectionId || ""),
    pickedCategoryId: "",
    pickSource: "",
    pickedSnapshot: null,
    review: null,
    overwriteAck: false,
    message: keepMessage ? String(message || "") : "",
    reviewCleared: true,
    autoSave: false,
  };
}

/** Pick a suggested or searched category. Never persists. Clears a previous review. */
export function pickElryanCategoryState(previous, { categoryId, source = "smart", snapshot = null } = {}) {
  const pick = applyElryanCategoryPick(previous?.pickedCategoryId, categoryId);
  if (!pick.pickedCategoryId) {
    return {
      ...(previous || {}),
      changed: false,
      review: previous?.review || null,
      autoSave: false,
    };
  }
  const pickedSnapshot = snapshot
    ? {
        categoryId: pick.pickedCategoryId,
        categoryName: snapshot.categoryName || "",
        hierarchy: snapshot.hierarchy || "",
        attributeSetId: snapshot.attributeSetId ?? null,
        isParent: snapshot.isParent ?? null,
        kind: snapshot.kind || null,
        confidence: snapshot.confidence || null,
        score: snapshot.score ?? null,
        reasons: Array.isArray(snapshot.reasons) ? snapshot.reasons : [],
        missing: Array.isArray(snapshot.missing) ? snapshot.missing : [],
        productEvidence: Array.isArray(snapshot.productEvidence) ? snapshot.productEvidence : [],
      }
    : previous?.pickedSnapshot || null;
  return {
    ...(previous || {}),
    pickedCategoryId: pick.pickedCategoryId,
    pickSource: source === "manual" ? "manual" : "smart",
    pickedSnapshot,
    review: null,
    overwriteAck: false,
    changed: pick.changed,
    reviewCleared: true,
    autoSave: false,
  };
}

export function resolveDisplayedElryanCategory({
  pickedCategoryId,
  snapshot = null,
  candidates = [],
  manualCategories = [],
} = {}) {
  const id = normalizeElryanCategoryPickId(pickedCategoryId);
  if (!id) return null;
  const fromSuggestion = (candidates || []).find((row) => isElryanCategoryPicked(id, row?.categoryId)) || null;
  const fromManual = (manualCategories || []).find((row) => isElryanCategoryPicked(id, row?.categoryId)) || null;
  const base = fromSuggestion || fromManual;
  return {
    categoryId: id,
    categoryName: base?.categoryName || snapshot?.categoryName || "",
    hierarchy: base?.hierarchy || snapshot?.hierarchy || "",
    attributeSetId: base?.attributeSetId ?? snapshot?.attributeSetId ?? null,
    isParent: base?.isParent ?? snapshot?.isParent ?? null,
    kind: base?.kind || snapshot?.kind || null,
    confidence: fromSuggestion?.confidence || (!fromManual ? snapshot?.confidence || null : null),
    source: fromSuggestion ? "smart" : fromManual ? "manual" : "selected",
    onManualPage: Boolean(fromManual),
  };
}

/** Manual-result paging does not change the category that was already picked. */
export function elryanManualPageKeepsSelection(pickedCategoryId) {
  return {
    pickedCategoryId: normalizeElryanCategoryPickId(pickedCategoryId),
    retained: Boolean(normalizeElryanCategoryPickId(pickedCategoryId)),
  };
}

/**
 * Explicit save body. Overwrite is sent only after the operator confirms a real change.
 * This helper is the confirm step — picking a category does not call it.
 */
export function buildElryanMappingSaveBody({
  brownCollectionId,
  categoryId,
  review,
  overwriteAck = false,
  source = "smart",
} = {}) {
  if (!review) return { allowed: false, reason: "review_required" };
  if (review.canSave !== true) return { allowed: false, reason: "blocked" };
  if (review.requiresOverwriteConfirmation && overwriteAck !== true) {
    return { allowed: false, reason: "overwrite_required" };
  }
  const body = {
    brownCollectionId: String(brownCollectionId || ""),
    categoryId: normalizeElryanCategoryPickId(categoryId),
    confirm: true,
    source: source === "manual" ? "manual" : "smart",
  };
  if (review.requiresOverwriteConfirmation) body.overwrite = true;
  return { allowed: true, reason: "", body };
}

/**
 * After a confirmed save, keep the same collection and the success text.
 * A failed read-back is a warning, not a confirmed success, and does not rewrite the row.
 */
export function applyElryanMappingSaveResult({
  rows,
  selectedId,
  saveResult,
  successMessage = "",
} = {}) {
  const confirmed = saveResult?.readBackConfirmed === true;
  const id = String(saveResult?.brownCollectionId || selectedId || "");
  let mappedDelta = 0;
  const nextRows = (Array.isArray(rows) ? rows : []).map((row) => {
    if (String(row?.brownCollectionId) !== id) return row;
    if (!confirmed) return { ...row, saveReadBackFailed: true };
    const wasConfigured = Boolean(row.existingMapping?.configured);
    const values = saveResult.values || {};
    const nowConfigured = Boolean(saveResult.configured && values.categoryId);
    if (!wasConfigured && nowConfigured) mappedDelta += 1;
    return {
      ...row,
      saveReadBackFailed: false,
      existingMapping: {
        configured: nowConfigured,
        status: nowConfigured ? "mapped" : "unmapped",
        values,
        elryanEnvironment: saveResult.environment || row.existingMapping?.elryanEnvironment || "staging",
      },
    };
  });
  const firstId = nextRows[0]?.brownCollectionId ? String(nextRows[0].brownCollectionId) : "";
  return {
    rows: nextRows,
    selectedId: id || String(selectedId || ""),
    jumpedToFirst: false,
    stayedOnSavedCollection: Boolean(id) && id !== "" && (id === String(selectedId || "") || id !== firstId || nextRows.length <= 1),
    pickedCategoryId: "",
    review: null,
    overwriteAck: false,
    message: confirmed ? String(successMessage || "") : "",
    claimedSuccess: confirmed,
    readBackConfirmed: confirmed,
    mappedDelta,
    preserveFilters: true,
    fullRefresh: false,
  };
}
