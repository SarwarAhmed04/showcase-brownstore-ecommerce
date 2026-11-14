import { Category } from "../models/Category.js";
import { applyCategoryAbsence } from "./categoryStaleGuard.js";

/**
 * Refresh source category fields from a completed IBSHER category list.
 * Local overrides, MongoDB ids, display order, and omitted category documents stay.
 * Subcategories and collections are product fields and are not written here.
 */
export async function syncRemoteCategories(categories, {
  categoriesModel = Category,
  applyAbsence = applyCategoryAbsence,
  syncedAt = new Date(),
} = {}) {
  const existing = await categoriesModel.find().select("ibsherId displayOrder");
  const known = new Set(existing.map((doc) => doc.ibsherId));
  let nextOrder = existing.reduce((max, doc) => Math.max(max, Number(doc.displayOrder) || 0), 0);
  const seen = new Set();
  for (const cat of categories || []) {
    const id = String(cat?._id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (cat.isActive === false) continue;
    const update = {
      $set: {
        ibsherId: id,
        name: cat.name,
        images: cat.images || [],
        isActive: cat.isActive !== false,
      },
    };
    if (!known.has(id)) {
      nextOrder += 1;
      update.$setOnInsert = { displayOrder: nextOrder };
    }
    await categoriesModel.updateOne({ ibsherId: id }, update, { upsert: true });
  }

  if (!seen.size) {
    throw new Error("Category sync returned no categories");
  }

  const absence = await applyAbsence({
    seenIds: [...seen],
    remoteTotal: seen.size,
    syncedAt,
    categories: categoriesModel,
  });
  return {
    categories: seen.size,
    removed: absence.removed,
    quarantined: absence.quarantined,
    awaitingApproval: absence.awaitingApproval,
    referenced: absence.referenced,
    absenceMode: absence.mode,
  };
}
