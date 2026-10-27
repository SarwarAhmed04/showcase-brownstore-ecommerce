/** Safe list of warning strings for React children (never render raw objects). */
export function normalizeElryanCatalogWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((item) => {
      if (item == null) return "";
      if (typeof item === "string") return item;
      if (typeof item === "number" || typeof item === "boolean") return String(item);
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .map((text) => text.trim())
    .filter(Boolean);
}

/** Compact status line fields; avoids assuming large payload shapes. */
export function elryanCatalogStatusSummary(status) {
  if (!status || typeof status !== "object") {
    return { ready: false, line: "" };
  }
  const parts = [
    status.status != null ? String(status.status) : "",
    status.uniqueCount != null ? `${status.uniqueCount} IDs` : "",
    status.reportedTotal != null ? `API total ${status.reportedTotal}` : "",
    status.coverage ? `coverage ${status.coverage}` : "",
    status.pagesFetched ? `pages ${status.pagesFetched}` : "",
  ].filter(Boolean);
  return { ready: true, line: parts.join(" · ") };
}
