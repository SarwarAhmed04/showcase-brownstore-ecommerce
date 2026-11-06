export function selectEligibleResyncSkus(preview) {
  const rows = Array.isArray(preview?.missingEligible) ? preview.missingEligible : [];
  return rows
    .filter(
      (row) =>
        row &&
        row.eligible === true &&
        row.classification === "VERIFIED_MISSING" &&
        row.historical !== true &&
        row.code !== "historical_sku_hold" &&
        row.remoteState === "verified_missing" &&
        String(row.sku || "").trim()
    )
    .map((row) => String(row.sku).trim());
}

export function resyncRemoteLabelKey(row) {
  if (row?.identityMatched) return "giniResyncRemoteExisting";
  if (row?.remoteState === "verified_missing") return "giniResyncRemoteMissing";
  if (row?.remoteState === "existing") return "giniResyncRemoteDifferent";
  if (row?.remoteState === "conflict") return "giniResyncRemoteConflict";
  return "giniResyncRemoteUncertain";
}
