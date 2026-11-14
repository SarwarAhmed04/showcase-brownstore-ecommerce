import crypto from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { BSON } from "mongodb";

/** Original documents to restore. This is not a tunable operator setting. */
export const BRANDIRAQ_RECOVERY_COUNT = 27;
export const BRANDIRAQ_VENDOR = "Brandiraq";
export const BRANDIRAQ_PRODUCTS_BEFORE = 43430;
export const BRANDIRAQ_PRODUCTS_AFTER = 43457;
export const BRANDIRAQ_VENDOR_BEFORE = 286;
export const BRANDIRAQ_VENDOR_AFTER = 313;
export const PRODUCTS_COLLECTION = "products";
export const BRANDIRAQ_RECOVERY_AUTHORIZATION = "AUTHORIZE_ONE_TIME_BRANDIRAQ_27_ORIGINAL_INSERT";
export const BRANDIRAQ_BACKUP_ROOT = "/root/brownstore-backups/ownership-first-save-20261113T180302Z";
export const BRANDIRAQ_BACKUP_BSON = "/root/brownstore-backups/ownership-first-save-20261113T180302Z/brownstore/products.bson";
export const BRANDIRAQ_EXPECTED_IDS = "/tmp/brownstore-compare-E312Ij/missing_ids.txt";
export const BRANDIRAQ_EXPECTED_DETAILS = "/tmp/brownstore-compare-E312Ij/missing_details.jsonl";
export const BRANDIRAQ_PAUSE_BASENAME = "ibsher-catalog-sync.paused";
export const BSON_READ_MODE = fsConstants.O_RDONLY;
const MAX_BSON_DOCUMENT_BYTES = 48 * 1024 * 1024;

export const PRODUCTION_CATALOG = Object.freeze({
  productsBefore: BRANDIRAQ_PRODUCTS_BEFORE,
  productsAfter: BRANDIRAQ_PRODUCTS_AFTER,
  brandiraqBefore: BRANDIRAQ_VENDOR_BEFORE,
  brandiraqAfter: BRANDIRAQ_VENDOR_AFTER,
  recoveryCount: BRANDIRAQ_RECOVERY_COUNT,
});

const PRESERVED_FIELDS = Object.freeze([
  "_id",
  "ibsherId",
  "createdBy",
  "variants",
  "images",
  "category",
  "categories",
  "overrides",
]);

function refusal(code, extra = {}) {
  return {
    ok: false,
    readyForAuthorizedInsert: false,
    verified: false,
    writes: 0,
    inserted: 0,
    skipped: 0,
    stopped: true,
    stopReason: code,
    actions: [],
    conflicts: [],
    sentToGini: 0,
    sentToMiswag: 0,
    sentToElryan: 0,
    syncStarted: false,
    pauseMarkerRemoved: false,
    envModified: false,
    ownershipGatesChanged: false,
    backupModified: false,
    otherProductsModified: false,
    marketplaceRecordsModified: false,
    ...extra,
  };
}

export function describeMongoTarget(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return { available: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { available: false };
  }
  return {
    available: true,
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.host,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || ""),
    loopback: ["127.0.0.1", "localhost"].includes(parsed.hostname),
  };
}

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|secret|token|jwt|apikey|api_key|clientsecret)=([^\s&]+)/gi, "$1=[redacted]");
}

export function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

export function productionInputsAllowed({ bsonPath, expectedIdsPath, expectedDetailsPath } = {}) {
  return samePath(bsonPath, BRANDIRAQ_BACKUP_BSON)
    && samePath(expectedIdsPath, BRANDIRAQ_EXPECTED_IDS)
    && samePath(expectedDetailsPath, BRANDIRAQ_EXPECTED_DETAILS);
}

export function reportPathAllowed(reportPath, {
  backupRoot = BRANDIRAQ_BACKUP_ROOT,
  pauseFile = "",
  expectedIdsPath = BRANDIRAQ_EXPECTED_IDS,
  expectedDetailsPath = BRANDIRAQ_EXPECTED_DETAILS,
  serverDir = "",
} = {}) {
  if (!reportPath || !path.isAbsolute(reportPath)) return false;
  const resolved = path.resolve(reportPath);
  if (path.basename(resolved) === ".env") return false;
  const forbidden = [pauseFile, expectedIdsPath, expectedDetailsPath, serverDir ? path.join(serverDir, ".env") : ""]
    .filter(Boolean)
    .map((item) => path.resolve(item));
  if (forbidden.includes(resolved)) return false;
  const relative = path.relative(path.resolve(backupRoot), resolved);
  const insideBackup = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return !insideBackup;
}

function vendorLabel(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value !== "object") return "";
  if (typeof value.name === "string") return value.name.trim();
  if (value.name && typeof value.name === "object") {
    return String(value.name.en || value.name.ar || value.name.ku || "").trim();
  }
  return "";
}

function imageCount(doc) {
  if (Array.isArray(doc?.images)) return doc.images.length;
  if (typeof doc?.images === "string" && doc.images) return 1;
  if (Array.isArray(doc?.image)) return doc.image.length;
  if (typeof doc?.image === "string" && doc.image) return 1;
  return 0;
}

function categoryId(doc) {
  const category = doc?.category;
  if (!category) return "";
  if (typeof category === "string") return category;
  return String(category._id || category.id || "");
}

function canonical(value) {
  if (value == null) return value ?? null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value?.toHexString === "function" && value._bsontype === "ObjectId") return { $oid: value.toHexString() };
  if (value instanceof Date || value?._bsontype === "Date") return { $date: new Date(value).toISOString() };
  if (value?._bsontype === "Long" || value?._bsontype === "Decimal128") return { $number: value.toString() };
  if (value?._bsontype === "Binary" && typeof value.toString === "function") return { $binary: value.toString("base64") };
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
    return out;
  }
  return String(value);
}

export function sameProductDocument(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function linesOf(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function loadExpectedRecoverySet(idText, detailsText) {
  const ids = linesOf(idText).map((id) => id.toLowerCase());
  let details;
  try {
    details = linesOf(detailsText).map((line) => JSON.parse(line));
  } catch {
    return { ok: false, code: "expected_details_invalid" };
  }
  if (ids.length !== BRANDIRAQ_RECOVERY_COUNT || details.length !== BRANDIRAQ_RECOVERY_COUNT) {
    return { ok: false, code: "expected_count", originalIds: ids.length, sourceIds: details.length };
  }
  if (new Set(ids).size !== BRANDIRAQ_RECOVERY_COUNT) return { ok: false, code: "duplicate_expected_original_id" };
  const rows = [];
  const sources = [];
  for (const row of details) {
    const originalId = String(row?.id || row?._id || "").trim().toLowerCase();
    const alternateId = String(row?._id || "").trim().toLowerCase();
    const sourceId = String(row?.sourceItemId || "").trim();
    const alternateSource = String(row?.ibsherId || "").trim();
    if (!/^[a-f0-9]{24}$/.test(originalId)) return { ok: false, code: "expected_original_id_invalid", originalId };
    if (alternateId && alternateId !== originalId) return { ok: false, code: "expected_original_id_mismatch", originalId };
    if (!sourceId) return { ok: false, code: "expected_source_id_missing", originalId };
    if (alternateSource && alternateSource !== sourceId) return { ok: false, code: "expected_source_id_mismatch", originalId };
    if (vendorLabel(row?.vendor) !== BRANDIRAQ_VENDOR) return { ok: false, code: "expected_vendor", originalId };
    rows.push({ originalId, sourceId, vendor: BRANDIRAQ_VENDOR });
    sources.push(sourceId);
  }
  if (new Set(sources).size !== BRANDIRAQ_RECOVERY_COUNT) return { ok: false, code: "duplicate_expected_source_id" };
  const detailIds = new Set(rows.map((row) => row.originalId));
  if (ids.some((id) => !detailIds.has(id)) || detailIds.size !== ids.length) {
    return { ok: false, code: "expected_ids_do_not_match_details" };
  }
  const order = new Map(ids.map((id, index) => [id, index]));
  rows.sort((left, right) => order.get(left.originalId) - order.get(right.originalId));
  return { ok: true, rows };
}

export function matchBackupDocuments(rows, documents) {
  const byId = new Map();
  for (const item of documents || []) {
    const id = String(item?.doc?._id || item?.id || "").toLowerCase();
    if (!id) return { ok: false, code: "backup_document_missing_id" };
    if (byId.has(id)) return { ok: false, code: "duplicate_backup_id", originalId: id };
    byId.set(id, item);
  }
  const matched = [];
  for (const row of rows) {
    const found = byId.get(row.originalId);
    if (!found?.doc) return { ok: false, code: "missing_backup_document", originalId: row.originalId };
    const sourceId = String(found.doc.ibsherId || "").trim();
    if (sourceId !== row.sourceId) return { ok: false, code: "backup_source_mismatch", originalId: row.originalId };
    if (vendorLabel(found.doc.createdBy) !== BRANDIRAQ_VENDOR) {
      return { ok: false, code: "backup_vendor_mismatch", originalId: row.originalId };
    }
    if (!found.sha256) return { ok: false, code: "backup_fingerprint_missing", originalId: row.originalId };
    matched.push({ ...row, doc: found.doc, sha256: found.sha256 });
  }
  if (matched.length !== BRANDIRAQ_RECOVERY_COUNT) return { ok: false, code: "expected_count" };
  return { ok: true, matched };
}

export function classifyRecoveryCandidate(expected, byId = [], bySource = []) {
  const idHits = (byId || []).filter((doc) => String(doc?._id || "").toLowerCase() === expected.originalId);
  const sourceHits = (bySource || []).filter((doc) => String(doc?.ibsherId || "").trim() === expected.sourceId);
  if (idHits.length > 1) return { action: "stop_conflict", reason: "duplicate_original_id" };
  if (sourceHits.length > 1) return { action: "stop_conflict", reason: "duplicate_source" };
  const idDoc = idHits[0] || null;
  const sourceDoc = sourceHits[0] || null;
  if (idDoc && sourceDoc && String(idDoc._id).toLowerCase() !== String(sourceDoc._id).toLowerCase()) {
    return { action: "stop_conflict", reason: "id_and_source_on_different_documents", currentId: String(sourceDoc._id) };
  }
  if (idDoc && String(idDoc.ibsherId || "").trim() !== expected.sourceId) {
    return { action: "stop_conflict", reason: "original_id_conflict", currentSourceId: String(idDoc.ibsherId || "") };
  }
  if (sourceDoc && String(sourceDoc._id).toLowerCase() !== expected.originalId) {
    return { action: "stop_conflict", reason: "source_id_conflict", currentId: String(sourceDoc._id) };
  }
  if (idDoc) {
    if (!sameProductDocument(idDoc, expected.doc)) {
      return { action: "stop_conflict", reason: "already_present_document_diff" };
    }
    return { action: "skip_already_present", reason: "exact_match" };
  }
  return { action: "insert", reason: "absent" };
}

function actionRow(expected, action, reason, extra = {}) {
  const doc = expected.doc || {};
  return {
    originalId: expected.originalId,
    sourceId: expected.sourceId,
    action,
    reason,
    vendor: vendorLabel(doc.createdBy),
    itemCode: String(doc.itemCode || ""),
    variantCount: Array.isArray(doc.variants) ? doc.variants.length : 0,
    imageCount: imageCount(doc),
    categoryId: categoryId(doc),
    overrideKeys: Object.keys(doc.overrides || {}).sort(),
    sha256: expected.sha256,
    preservedFields: PRESERVED_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(doc, key)),
    ...extra,
  };
}

function catalogAccepted(catalog) {
  return catalog?.productsAfter === catalog?.productsBefore + BRANDIRAQ_RECOVERY_COUNT
    && catalog?.brandiraqAfter === catalog?.brandiraqBefore + BRANDIRAQ_RECOVERY_COUNT
    && catalog?.recoveryCount === BRANDIRAQ_RECOVERY_COUNT;
}

export function recoveryExecutionOk({ verification, collectionChanges = [], stopReason = "" } = {}) {
  const changes = Array.isArray(collectionChanges) ? collectionChanges : [];
  if (stopReason) return { ok: false, okReason: String(stopReason) };
  if (!verification?.ok) return { ok: false, okReason: "documents_not_verified" };
  if (changes.length) return { ok: false, okReason: "collection_counts_changed" };
  return { ok: true, okReason: "verified" };
}

function countsUnchangedExceptProducts(before, after, insertedCount) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const key of keys) {
    const left = Number(before?.[key] ?? 0);
    const right = Number(after?.[key] ?? 0);
    const expected = key === PRODUCTS_COLLECTION ? left + insertedCount : left;
    if (right !== expected) changes.push({ collection: key, before: left, after: right, expected });
  }
  return changes;
}

function verificationOf(matched, snapshot, catalog) {
  const rows = matched.map((expected) => {
    const decision = classifyRecoveryCandidate(expected, snapshot.byId, snapshot.bySource);
    const ok = decision.action === "skip_already_present";
    return {
      originalId: expected.originalId,
      sourceId: expected.sourceId,
      ok,
      reason: ok ? "verified" : decision.reason,
    };
  });
  const totalsMatch = snapshot.total === catalog.productsAfter && snapshot.brandiraq === catalog.brandiraqAfter;
  const failed = rows.filter((row) => !row.ok);
  return {
    verifiedCount: rows.filter((row) => row.ok).length,
    failed,
    totalsMatch,
    ok: failed.length === 0 && totalsMatch && rows.length === BRANDIRAQ_RECOVERY_COUNT,
  };
}

/**
 * Reads matching product documents from a mongodump BSON file.
 * The file is opened read-only and its size and mtime are compared after the scan.
 */
export async function selectBsonDocuments(filePath, wantedIds, dependencies = {}) {
  const fsPromises = dependencies.fsPromises || fs;
  const readMode = dependencies.readMode || BSON_READ_MODE;
  const deserialize = dependencies.deserialize || ((raw) => BSON.deserialize(raw));
  const wanted = new Set([...(wantedIds || [])].map((id) => String(id).toLowerCase()));
  const before = await fsPromises.stat(filePath);
  const handle = await fsPromises.open(filePath, readMode);
  try {
    const documents = [];
    const duplicates = [];
    const lengthBuf = Buffer.alloc(4);
    let offset = 0;
    let scanned = 0;
    while (offset + 4 <= before.size) {
      const head = await handle.read(lengthBuf, 0, 4, offset);
      if (head.bytesRead !== 4) return { ok: false, code: "truncated_bson" };
      const size = lengthBuf.readInt32LE(0);
      if (size < 5 || size > MAX_BSON_DOCUMENT_BYTES || offset + size > before.size) {
        return { ok: false, code: "invalid_bson_size" };
      }
      const raw = Buffer.alloc(size);
      lengthBuf.copy(raw, 0, 0, 4);
      const body = await handle.read(raw, 4, size - 4, offset + 4);
      if (body.bytesRead !== size - 4) return { ok: false, code: "truncated_bson" };
      const doc = deserialize(raw);
      scanned += 1;
      const id = String(doc?._id || "").toLowerCase();
      if (wanted.has(id)) {
        if (documents.some((item) => item.id === id) || duplicates.includes(id)) duplicates.push(id);
        else documents.push({ id, doc, sha256: crypto.createHash("sha256").update(raw).digest("hex") });
      }
      offset += size;
    }
    if (offset !== before.size) return { ok: false, code: "truncated_bson" };
    const after = await fsPromises.stat(filePath);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { ok: false, code: "backup_changed_during_read" };
    }
    return {
      ok: duplicates.length === 0,
      code: duplicates.length ? "duplicate_backup_id" : "backup_read",
      documents,
      duplicates: [...new Set(duplicates)],
      scanned,
      size: before.size,
      mtimeMs: before.mtimeMs,
      unchanged: true,
    };
  } finally {
    await handle.close();
  }
}

export async function runBrandiraqSelectiveRecovery({
  mode = "dry_run",
  platform = "linux",
  authorization = "",
  pausePresent = false,
  databaseName = "",
  idText = "",
  detailsText = "",
  backupDocuments = null,
  loadBackup = null,
  readCatalog = null,
  insertOriginal = null,
  recheckPause = null,
  catalog = PRODUCTION_CATALOG,
  backupUnchanged = true,
} = {}) {
  const base = {
    mode,
    databaseName,
    expectedCount: BRANDIRAQ_RECOVERY_COUNT,
    expectedProductsAfter: catalog.productsAfter,
    expectedBrandiraqAfter: catalog.brandiraqAfter,
    pausePresent: Boolean(pausePresent),
    authorization: mode === "execute" ? "rejected" : "not_requested",
  };
  if (!catalogAccepted(catalog)) return refusal("catalog_contract", base);
  if (mode === "execute") {
    if (platform === "win32") return refusal("desktop_execution_refused", base);
    if (authorization !== BRANDIRAQ_RECOVERY_AUTHORIZATION) return refusal("authorization_required", base);
    if (!pausePresent) return refusal("pause_marker_missing", base);
    if (databaseName !== "brownstore") return refusal("database_not_brownstore", base);
    base.authorization = "accepted";
  }
  if (databaseName && databaseName !== "brownstore") return refusal("database_not_brownstore", base);

  const expected = loadExpectedRecoverySet(idText, detailsText);
  if (!expected.ok) return refusal(expected.code, { ...base, ...expected, rows: undefined });

  let selected = backupDocuments;
  if (!selected && loadBackup) selected = await loadBackup(expected.rows.map((row) => row.originalId));
  if (!selected?.ok || selected.unchanged === false || backupUnchanged === false) {
    return refusal(selected?.code || "backup_unreadable", base);
  }
  const matched = matchBackupDocuments(expected.rows, selected.documents);
  if (!matched.ok) return refusal(matched.code, { ...base, originalId: matched.originalId });

  if (typeof readCatalog !== "function") return refusal("catalog_reader_missing", base);
  const snapshot = await readCatalog();
  const decisions = matched.matched.map((row) => ({
    row,
    decision: classifyRecoveryCandidate(row, snapshot.byId, snapshot.bySource),
  }));
  const conflicts = decisions.filter((item) => item.decision.action === "stop_conflict");
  if (conflicts.length) {
    return refusal(conflicts[0].decision.reason, {
      ...base,
      actions: decisions.map((item) => actionRow(item.row, "not_inserted", item.decision.reason, {
        currentId: item.decision.currentId || "",
        currentSourceId: item.decision.currentSourceId || "",
      })),
      conflicts: conflicts.map((item) => item.row.originalId),
      catalog: { total: snapshot.total, brandiraq: snapshot.brandiraq },
    });
  }

  const alreadyPresent = decisions.filter((item) => item.decision.action === "skip_already_present").length;
  const expectedTotal = catalog.productsBefore + alreadyPresent;
  const expectedBrand = catalog.brandiraqBefore + alreadyPresent;
  if (snapshot.total !== expectedTotal || snapshot.brandiraq !== expectedBrand) {
    return refusal("catalog_count_drift", {
      ...base,
      actions: decisions.map((item) => actionRow(item.row, "not_inserted", "catalog_count_drift")),
      catalog: { total: snapshot.total, brandiraq: snapshot.brandiraq, expectedTotal, expectedBrand },
    });
  }

  const dryActions = decisions.map((item) => actionRow(
    item.row,
    item.decision.action === "insert" ? "would_insert" : "skipped_already_present",
    item.decision.reason,
  ));
  if (mode !== "execute") {
    const verification = mode === "verify" ? verificationOf(matched.matched, snapshot, catalog) : null;
    const insertsPlanned = decisions.filter((item) => item.decision.action === "insert").length;
    const ready = mode === "dry_run" && pausePresent && insertsPlanned > 0;
    const alreadyComplete = mode === "dry_run" && pausePresent && alreadyPresent === BRANDIRAQ_RECOVERY_COUNT;
    return {
      ...base,
      ok: mode === "verify" ? verification.ok : (ready || alreadyComplete),
      readyForAuthorizedInsert: ready,
      verified: Boolean(verification?.ok),
      verification,
      writes: 0,
      inserted: 0,
      skipped: alreadyPresent,
      stopped: false,
      stopReason: "",
      actions: dryActions,
      conflicts: [],
      catalog: { total: snapshot.total, brandiraq: snapshot.brandiraq, expectedTotal, expectedBrand },
      sentToGini: 0,
      sentToMiswag: 0,
      sentToElryan: 0,
      syncStarted: false,
      pauseMarkerRemoved: false,
      envModified: false,
      ownershipGatesChanged: false,
      backupModified: false,
      otherProductsModified: false,
      marketplaceRecordsModified: false,
    };
  }

  const countsBefore = { ...(snapshot.collectionCounts || {}) };
  const actions = [];
  let inserted = 0;
  let skipped = 0;
  let stopReason = "";
  for (const item of matched.matched) {
    const paused = recheckPause ? await recheckPause() : pausePresent;
    if (!paused) {
      stopReason = "pause_marker_missing";
      actions.push(actionRow(item, "not_inserted", stopReason));
      break;
    }
    const live = await readCatalog();
    const liveDecisions = matched.matched.map((row) => classifyRecoveryCandidate(row, live.byId, live.bySource));
    const conflict = liveDecisions.find((decision) => decision.action === "stop_conflict");
    if (conflict) {
      stopReason = conflict.reason;
      actions.push(actionRow(item, "not_inserted", stopReason, {
        currentId: conflict.currentId || "",
        currentSourceId: conflict.currentSourceId || "",
      }));
      break;
    }
    const present = liveDecisions.filter((decision) => decision.action === "skip_already_present").length;
    if (live.total !== catalog.productsBefore + present || live.brandiraq !== catalog.brandiraqBefore + present) {
      stopReason = "catalog_count_drift";
      actions.push(actionRow(item, "not_inserted", stopReason));
      break;
    }
    const again = classifyRecoveryCandidate(item, live.byId, live.bySource);
    if (again.action === "skip_already_present") {
      skipped += 1;
      actions.push(actionRow(item, "skipped_already_present", again.reason));
      continue;
    }
    try {
      await insertOriginal(item.doc);
    } catch (err) {
      if (err?.code !== 11000) {
        stopReason = "insert_failed";
        actions.push(actionRow(item, "not_inserted", stopReason, { error: sanitizeText(err?.message || err) }));
        break;
      }
      const raced = await readCatalog();
      const racedDecision = classifyRecoveryCandidate(item, raced.byId, raced.bySource);
      if (racedDecision.action === "skip_already_present") {
        skipped += 1;
        actions.push(actionRow(item, "skipped_already_present", "exact_match_after_duplicate_key"));
        continue;
      }
      stopReason = racedDecision.reason || "duplicate_key_conflict";
      actions.push(actionRow(item, "not_inserted", stopReason));
      break;
    }
    inserted += 1;
    actions.push(actionRow(item, "inserted", "inserted_original"));
  }
  if (stopReason) {
    for (const item of decisions) {
      if (!actions.some((row) => row.originalId === item.row.originalId)) {
        actions.push(actionRow(item.row, "not_inserted", "stopped_before_document"));
      }
    }
  }

  const finalSnapshot = await readCatalog();
  const verification = verificationOf(matched.matched, finalSnapshot, catalog);
  const collectionChanges = countsUnchangedExceptProducts(
    countsBefore,
    finalSnapshot.collectionCounts || {},
    inserted,
  );
  const execution = recoveryExecutionOk({ verification, collectionChanges, stopReason });
  return {
    ...base,
    ok: execution.ok,
    okReason: execution.okReason,
    readyForAuthorizedInsert: false,
    verified: execution.ok,
    verification: { ...verification, collectionChanges },
    writes: inserted,
    inserted,
    skipped,
    stopped: Boolean(stopReason),
    stopReason,
    actions,
    conflicts: stopReason ? actions.filter((row) => row.action === "not_inserted").map((row) => row.originalId) : [],
    catalog: {
      before: snapshot.total,
      brandiraqBefore: snapshot.brandiraq,
      after: finalSnapshot.total,
      brandiraqAfter: finalSnapshot.brandiraq,
      expectedAfter: catalog.productsAfter,
      expectedBrandiraqAfter: catalog.brandiraqAfter,
    },
    sentToGini: 0,
    sentToMiswag: 0,
    sentToElryan: 0,
    syncStarted: false,
    pauseMarkerRemoved: false,
    envModified: false,
    ownershipGatesChanged: false,
    backupModified: false,
    otherProductsModified: collectionChanges.some((change) => change.collection !== PRODUCTS_COLLECTION),
    marketplaceRecordsModified: false,
  };
}
