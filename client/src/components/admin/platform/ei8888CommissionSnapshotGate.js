function hasSnapshotQuote(snapshot) {
  return snapshot != null
    && snapshot.percentage != null
    && snapshot.basePrice != null
    && snapshot.giniPrice != null
    && String(snapshot.scope || "") !== "";
}

export function ei8888CommissionSnapshotCanSave(preview, { confirmed = false, busy = false } = {}) {
  const refresh = preview?.commissionRefresh;
  const blockers = refresh?.blockers;
  const ready = refresh?.ok === true
    && refresh.applied === false
    && refresh.confirmRequired === true
    && refresh.writesEnabled === false
    && refresh.canSend === false
    && refresh.liveSend === false
    && refresh.sent === false
    && Array.isArray(blockers)
    && blockers.length === 0
    && hasSnapshotQuote(refresh.snapshot)
    && preview?.baseline?.ok === true
    && preview?.ownership?.ok === true
    && preview?.approval?.ok === true
    && preview?.hostMatches === true;
  return ready && confirmed === true && busy !== true;
}

export function ei8888CommissionSnapshotStatus(result) {
  if (!result || typeof result !== "object") return "";
  const blockers = Array.isArray(result.blockers) && result.blockers.length
    ? result.blockers.join(", ")
    : "";
  const outcome = result.applied === true ? "saved" : "not saved";
  const reason = result.applied === true ? "" : ` (${blockers || result.code || "unread"})`;
  const applied = result.applied === true ? "yes" : "no";
  const sent = result.sent === true ? "yes" : "no";
  const writeGate = result.writesEnabled === true ? "on" : "off";
  return `Commission snapshot ${outcome}${reason}. Applied: ${applied}. GINI send: ${sent}. Write gate: ${writeGate}.`;
}
