#!/usr/bin/env node
/**
 * Read-only GINI production audit.
 *
 * Run this only from an authorized Hostinger SSH session, in the deployed
 * BrownStore server directory. It does not start the backend, refresh IBSHER,
 * or write to MongoDB or GINI.
 *
 *   node src/scripts/giniProductionReadOnlyAudit.js --confirm-production
 *
 * Copy the JSON from the terminal. Do not send the shell environment, .env,
 * or any connection string.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { GINI_REFERENCE_SKUS } from "../utils/giniHistoricalHold.js";
import { summarizeGiniMappingCoverage } from "../utils/giniCategoryTree.js";

const CONFIRM_FLAG = "--confirm-production";
const QUERY_MS = 120000;
const EARLIER_CLIENT_MASK = "1423...2bee";
const EARLIER_GINI_HOST = "merchant.gini.iq";
const REPORTED_PREVIEW = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

/** SKUs recorded by the local audit. This list is a lookup key, not production data. */
export const LOCAL_REFERENCE_SKUS = GINI_REFERENCE_SKUS;

export const LOCAL_HISTORICAL_SKUS = Object.freeze(["LP-ID141232", "E6310221"]);

const WRITE_GATES = Object.freeze([
  "GINI_BULK_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_BULK_WRITES",
  "GINI_UPDATE_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_UPDATE_WRITES",
  "GINI_IMAGE_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_IMAGE_WRITES",
  "GINI_RESYNC_WRITES_ENABLED",
  "GINI_ALLOW_LIVE_RESYNC_WRITES",
]);

const GINI_COLLECTIONS = Object.freeze([
  "ginisyncsendstates",
  "ginisyncproductresults",
  "ginisyncjobs",
  "ginisynconeaudits",
  "ginisynconepreviews",
  "giniresyncpreviews",
  "giniresyncaudits",
  "giniresyncjobs",
  "giniresynclocks",
  "giniconnections",
  "ginichangedpreviewsnapshots",
  "giniproductupdatejobs",
  "giniproductupdateaudits",
]);

export function giniSkuKey(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase();
}

export function maskClientId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length < 8) return "set";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|secret|token|jwt|apikey|api_key|clientsecret)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, "[redacted-jwt]");
}

export function describeMongoTarget(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return { available: false };
  const protocol = raw.startsWith("mongodb+srv://") ? "mongodb+srv" : raw.startsWith("mongodb://") ? "mongodb" : "";
  if (!protocol) return { available: false, reason: "unrecognized database protocol" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { available: false, reason: "database target could not be parsed" };
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || "");
  const host = parsed.host;
  return {
    available: true,
    protocol,
    host,
    database: database || null,
    loopback: host === "127.0.0.1" || host.startsWith("127.0.0.1:") || host === "localhost" || host.startsWith("localhost:"),
  };
}

export function writeGateSnapshot(env = process.env) {
  const gates = {};
  for (const name of WRITE_GATES) gates[name] = env[name] === "true";
  return {
    anyEnabled: WRITE_GATES.some((name) => gates[name]),
    gates,
  };
}

export function overlapConfirmedWithReady(sends, ready) {
  let byNormalizedSku = 0;
  let byProductId = 0;
  let skuMatchWithoutProductMatch = 0;
  let productMatchWithoutSkuMatch = 0;
  const examples = [];
  for (const send of sends || []) {
    const key = send.skuKey || giniSkuKey(send.sku);
    const skuHit = Boolean(key && ready?.bySku?.has(key));
    const productHit = Boolean(send.productId && ready?.byProduct?.has(String(send.productId)));
    if (skuHit) byNormalizedSku += 1;
    if (productHit) byProductId += 1;
    if (skuHit && !productHit) skuMatchWithoutProductMatch += 1;
    if (productHit && !skuHit) productMatchWithoutSkuMatch += 1;
    if ((skuHit || productHit) && examples.length < 20) {
      examples.push({ sku: String(send.sku || key || ""), skuHit, productHit });
    }
  }
  return {
    available: ready?.available === true,
    readyRowCount: ready?.available ? ready.count : null,
    confirmedSendCount: (sends || []).length,
    overlapByNormalizedSku: ready?.available ? byNormalizedSku : null,
    overlapByProductId: ready?.available ? byProductId : null,
    skuMatchWithoutProductMatch: ready?.available ? skuMatchWithoutProductMatch : null,
    productMatchWithoutSkuMatch: ready?.available ? productMatchWithoutSkuMatch : null,
    examples: ready?.available ? examples : [],
  };
}

export function referencePresence(skus, sendKeys, createdKeys, readyKeys) {
  const missingFromSendState = [];
  const presentInReady = [];
  let presentInSendState = 0;
  let presentInCreated = 0;
  for (const sku of skus) {
    const key = giniSkuKey(sku);
    const inSend = sendKeys ? sendKeys.has(key) : false;
    const inCreated = createdKeys ? createdKeys.has(key) : false;
    const inReady = readyKeys ? readyKeys.has(key) : false;
    if (sendKeys && inSend) presentInSendState += 1;
    if (sendKeys && !inSend) missingFromSendState.push(sku);
    if (createdKeys && inCreated) presentInCreated += 1;
    if (readyKeys && inReady) presentInReady.push(sku);
  }
  return {
    expected: skus.length,
    presentInSendState: sendKeys ? presentInSendState : null,
    presentInCreated: createdKeys ? presentInCreated : null,
    presentInReady: readyKeys ? presentInReady.length : null,
    missingFromSendState: sendKeys ? missingFromSendState : null,
    readySkus: readyKeys ? presentInReady : null,
  };
}

function scriptIsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(fileURLToPath(import.meta.url));
  const right = path.resolve(entry);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findServerRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "brownstore-server") return { dir, pkg };
      } catch {
        // Keep walking. A package file that cannot be parsed is not the server root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { dir: null, pkg: null };
}

function sourceProbe(serverDir, relativePath, needle) {
  if (!serverDir) return { present: false, containsMarker: false, reason: "server package was not found" };
  const file = path.join(serverDir, relativePath);
  if (!fs.existsSync(file)) return { present: false, containsMarker: false, reason: "file missing" };
  const text = fs.readFileSync(file, "utf8");
  return { present: true, containsMarker: text.includes(needle), reason: "" };
}

function gitRevision(dir) {
  if (!dir || !fs.existsSync(path.join(dir, ".git"))) return { revision: null, reason: "no .git directory" };
  try {
    return { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), reason: "" };
  } catch {
    return { revision: null, reason: "git rev-parse failed" };
  }
}

export function inspectDeployment(startDir) {
  const found = findServerRoot(startDir);
  const candidates = [found.dir, found.dir ? path.resolve(found.dir, "..") : null];
  let revision = null;
  let revisionReason = found.dir ? "no .git directory" : "server package was not found";
  for (const dir of candidates) {
    const read = gitRevision(dir);
    if (read.revision) {
      revision = read.revision;
      revisionReason = "";
      break;
    }
    if (dir) revisionReason = read.reason;
  }
  return {
    serverPackageFound: Boolean(found.dir),
    packageName: found.pkg?.name || null,
    packageVersion: found.pkg?.version || null,
    revision,
    revisionReason,
    safeguards: {
      fullSyncSavedIdGuard: sourceProbe(found.dir, path.join("src", "services", "giniSyncAll.js"), "classifyConfirmedSend"),
      resyncSearchStopsWhenPagesRemain: sourceProbe(
        found.dir,
        path.join("src", "services", "giniResync.js"),
        "SEARCH_PAGE_CAP"
      ),
      resyncIncompleteSearchBlocksSend: sourceProbe(
        found.dir,
        path.join("src", "utils", "giniResyncContract.js"),
        "search_pagination_incomplete"
      ),
      fullSyncSearchPageCap: sourceProbe(
        found.dir,
        path.join("src", "services", "giniSkuLookup.js"),
        "search_pagination_incomplete"
      ),
    },
  };
}

function jobSummary(job) {
  if (!job) return null;
  return {
    id: String(job._id || ""),
    status: job.status || "",
    mode: job.mode || "",
    runScope: job.runScope || "",
    total: Number(job.total) || 0,
    processed: Number(job.processed) || 0,
    eligible: Number(job.eligible) || 0,
    readyCreate: Number(job.readyCreate) || 0,
    alreadyExists: Number(job.alreadyExists) || 0,
    blocked: Number(job.blocked) || 0,
    inactive: Number(job.inactive) || 0,
    reconcile: Number(job.reconcile) || 0,
    lookupUncertain: Number(job.lookupUncertain) || 0,
    needsReview: Number(job.needsReview) || 0,
    created: Number(job.created) || 0,
    finishedAt: job.finishedAt || null,
    createdAt: job.createdAt || null,
  };
}

function matchesReportedPreview(job) {
  if (!job || job.mode !== "preview") return false;
  return Object.entries(REPORTED_PREVIEW).every(([key, value]) => Number(job[key]) === value);
}

async function closeCursor(cursor) {
  if (typeof cursor?.close !== "function") return;
  try {
    await cursor.close();
  } catch {
    // The documents were already read, or the read already failed.
  }
}

async function nextDocument(cursor) {
  try {
    return await cursor.next();
  } finally {
    await closeCursor(cursor);
  }
}

async function collectionMap(db) {
  const cursor = db.listCollections({}, { nameOnly: true });
  try {
    const listed = await cursor.toArray();
    const actual = new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
    const collections = {};
    for (const expected of GINI_COLLECTIONS) {
      const name = actual.get(expected) || null;
      collections[expected] = { present: Boolean(name), name };
    }
    return {
      collections,
      products: { present: actual.has("products"), name: actual.get("products") || null },
      taxonomy: { present: actual.has("platformtaxonomyconfigs"), name: actual.get("platformtaxonomyconfigs") || null },
    };
  } finally {
    await closeCursor(cursor);
  }
}

function collection(db, entry) {
  if (!entry?.present || !entry.name) return null;
  return db.collection(entry.name);
}

async function countOrNull(col, filter = {}) {
  if (!col) return null;
  return col.countDocuments(filter, { maxTimeMS: QUERY_MS });
}

async function loadSends(col) {
  if (!col) return { available: false, rows: [] };
  const cursor = col
    .find({}, { projection: { sku: 1, skuKey: 1, productId: 1, giniProductId: 1, jobId: 1, confirmedAt: 1, partner: 1 } })
    .maxTimeMS(QUERY_MS);
  try {
    const rows = await cursor.toArray();
    return { available: true, rows };
  } finally {
    await closeCursor(cursor);
  }
}

async function loadReady(col, jobId) {
  if (!col || !jobId) return { available: false, reason: "preview result collection or job id is missing", count: null, bySku: new Set(), byProduct: new Set() };
  const stored = await col.countDocuments({ jobId }, { maxTimeMS: QUERY_MS });
  if (!stored) {
    return { available: false, reason: "this preview has no stored product rows", count: 0, bySku: new Set(), byProduct: new Set() };
  }
  const bySku = new Set();
  const byProduct = new Set();
  let count = 0;
  const cursor = col
    .find({ jobId, classification: "READY_CREATE" }, { projection: { sku: 1, skuKey: 1, productId: 1 } })
    .maxTimeMS(QUERY_MS);
  try {
    for await (const row of cursor) {
      count += 1;
      const key = row.skuKey || giniSkuKey(row.sku);
      if (key) bySku.add(key);
      if (row.productId) byProduct.add(String(row.productId));
    }
  } finally {
    await closeCursor(cursor);
  }
  return { available: true, reason: "", storedRows: stored, count, bySku, byProduct };
}

async function createdKeys(col) {
  if (!col) return { available: false, count: null, keys: new Set(), productIds: new Set() };
  const keys = new Set();
  const productIds = new Set();
  let count = 0;
  const cursor = col
    .find({ classification: "CREATED" }, { projection: { sku: 1, skuKey: 1, productId: 1, giniProductId: 1 } })
    .maxTimeMS(QUERY_MS);
  try {
    for await (const row of cursor) {
      count += 1;
      const key = row.skuKey || giniSkuKey(row.sku);
      if (key) keys.add(key);
      if (row.productId) productIds.add(String(row.productId));
    }
  } finally {
    await closeCursor(cursor);
  }
  return { available: true, count, distinctSku: keys.size, keys, productIds };
}

function confirmationGaps(sends, created) {
  if (!sends.available || !created.available) {
    return { available: false, reason: "send state or created-result rows could not be read" };
  }
  const sendKeys = new Set();
  const missingCreated = [];
  const emptyGiniId = [];
  let duplicateSkuKeys = 0;
  for (const row of sends.rows) {
    const key = row.skuKey || giniSkuKey(row.sku);
    if (key && sendKeys.has(key)) duplicateSkuKeys += 1;
    if (key) sendKeys.add(key);
    if (key && !created.keys.has(key) && missingCreated.length < 20) missingCreated.push(String(row.sku || key));
    if (!String(row.giniProductId || "").trim() && emptyGiniId.length < 20) emptyGiniId.push(String(row.sku || row.productId || ""));
  }
  const createdWithoutSend = [];
  for (const key of created.keys) {
    if (!sendKeys.has(key) && createdWithoutSend.length < 20) createdWithoutSend.push(key);
  }
  return {
    available: true,
    duplicateSkuKeys,
    sendsMissingCreatedResult: missingCreated.length,
    sendsMissingCreatedExamples: missingCreated,
    createdMissingSendStateExamples: createdWithoutSend,
    emptyGiniProductIdExamples: emptyGiniId,
    emptyGiniProductIdCount: sends.rows.filter((row) => !String(row.giniProductId || "").trim()).length,
  };
}

function publicConnection(doc) {
  if (!doc) return { found: false };
  let host = "";
  try {
    host = new URL(String(doc.baseUrl || "")).hostname;
  } catch {
    host = "";
  }
  const clientIdMask = maskClientId(doc.clientId);
  return {
    found: true,
    host: host || null,
    hostMatchesEarlierRead: host === EARLIER_GINI_HOST,
    clientIdMask,
    clientIdMaskMatchesEarlierRead: clientIdMask === EARLIER_CLIENT_MASK,
    status: String(doc.lastStatus || ""),
    hasSecret: doc.hasSecret === true,
    lastAuthOk: doc.lastAuthOk === true,
    lastCategoriesOk: doc.lastCategoriesOk === true,
    lastCategoriesCount: Number(doc.lastCategoriesCount) || 0,
  };
}

async function classificationCounts(col, jobId) {
  if (!col || !jobId) return null;
  const cursor = col.aggregate(
    [{ $match: { jobId } }, { $group: { _id: "$classification", n: { $sum: 1 } } }],
    { maxTimeMS: QUERY_MS }
  );
  try {
    const rows = await cursor.toArray();
    return Object.fromEntries(rows.map((row) => [String(row._id || ""), row.n]));
  } finally {
    await closeCursor(cursor);
  }
}

function savedMappingStatus(values) {
  const categoryId = String(values?.categoryId || "").trim();
  const subcategoryId = String(values?.subcategoryId || "").trim();
  if (!categoryId || !subcategoryId) return "missing";
  return "saved";
}

function auditCollectionLabel(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") return String(value.en || value.ar || value.ku || "").trim();
  return "";
}

/**
 * Read collection mappings from Mongo only. This does not call GINI, so it
 * cannot mark a saved category active or inactive. The sync preview does that
 * with the live tree.
 */
async function readMappingCoverage(db, taxonomyEntry, productEntry) {
  if (!taxonomyEntry?.present || !productEntry?.present) {
    return { available: false, liveTreeChecked: false, reason: "taxonomy or product collection is absent" };
  }
  const configs = [];
  const configCursor = db
    .collection(taxonomyEntry.name)
    .find({ partner: "gini" }, { projection: { brownCollectionId: 1, values: 1 } })
    .maxTimeMS(QUERY_MS);
  try {
    for await (const row of configCursor) configs.push(row);
  } finally {
    await closeCursor(configCursor);
  }
  const productCursor = db.collection(productEntry.name).aggregate(
    [
      {
        $group: {
          _id: { $toString: { $ifNull: ["$collectionName._id", ""] } },
          name: { $first: "$collectionName.name" },
          productCount: { $sum: 1 },
          activeProductCount: { $sum: { $cond: [{ $ne: ["$isActive", false] }, 1, 0] } },
        },
      },
    ],
    { maxTimeMS: QUERY_MS }
  );
  let grouped = [];
  try {
    grouped = await productCursor.toArray();
  } finally {
    await closeCursor(productCursor);
  }
  const byId = new Map();
  for (const row of grouped || []) {
    const id = String(row?._id || "");
    byId.set(id, {
      id,
      name: auditCollectionLabel(row?.name),
      productCount: Number(row?.productCount) || 0,
      activeProductCount: Number(row?.activeProductCount) || 0,
    });
  }
  const valuesById = new Map();
  for (const config of configs) {
    const id = String(config?.brownCollectionId || "").trim();
    if (!id) continue;
    valuesById.set(id, config.values || {});
    if (!byId.has(id)) byId.set(id, { id, name: "", productCount: 0, activeProductCount: 0 });
  }
  const rows = [...byId.values()].map((row) => ({
    ...row,
    status: savedMappingStatus(valuesById.get(row.id)),
  }));
  const coverage = summarizeGiniMappingCoverage(rows);
  const saved = rows.filter((row) => row.status === "saved");
  return {
    available: true,
    liveTreeChecked: false,
    reason: "Saved mapping ids were counted. Active and inactive GINI categories are checked when Preview loads the live tree.",
    collections: rows.length,
    saved: saved.length,
    savedProductCount: saved.reduce((sum, row) => sum + row.productCount, 0),
    savedActiveProductCount: saved.reduce((sum, row) => sum + row.activeProductCount, 0),
    unmapped: coverage.unmapped,
    unmappedProductCount: coverage.unmappedProductCount,
    unmappedCollections: coverage.unmappedCollections.slice(0, 50),
    mappedIsNotSendEligibility: true,
  };
}

async function finishAuditConnection(connection) {
  if (!connection || !connection.readyState) return;
  try {
    await connection.disconnect();
  } catch {
    // Closing is cleanup. It must not hide the audit result or reject without a handler.
  }
}

export async function closeAfterAudit(connection, operation) {
  try {
    return await operation();
  } finally {
    await finishAuditConnection(connection);
  }
}

export async function auditDatabase(db) {
  const found = await collectionMap(db);
  const sendsCol = collection(db, found.collections.ginisyncsendstates);
  const resultsCol = collection(db, found.collections.ginisyncproductresults);
  const jobsCol = collection(db, found.collections.ginisyncjobs);
  const oneAuditCol = collection(db, found.collections.ginisynconeaudits);
  const connectionCol = collection(db, found.collections.giniconnections);
  const sends = await loadSends(sendsCol);
  const created = await createdKeys(resultsCol);
  const sendKeys = new Set(sends.rows.map((row) => row.skuKey || giniSkuKey(row.sku)).filter(Boolean));

  let latestPreview = null;
  let reportedPreview = null;
  let reportedPreviewCount = null;
  if (jobsCol) {
    latestPreview = await nextDocument(jobsCol.find({ mode: "preview" }).sort({ createdAt: -1 }).limit(1).maxTimeMS(QUERY_MS));
    reportedPreviewCount = await jobsCol.countDocuments(
      { mode: "preview", ...REPORTED_PREVIEW },
      { maxTimeMS: QUERY_MS }
    );
    reportedPreview = await nextDocument(
      jobsCol.find({ mode: "preview", ...REPORTED_PREVIEW }).sort({ createdAt: -1 }).limit(1).maxTimeMS(QUERY_MS)
    );
  }

  async function previewSection(job, label) {
    if (!job) return { label, found: false };
    const ready = await loadReady(resultsCol, job._id);
    const overlap = sends.available
      ? { ...overlapConfirmedWithReady(sends.rows, ready), reason: ready.reason || "", storedRows: ready.storedRows ?? null }
      : {
          available: false,
          reason: "send state collection is absent",
          overlapByNormalizedSku: null,
          overlapByProductId: null,
          storedRows: ready.storedRows ?? null,
        };
    return {
      label,
      found: true,
      matchesReportedCounts: matchesReportedPreview(job),
      job: jobSummary(job),
      storedClassificationCounts: await classificationCounts(resultsCol, job._id),
      overlap,
      referenceSkusInReady: ready.available
        ? referencePresence(LOCAL_REFERENCE_SKUS, sends.available ? sendKeys : null, created.available ? created.keys : null, ready.bySku).readySkus
        : null,
    };
  }

  const resync = {};
  for (const name of ["giniresyncpreviews", "giniresyncaudits", "giniresyncjobs", "giniresynclocks"]) {
    resync[name] = await countOrNull(collection(db, found.collections[name]));
  }

  const reference = referencePresence(
    LOCAL_REFERENCE_SKUS,
    sends.available ? sendKeys : null,
    created.available ? created.keys : null,
    null
  );
  const historical = referencePresence(
    LOCAL_HISTORICAL_SKUS,
    sends.available ? sendKeys : null,
    created.available ? created.keys : null,
    null
  );

  // findOne() returns a promise. maxTimeMS belongs in the options; the promise has no maxTimeMS method.
  const connection = connectionCol
    ? publicConnection(
        await connectionCol.findOne({}, { projection: { clientSecretEnc: 0 }, maxTimeMS: QUERY_MS })
      )
    : { found: false, reason: "giniconnections collection is absent" };

  return {
    collections: found.collections,
    context: {
      products: found.products.present ? await countOrNull(db.collection(found.products.name)) : null,
      giniTaxonomyMappings: found.taxonomy.present
        ? await countOrNull(db.collection(found.taxonomy.name), { partner: "gini" })
        : null,
    },
    confirmedSends: sends.available
      ? {
          available: true,
          documents: sends.rows.length,
          partnerGini: sends.rows.filter((row) => !row.partner || row.partner === "gini").length,
          distinctNormalizedSku: sendKeys.size,
        }
      : { available: false, documents: null, reason: "ginisyncsendstates collection is absent" },
    historicalCreates: created.available
      ? { available: true, createdRows: created.count, distinctNormalizedSku: created.distinctSku }
      : { available: false, createdRows: null, reason: "ginisyncproductresults collection is absent" },
    syncOneSuccessfulCreates: await countOrNull(oneAuditCol, { action: "CREATE", success: true }),
    confirmationGaps: confirmationGaps(sends, created),
    referenceSkus: {
      ...reference,
      historical: historical,
      note: "These 59 SKUs come from the local audit and are only a presence check.",
    },
    previews: {
      latest: await previewSection(latestPreview, "latest"),
      reportedCounts: await previewSection(reportedPreview, "reported-41415"),
      reportedCountMatches: reportedPreviewCount,
    },
    resync,
    giniConnection: connection,
    mappingCoverage: await readMappingCoverage(db, found.taxonomy, found.products),
  };
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const server = findServerRoot(scriptDirectory());
  const envBefore = Boolean(process.env.MONGO_URL || process.env.MONGODB_URI);
  if (server.dir) dotenv.config({ path: path.join(server.dir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const source = !uri ? "missing" : envBefore ? "process environment" : "server .env file";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset for this shell and the server .env file. No database was opened.");
    process.exitCode = 2;
    return;
  }

  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      readPreference: "primary",
      maxPoolSize: 1,
    });
    await closeAfterAudit(mongoose.connection, async () => {
      const report = await auditDatabase(mongoose.connection.db);
      const output = {
        readOnly: true,
        operations: ["listCollections", "find", "countDocuments", "aggregate"],
        connectionSource: source,
        database: {
          protocol: target.protocol,
          host: target.host,
          name: target.database,
          loopback: target.loopback,
        },
        deployment: inspectDeployment(scriptDirectory()),
        writeGates: writeGateSnapshot(process.env),
        ...report,
      };
      if (target.loopback) {
        console.error("Database host is loopback. Keep this result only when this shell is the production server.");
      }
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    });
  } catch (err) {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    process.exitCode = 3;
  } finally {
    await finishAuditConnection(mongoose.connection);
  }
}

function scriptDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    if (!process.exitCode) process.exitCode = 3;
  });
}
