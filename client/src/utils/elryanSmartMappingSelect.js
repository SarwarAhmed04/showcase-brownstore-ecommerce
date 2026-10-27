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
