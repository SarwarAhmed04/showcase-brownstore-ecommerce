function idOf(doc) {
  return String(doc?._id || "");
}

function sourceOf(doc) {
  return String(doc?.ibsherId || doc?.sourceItemId || "").trim();
}

function stamp(doc) {
  const value = doc?.sourceUpdatedAt || doc?.updatedAt || null;
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

/**
 * Classifies backup documents against the current catalog.
 * This function does not write and does not choose a price to overwrite.
 */
export function planSelectiveRecovery({ backupProducts = [], currentProducts = [] } = {}) {
  const currentBySource = new Map();
  const duplicateSourceIds = [];
  for (const doc of currentProducts) {
    const source = sourceOf(doc);
    if (!source) continue;
    if (currentBySource.has(source)) duplicateSourceIds.push(source);
    else currentBySource.set(source, []);
    currentBySource.get(source).push(doc);
  }

  const actions = [];
  for (const backup of backupProducts) {
    const source = sourceOf(backup);
    const backupId = idOf(backup);
    const matches = source ? currentBySource.get(source) || [] : [];
    if (!source || !backupId) {
      actions.push({ action: "skip_invalid", sourceItemId: source, backupId });
      continue;
    }
    if (!matches.length) {
      actions.push({
        action: "restore_original",
        sourceItemId: source,
        backupId,
        preserveOverrides: Boolean(backup.overrides),
        note: "Insert the backup document with its original _id. Leave price and stock for a later approved sync to refresh.",
      });
      continue;
    }
    const same = matches.find((doc) => idOf(doc) === backupId);
    if (matches.length === 1 && same) {
      actions.push({ action: "already_present", sourceItemId: source, backupId, currentId: backupId });
      continue;
    }
    const newer = [...matches].sort((left, right) => stamp(right) - stamp(left))[0];
    actions.push({
      action: "reinserted_conflict",
      sourceItemId: source,
      backupId,
      currentIds: matches.map(idOf),
      newerCurrentId: idOf(newer),
      backupSourceUpdatedAt: backup.sourceUpdatedAt || backup.updatedAt || null,
      currentSourceUpdatedAt: newer.sourceUpdatedAt || newer.updatedAt || null,
      note: "Do not insert another document. Keep the current document's price and stock. Marketplace rows that still point at the original _id need a separate review.",
    });
  }

  return {
    writes: false,
    actions,
    restoreCount: actions.filter((row) => row.action === "restore_original").length,
    conflictCount: actions.filter((row) => row.action === "reinserted_conflict").length,
    duplicateSourceIds: [...new Set(duplicateSourceIds)],
  };
}

/** Read-only check that each original _id and source id is present exactly once. */
export function verifySelectiveRecovery({ expected = [], currentProducts = [] } = {}) {
  const byId = new Map(currentProducts.map((doc) => [idOf(doc), doc]));
  const bySource = new Map();
  for (const doc of currentProducts) {
    const source = sourceOf(doc);
    if (!source) continue;
    bySource.set(source, [...(bySource.get(source) || []), doc]);
  }
  const rows = expected.map((item) => {
    const backupId = idOf(item);
    const source = sourceOf(item);
    const same = byId.get(backupId);
    const matches = bySource.get(source) || [];
    if (matches.length > 1) return { backupId, sourceItemId: source, ok: false, reason: "duplicate_source" };
    if (matches.length === 1 && idOf(matches[0]) !== backupId) {
      return { backupId, sourceItemId: source, ok: false, reason: "conflicting_id", currentId: idOf(matches[0]) };
    }
    if (!same || sourceOf(same) !== source) return { backupId, sourceItemId: source, ok: false, reason: "missing" };
    return { backupId, sourceItemId: source, ok: true, reason: "verified" };
  });
  return {
    writes: false,
    verified: rows.filter((row) => row.ok).length,
    failed: rows.filter((row) => !row.ok),
  };
}
