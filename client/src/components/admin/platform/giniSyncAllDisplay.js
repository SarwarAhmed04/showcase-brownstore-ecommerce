const ACTIVE_STATUSES = ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"];

export function approvedPreview(status) {
  const preview = status?.preview?.status === "preview" && status.preview.finishedAt ? status.preview : null;
  if (preview) return preview;
  const job = status?.job;
  if (job?.mode === "preview" && job.status === "preview" && job.finishedAt) return job;
  return null;
}

export function selectGiniSyncDisplay(status) {
  const job = status?.job || null;
  const preview = approvedPreview(status);
  const active = Boolean(job && ACTIVE_STATUSES.includes(job.status));
  const current = job?.mode === "sync" ? job : active ? job : preview || job;
  return { job, preview, active, current };
}

export function sendCounter(job, field) {
  if (!job || job.mode !== "sync") return 0;
  const value = Number(job?.[field]);
  return Number.isFinite(value) ? value : 0;
}

export function confirmedCreateCount(job) {
  return sendCounter(job, "created");
}

export function reconciliationWarnings(status, current) {
  const rows = [...(status?.reconciliation || []), ...(current?.reconciliation || [])];
  const seen = new Set();
  const warnings = [];
  for (const row of rows) {
    if (!row?.code) continue;
    const key = `${row.code}|${row.sku || ""}|${row.giniProductId || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    warnings.push(row);
  }
  return warnings;
}
