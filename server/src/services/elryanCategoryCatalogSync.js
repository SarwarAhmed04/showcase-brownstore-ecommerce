import {
  ELRYAN_CATALOG_SYNC,
  ELRYAN_PATHS,
  elryanEnvironmentConfig,
} from "../utils/elryanConstants.js";
import {
  categoryFingerprint,
  extractElryanListMeta,
  normalizeCategoryRecord,
} from "../utils/elryanPagination.js";
import { ElryanCategoryCatalogSnapshot } from "../models/ElryanCategoryCatalogSnapshot.js";
import { ElryanClientError, elryanRequest } from "./elryanClient.js";
import { resolveElryanConfig } from "./elryanConnection.js";

const jobs = new Map();

function asListFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.categories)) return payload.data.categories;
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue, fallbackMs) {
  if (headerValue == null || headerValue === "") return fallbackMs;
  const asNum = Number(headerValue);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(ELRYAN_CATALOG_SYNC.MAX_429_WAIT_MS, asNum * 1000);
  }
  const when = Date.parse(String(headerValue));
  if (Number.isFinite(when)) {
    return Math.min(ELRYAN_CATALOG_SYNC.MAX_429_WAIT_MS, Math.max(0, when - Date.now()));
  }
  return fallbackMs;
}

function publicSnapshot(doc, job = null) {
  const warnings = [...(doc?.warnings || [])];
  if (job?.warning) warnings.push(job.warning);
  return {
    environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
    status: job?.status || doc?.status || "idle",
    uniqueCount: doc?.uniqueCount || 0,
    reportedTotal: doc?.reportedTotal ?? null,
    pagesFetched: job?.pagesFetched ?? doc?.pagesFetched ?? 0,
    lastPage: job?.lastPage ?? doc?.lastPage ?? null,
    coverage: doc?.coverage || "unknown",
    warnings,
    error: job?.error || doc?.error || "",
    startedAt: job?.startedAt || doc?.startedAt || null,
    finishedAt: doc?.finishedAt || null,
    cancelRequested: Boolean(job?.cancelRequested || doc?.cancelRequested),
    // Prefer uniqueCount when categories[] was excluded from the query (status endpoint).
    categoryCount: Array.isArray(doc?.categories)
      ? doc.categories.length
      : Number(doc?.uniqueCount) || 0,
    running: Boolean(job && job.status === "running"),
    scope: {
      environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
      baseUrl: elryanEnvironmentConfig(ELRYAN_CATALOG_SYNC.ENVIRONMENT).baseUrl,
      pageLimit: ELRYAN_CATALOG_SYNC.PAGE_LIMIT,
      maxPages: ELRYAN_CATALOG_SYNC.MAX_PAGES,
      maxRecords: ELRYAN_CATALOG_SYNC.MAX_RECORDS,
      concurrency: ELRYAN_CATALOG_SYNC.CONCURRENCY,
      note: "Staging-only full category catalog read. Does not save mappings or write products.",
    },
  };
}

/** Status/progress only — never load the full categories[] array (can be 1k+ rows). */
export async function getElryanCategoryCatalogStatus() {
  const doc = await ElryanCategoryCatalogSnapshot.findOne({
    environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
  })
    .select(
      "environment status uniqueCount reportedTotal pagesFetched lastPage coverage warnings error startedAt finishedAt cancelRequested"
    )
    .lean();
  const job = jobs.get(ELRYAN_CATALOG_SYNC.ENVIRONMENT);
  return publicSnapshot(doc, job);
}

export async function getElryanCategoryCatalog({ q = "", limit = 100, offset = 0 } = {}) {
  const doc = await ElryanCategoryCatalogSnapshot.findOne({
    environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
  }).lean();
  const status = publicSnapshot(doc, jobs.get(ELRYAN_CATALOG_SYNC.ENVIRONMENT));
  let categories = Array.isArray(doc?.categories) ? doc.categories : [];
  const needle = String(q || "").trim().toLowerCase();
  if (needle) {
    categories = categories.filter((row) => {
      const hay = `${row.name || ""} ${row.hierarchy || ""} ${row.id ?? ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }
  const start = Math.max(0, Number(offset) || 0);
  const take = Math.min(500, Math.max(1, Number(limit) || 100));
  return {
    ...status,
    totalMatching: categories.length,
    categories: categories.slice(start, start + take),
    offset: start,
    limit: take,
  };
}

export async function cancelElryanCategoryCatalogSync() {
  const job = jobs.get(ELRYAN_CATALOG_SYNC.ENVIRONMENT);
  if (job && job.status === "running") {
    job.cancelRequested = true;
  }
  await ElryanCategoryCatalogSnapshot.findOneAndUpdate(
    { environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT },
    { $set: { cancelRequested: true } },
    { upsert: true }
  );
  return getElryanCategoryCatalogStatus();
}

async function readCategoriesPage(config, page, limit) {
  let attempt = 0;
  while (attempt <= ELRYAN_CATALOG_SYNC.MAX_429_RETRIES) {
    const result = await elryanRequest({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      path: ELRYAN_PATHS.categories,
      method: "GET",
      query: { page, limit },
      classification: "READ",
      retries: 1,
    });
    if (result.ok) return result;
    if (result.httpStatus === 429 && attempt < ELRYAN_CATALOG_SYNC.MAX_429_RETRIES) {
      const wait = parseRetryAfterMs(result.retryAfter, ELRYAN_CATALOG_SYNC.DEFAULT_429_WAIT_MS);
      await sleep(wait);
      attempt += 1;
      continue;
    }
    return result;
  }
  return null;
}

async function runCatalogSync(job) {
  const warnings = [];
  const byId = new Map();
  const seenFingerprints = new Set();
  let pagesFetched = 0;
  let reportedTotal = null;
  let coverage = "unknown";
  let lastPage = null;
  let error = "";

  try {
    const config = await resolveElryanConfig({ environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT });
    if (config.environment !== ELRYAN_CATALOG_SYNC.ENVIRONMENT) {
      throw new ElryanClientError("Category catalog sync is staging-only for this phase", {
        status: 403,
        code: "staging_only",
      });
    }
    if (!config.storedHasApiKey && !config.temporaryKey) {
      throw new ElryanClientError("Awaiting Elryan API Access", {
        status: 409,
        code: "api_access_pending",
      });
    }
    // Prefer stored staging key; temporary keys are not used for bulk sync.
    if (!config.storedHasApiKey) {
      throw new ElryanClientError("Save a staging API key before full catalog sync", {
        status: 409,
        code: "api_access_pending",
      });
    }

    const limit = ELRYAN_CATALOG_SYNC.PAGE_LIMIT;
    // OpenAPI default page=1; docs also say page may be 0-based. Start at 1 (default).
    let page = 1;
    let expectedPages = null;

    while (pagesFetched < ELRYAN_CATALOG_SYNC.MAX_PAGES) {
      if (job.cancelRequested) {
        coverage = "partial";
        error = "Cancelled by admin";
        job.status = "cancelled";
        break;
      }

      const result = await readCategoriesPage(config, page, limit);
      if (!result?.ok) {
        throw new ElryanClientError(
          result?.text || `Elryan categories page failed (${result?.httpStatus || 0})`,
          {
            status: result?.httpStatus || 502,
            code: "elryan_read_failed",
            httpStatus: result?.httpStatus || 0,
          }
        );
      }

      const rows = asListFromPayload(result.json).map(normalizeCategoryRecord).filter(Boolean);
      const meta = extractElryanListMeta(result.json);
      pagesFetched += 1;
      lastPage = page;
      job.pagesFetched = pagesFetched;
      job.lastPage = page;

      if (!meta.reliable) {
        warnings.push(
          `Page ${page}: pagination meta incomplete or absent (${meta.reason}). Stopping to avoid claiming full coverage.`
        );
        coverage = "unreliable_meta";
        // Keep any rows already collected on this page, then stop.
        for (const row of rows) {
          byId.set(String(row.id), row);
        }
        job.status = "incomplete";
        break;
      }

      if (reportedTotal == null) reportedTotal = meta.total;
      else if (reportedTotal !== meta.total) {
        warnings.push(
          `Page ${page}: meta.total changed from ${reportedTotal} to ${meta.total}. Stopping.`
        );
        coverage = "unreliable_meta";
        job.status = "incomplete";
        break;
      }

      expectedPages = Math.max(1, Math.ceil(meta.total / limit));
      const fingerprint = categoryFingerprint(rows);
      if (fingerprint && seenFingerprints.has(fingerprint)) {
        warnings.push(`Page ${page}: repeated page content detected. Stopping.`);
        coverage = "partial";
        job.status = "incomplete";
        break;
      }
      if (fingerprint) seenFingerprints.add(fingerprint);

      let newOnPage = 0;
      for (const row of rows) {
        const key = String(row.id);
        if (!byId.has(key)) {
          byId.set(key, row);
          newOnPage += 1;
        }
      }
      if (rows.length > 0 && newOnPage === 0) {
        warnings.push(`Page ${page}: all category IDs already seen. Stopping.`);
        coverage = byId.size >= meta.total ? "complete" : "partial";
        job.status = byId.size >= meta.total ? "complete" : "incomplete";
        break;
      }

      if (byId.size >= ELRYAN_CATALOG_SYNC.MAX_RECORDS) {
        warnings.push(`Reached MAX_RECORDS (${ELRYAN_CATALOG_SYNC.MAX_RECORDS}). Stopping.`);
        coverage = "partial";
        job.status = "incomplete";
        break;
      }

      if (rows.length === 0) {
        coverage = byId.size >= meta.total ? "complete" : "partial";
        job.status = coverage === "complete" ? "complete" : "incomplete";
        if (coverage !== "complete") {
          warnings.push(`Empty page ${page} before reaching meta.total=${meta.total}.`);
        }
        break;
      }

      // Advance page. Prefer sequential page+=1 from starting page 1.
      if (expectedPages != null && pagesFetched >= expectedPages) {
        coverage = byId.size >= meta.total ? "complete" : "partial";
        if (coverage !== "complete") {
          warnings.push(
            `Fetched ${pagesFetched} page(s) for meta.total=${meta.total} but unique IDs=${byId.size}.`
          );
        }
        job.status = coverage === "complete" ? "complete" : "incomplete";
        break;
      }

      page += 1;
    }

    if (pagesFetched >= ELRYAN_CATALOG_SYNC.MAX_PAGES && job.status === "running") {
      warnings.push(`Reached MAX_PAGES (${ELRYAN_CATALOG_SYNC.MAX_PAGES}). Stopping.`);
      coverage = "partial";
      job.status = "incomplete";
    }

    if (job.status === "running") {
      coverage =
        reportedTotal != null && byId.size >= reportedTotal ? "complete" : coverage || "partial";
      job.status = coverage === "complete" ? "complete" : "incomplete";
      if (job.status === "incomplete" && !warnings.length) {
        warnings.push("Catalog sync finished without confirming full coverage.");
      }
    }

    const categories = [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
    await ElryanCategoryCatalogSnapshot.findOneAndUpdate(
      { environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT },
      {
        $set: {
          environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT,
          status: job.status,
          categories,
          uniqueCount: categories.length,
          reportedTotal,
          pagesFetched,
          lastPage,
          warnings,
          error: error || (job.status === "cancelled" ? "Cancelled by admin" : ""),
          coverage,
          startedAt: job.startedAt,
          finishedAt: new Date(),
          cancelRequested: false,
        },
      },
      { upsert: true }
    );
  } catch (err) {
    job.status = "failed";
    job.error = err?.message || "Catalog sync failed";
    await ElryanCategoryCatalogSnapshot.findOneAndUpdate(
      { environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT },
      {
        $set: {
          status: "failed",
          error: job.error,
          warnings,
          finishedAt: new Date(),
          cancelRequested: false,
          pagesFetched,
          lastPage,
          uniqueCount: byId.size,
          reportedTotal,
          coverage: "partial",
          categories: [...byId.values()],
        },
      },
      { upsert: true }
    );
  } finally {
    job.finishedAt = new Date();
  }
}

/**
 * Explicit admin-triggered staging catalog sync. Requires confirm: true.
 * Does not save taxonomy mappings or write products.
 */
export async function startElryanCategoryCatalogSync({ confirm } = {}) {
  if (confirm !== true) {
    throw new ElryanClientError(
      "Full catalog sync requires explicit confirm:true. Review scope first.",
      { status: 400, code: "confirm_required" }
    );
  }
  const existing = jobs.get(ELRYAN_CATALOG_SYNC.ENVIRONMENT);
  if (existing?.status === "running") {
    throw new ElryanClientError("A category catalog sync is already running", {
      status: 409,
      code: "sync_in_progress",
    });
  }

  const startedAt = new Date();
  const job = {
    status: "running",
    cancelRequested: false,
    pagesFetched: 0,
    lastPage: null,
    startedAt,
    error: "",
  };
  jobs.set(ELRYAN_CATALOG_SYNC.ENVIRONMENT, job);

  await ElryanCategoryCatalogSnapshot.findOneAndUpdate(
    { environment: ELRYAN_CATALOG_SYNC.ENVIRONMENT },
    {
      $set: {
        status: "running",
        startedAt,
        finishedAt: null,
        error: "",
        warnings: [],
        cancelRequested: false,
        pagesFetched: 0,
        coverage: "unknown",
      },
    },
    { upsert: true }
  );

  // Fire-and-forget; status polled via GET.
  void runCatalogSync(job);

  return getElryanCategoryCatalogStatus();
}

export function __resetElryanCatalogJobsForTests() {
  jobs.clear();
}
