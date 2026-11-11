export function canSendGiniVariantSync() {
  return false;
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
