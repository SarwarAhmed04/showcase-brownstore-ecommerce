export function canSendGiniVariantSync() {
  return false;
}

export function canSendVariantChangedSync() {
  return false;
}

export function pilotStageAllowed({ writesEnabled = false, queue = "", ready = false, confirmed = false, busy = false } = {}) {
  return writesEnabled === true && queue === "next" && ready === true && confirmed === true && busy !== true;
}

export function variantSyncStatusLabel(status) {
  return {
    READY_FOR_REVIEW: "Ready for review",
    APPROVED_FOR_FUTURE_SYNC: "Approved for a future sync",
    BLOCKED: "Blocked",
    NEEDS_REVIEW: "Needs review",
    VERIFIED_REMOTE: "Verified on GINI",
    UNCERTAIN: "Uncertain",
  }[status] || status || "";
}
