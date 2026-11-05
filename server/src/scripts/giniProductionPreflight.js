#!/usr/bin/env node
/**
 * Read-only GINI production preflight.
 *
 * Run this only from an authorized Hostinger SSH session, in the deployed
 * BrownStore server directory. It does not start the backend, refresh IBSHER,
 * write to MongoDB, or send any GINI method except GET.
 *
 *   node src/scripts/giniProductionPreflight.js --confirm-production --allow-verified-production-loopback
 *
 * --confirm-production is required, and by itself it does not prove a loopback
 * database is production. Loopback is accepted only with the second flag and
 * after the read-only checks match the verified Hostinger deployment.
 *
 * Copy the JSON from the terminal. Do not send the shell environment, .env,
 * or any connection string.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { setGiniFetch, performGiniRequest, GiniConnectionError } from "../services/giniConnection.js";
import { GINI_PRODUCTS_PATH, giniSkuKey } from "../utils/giniSyncOnePlan.js";
import {
  LOCAL_HISTORICAL_SKUS,
  LOCAL_REFERENCE_SKUS,
  describeMongoTarget,
  inspectDeployment,
  maskClientId,
  sanitizeText,
  writeGateSnapshot,
} from "./giniProductionReadOnlyAudit.js";

const CONFIRM_FLAG = "--confirm-production";
export const LOOPBACK_FLAG = "--allow-verified-production-loopback";
const QUERY_MS = 120000;
const PAGE_CAP = 20;
const CANDIDATE_SAMPLE = 8;
const PACE_MS = 350;
const EARLIER_CLIENT_MASK = "1423...2bee";
const EARLIER_GINI_HOST = "merchant.gini.iq";
const CONFIRMED_READY_OVERLAP = 29;
const REPORTED_PREVIEW = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

function sameCount(value, expected) {
  return Number(value) === expected;
}

/**
 * Loopback is the verified Hostinger database, and it is also a developer laptop.
 * The extra flag is required, then the database, package, merchant, and preview must all match.
 * Any missing check refuses the run.
 */
export function evaluateLoopbackAuthorization({
  confirmProduction = false,
  allowLoopback = false,
  loopback = false,
  databaseName = "",
  deployment = null,
  merchant = null,
  preview = null,
} = {}) {
  if (confirmProduction !== true) return { allowed: false, reason: "confirmation_required" };
  if (loopback !== true) return { allowed: true, reason: "remote_database" };
  if (allowLoopback !== true) return { allowed: false, reason: "loopback_not_authorized" };
  const packageOk = deployment?.serverPackageFound === true && deployment?.packageName === "brownstore-server";
  const databaseOk = databaseName === "brownstore";
  const merchantOk = merchant?.hostMatches === true && merchant?.clientMaskMatches === true;
  const previewOk =
    preview?.found === true &&
    sameCount(preview.total, REPORTED_PREVIEW.total) &&
    sameCount(preview.readyCreate, REPORTED_PREVIEW.readyCreate) &&
    sameCount(preview.alreadyExists, REPORTED_PREVIEW.alreadyExists) &&
    sameCount(preview.blocked, REPORTED_PREVIEW.blocked) &&
    sameCount(preview.inactive, REPORTED_PREVIEW.inactive);
  if (!packageOk || !databaseOk || !merchantOk || !previewOk) {
    return { allowed: false, reason: "production_context_unverified" };
  }
  return { allowed: true, reason: "verified_production_loopback" };
}

export function createGetOnlyFetch(originalFetch) {
  return async (url, options = {}) => {
    const method = String(options.method || "GET").toUpperCase();
    if (method !== "GET") throw new Error(`Blocked ${method}. This preflight sends GET only.`);
    return originalFetch(url, options);
  };
}

function installGetOnlyFetch() {
  const original = globalThis.fetch.bind(globalThis);
  setGiniFetch(createGetOnlyFetch(original));
}

function merchantIdOf(data) {
  const value = data?.merchant_id ?? data?.seller_id ?? data?.store_id ?? data?.merchantId;
  return value == null ? "" : String(value).trim();
}

function exactId(read) {
  if (!read || read.state !== "found") return "";
  const id = String(read.giniProductId || "").trim();
  return id && giniSkuKey(read.sku) ? id : "";
}

export function interpretDirectGet(response) {
  if (!response) return { state: "uncertain", status: 0, giniProductId: "", sku: "", merchantId: "" };
  if (response.edgeBlocked) return { state: "edge", status: Number(response.status) || 403, giniProductId: "", sku: "", merchantId: "" };
  if (response.status === 401 || response.status === 403) {
    return { state: "auth", status: response.status, giniProductId: "", sku: "", merchantId: "" };
  }
  if (response.status === 429) return { state: "rate_limited", status: 429, giniProductId: "", sku: "", merchantId: "" };
  if (response.status === 404) return { state: "absent", status: 404, giniProductId: "", sku: "", merchantId: "" };
  if (response.status !== 200) return { state: "uncertain", status: Number(response.status) || 0, giniProductId: "", sku: "", merchantId: "" };
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { state: "uncertain", status: 200, giniProductId: "", sku: "", merchantId: "" };
  }
  const giniProductId = data.id == null ? "" : String(data.id).trim();
  const sku = data.sku == null ? "" : String(data.sku);
  if (!giniProductId || !giniSkuKey(sku)) return { state: "uncertain", status: 200, giniProductId: "", sku: "", merchantId: "" };
  return { state: "found", status: 200, giniProductId, sku, merchantId: merchantIdOf(data) };
}

export function interpretSearchPage(response) {
  if (!response) return { state: "uncertain", status: 0, matches: [] };
  if (response.edgeBlocked) return { state: "edge", status: Number(response.status) || 403, matches: [] };
  if (response.status === 401 || response.status === 403) return { state: "auth", status: response.status, matches: [] };
  if (response.status === 429) return { state: "rate_limited", status: 429, matches: [] };
  if (response.status !== 200 || !Array.isArray(response.json?.data)) {
    return { state: "uncertain", status: Number(response.status) || 0, matches: [] };
  }
  const matches = [];
  for (const item of response.json.data) {
    const giniProductId = item?.id == null ? "" : String(item.id).trim();
    const sku = item?.sku == null ? "" : String(item.sku);
    if (!giniProductId || !giniSkuKey(sku)) continue;
    matches.push({ giniProductId, sku, merchantId: merchantIdOf(item) });
  }
  const lastPage = Number(response.json?.meta?.last_page);
  const lastPageKnown = Number.isInteger(lastPage) && lastPage >= 1;
  return { state: "page", status: 200, matches, lastPage: lastPageKnown ? lastPage : 0, lastPageKnown };
}

export async function searchSkuCompletely(sku, getPage, { pageCap = PAGE_CAP } = {}) {
  const key = giniSkuKey(sku);
  const matches = [];
  let page = 1;
  let lastPage = 1;
  while (page <= lastPage) {
    if (page > pageCap) {
      return {
        state: "incomplete",
        complete: false,
        incomplete: true,
        status: 200,
        matches,
        lastPage,
        reason: "search_pagination_incomplete",
      };
    }
    const response = await getPage(page);
    const parsed = interpretSearchPage(response);
    if (parsed.state !== "page") {
      return {
        state: parsed.state,
        complete: false,
        incomplete: true,
        status: parsed.status,
        matches,
        lastPage,
        reason: parsed.state === "uncertain" ? "search_page_failed" : parsed.state,
      };
    }
    if (!parsed.lastPageKnown || parsed.lastPage < page) {
      return {
        state: "incomplete",
        complete: false,
        incomplete: true,
        status: 200,
        matches,
        lastPage,
        reason: "search_pagination_incomplete",
      };
    }
    matches.push(...parsed.matches);
    lastPage = parsed.lastPage;
    if (page >= lastPage) {
      const exact = matches.filter((item) => giniSkuKey(item.sku) === key);
      const ids = [...new Set(exact.map((item) => item.giniProductId))];
      return {
        state: ids.length > 1 ? "duplicate" : ids.length === 1 ? "found" : "absent",
        complete: true,
        incomplete: false,
        status: 200,
        matches,
        lastPage,
        reason: "",
      };
    }
    page += 1;
  }
  return { state: "incomplete", complete: false, incomplete: true, status: 0, matches, lastPage, reason: "search_pagination_incomplete" };
}

function observation(classification, reason, giniProductId = "", merchantId = "") {
  return {
    classification,
    reason,
    giniProductId: String(giniProductId || ""),
    merchantId: String(merchantId || ""),
  };
}

/**
 * EXISTS requires an exact SKU match.
 * VERIFIED_MISSING requires a finished direct 404 and a finished search with no exact match.
 * An unfinished page list, a transport error, or a single 404 is UNCERTAIN.
 */
export function classifyRemoteObservation({ direct, search, expectedKey }) {
  const key = giniSkuKey(expectedKey);
  const blocking = new Set(["auth", "edge", "rate_limited"]);
  if (blocking.has(direct?.state) || blocking.has(search?.state)) {
    return observation("UNCERTAIN", direct?.state && blocking.has(direct.state) ? direct.state : search.state);
  }
  const directHit = direct?.state === "found" && giniSkuKey(direct.sku) === key ? direct : null;
  const exact = (Array.isArray(search?.matches) ? search.matches : []).filter((item) => giniSkuKey(item.sku) === key);
  const searchIds = [...new Set(exact.map((item) => String(item.giniProductId || "")).filter(Boolean))];
  if (search?.state === "duplicate" || searchIds.length > 1) {
    return observation("UNCERTAIN", "duplicate_remote_sku", searchIds[0] || "");
  }
  if (directHit && searchIds.length === 1 && String(directHit.giniProductId) !== searchIds[0]) {
    return observation("UNCERTAIN", "remote_id_mismatch", directHit.giniProductId);
  }
  const merchants = [
    ...new Set(
      [directHit?.merchantId, ...exact.map((item) => item.merchantId)].map((value) => String(value || "").trim()).filter(Boolean)
    ),
  ];
  if (merchants.length > 1) return observation("UNCERTAIN", "account_conflict", directHit?.giniProductId || searchIds[0] || "");
  if (directHit) return observation("EXISTS", "direct_sku_get", directHit.giniProductId, merchants[0] || "");
  if (searchIds.length === 1 && search?.complete === true) {
    return observation("EXISTS", "complete_search_match", searchIds[0], merchants[0] || "");
  }
  if (searchIds.length === 1) return observation("UNCERTAIN", "search_pagination_incomplete", searchIds[0], merchants[0] || "");
  const directAbsent = direct?.state === "absent" && Number(direct.status) === 404;
  const searchMissing = search?.state === "absent" && search.complete === true && search.incomplete !== true;
  if (directAbsent && searchMissing) return observation("VERIFIED_MISSING", "direct_404_and_complete_search");
  if (search?.incomplete === true || search?.complete !== true) {
    return observation("UNCERTAIN", search?.reason || "search_pagination_incomplete");
  }
  return observation("UNCERTAIN", "remote_read_not_finished");
}

export function selectCandidateRows(rows, heldKeys) {
  const held = heldKeys instanceof Set ? heldKeys : new Set(heldKeys || []);
  const selected = [];
  for (const row of rows || []) {
    const key = row?.skuKey || giniSkuKey(row?.sku);
    if (!key || held.has(key)) continue;
    selected.push({
      sku: String(row.sku || ""),
      skuKey: key,
      productId: String(row.productId || ""),
    });
  }
  return selected;
}

export function canRecommendCandidate(evidence) {
  return Boolean(
    evidence?.previewMatchesReported === true &&
      evidence.sendStateCount === 0 &&
      evidence.historicalCreatedCount === 0 &&
      evidence.syncOneSuccessCount === 1 &&
      evidence.historicalReadyCount === CONFIRMED_READY_OVERLAP &&
      evidence.writeGatesEnabled === false &&
      evidence.merchantHostMatches === true &&
      evidence.clientMaskMatches === true &&
      evidence.candidateClassification === "VERIFIED_MISSING" &&
      evidence.candidateHeld === false
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function scriptIsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(fileURLToPath(import.meta.url));
  const right = path.resolve(entry);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function scriptDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findServerRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "brownstore-server") return dir;
      } catch {
        // Keep walking. A package file that cannot be parsed is not the server root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function finishConnection(connection) {
  if (!connection?.readyState) return;
  try {
    await connection.disconnect();
  } catch {
    // Closing is cleanup. It must not hide the preflight result.
  }
}

async function closeCursor(cursor) {
  if (typeof cursor?.close !== "function") return;
  try {
    await cursor.close();
  } catch {
    // The documents were already read, or the read already failed.
  }
}

async function collectionNames(db) {
  const cursor = db.listCollections({}, { nameOnly: true });
  try {
    const listed = await cursor.toArray();
    return new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  } finally {
    await closeCursor(cursor);
  }
}

function useCollection(db, names, key) {
  const actual = names.get(key);
  return actual ? db.collection(actual) : null;
}

async function readPreview(jobs) {
  if (!jobs) return null;
  const cursor = jobs.find({ mode: "preview", ...REPORTED_PREVIEW }).sort({ createdAt: -1 }).limit(1).maxTimeMS(QUERY_MS);
  try {
    return await cursor.next();
  } finally {
    await closeCursor(cursor);
  }
}

async function readReadyOverlap(results, jobId, skus) {
  if (!results || !jobId) return [];
  const keys = skus.map((sku) => giniSkuKey(sku));
  const cursor = results
    .find(
      {
        jobId,
        classification: "READY_CREATE",
        $or: [{ skuKey: { $in: keys } }, { sku: { $in: skus } }],
      },
      { projection: { sku: 1, skuKey: 1, productId: 1 } }
    )
    .maxTimeMS(QUERY_MS);
  try {
    return await cursor.toArray();
  } finally {
    await closeCursor(cursor);
  }
}

async function readSyncOneSuccesses(audits) {
  if (!audits) return [];
  const cursor = audits
    .find(
      { action: "CREATE", success: true },
      { projection: { sku: 1, productId: 1, httpStatus: 1, giniProductId: 1, errorCode: 1, createdAt: 1 } }
    )
    .sort({ createdAt: -1 })
    .limit(5)
    .maxTimeMS(QUERY_MS);
  try {
    return await cursor.toArray();
  } finally {
    await closeCursor(cursor);
  }
}

async function sampleReadyCandidates(results, jobId, heldKeys) {
  if (!results || !jobId) return [];
  const cursor = results
    .find(
      { jobId, classification: "READY_CREATE", skuKey: { $nin: [...heldKeys] } },
      { projection: { sku: 1, skuKey: 1, productId: 1 } }
    )
    .sort({ _id: 1 })
    .limit(CANDIDATE_SAMPLE)
    .maxTimeMS(QUERY_MS);
  try {
    return selectCandidateRows(await cursor.toArray(), heldKeys).slice(0, CANDIDATE_SAMPLE);
  } finally {
    await closeCursor(cursor);
  }
}

function publicConnection(doc) {
  if (!doc) return { found: false, host: null, hostMatches: false, clientIdMask: "", clientMaskMatches: false };
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
    hostMatches: host === EARLIER_GINI_HOST,
    clientIdMask,
    clientMaskMatches: clientIdMask === EARLIER_CLIENT_MASK,
    status: String(doc.lastStatus || ""),
    hasSecret: doc.hasSecret === true,
  };
}

async function readGini(pathName, query = "") {
  try {
    return await performGiniRequest({ method: "GET", path: pathName, query });
  } catch (err) {
    if (err instanceof GiniConnectionError && (err.code === "connection_required" || err.code === "secret_unreadable")) {
      return { status: Number(err.status) || 409, authFailure: err.code, edgeBlocked: false, json: null };
    }
    return { status: 0, transportError: sanitizeText(err?.message || err), edgeBlocked: false, json: null };
  }
}

async function directRead(identifier) {
  let last = { state: "uncertain", status: 0, giniProductId: "", sku: "", merchantId: "" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(Math.min(1000 * 2 ** (attempt - 1), 8000));
    else await sleep(PACE_MS);
    const response = await readGini(`${GINI_PRODUCTS_PATH}/${encodeURIComponent(identifier)}`);
    if (response.authFailure) return { state: "auth", status: response.status, giniProductId: "", sku: "", merchantId: "" };
    last = interpretDirectGet(response);
    if (last.state === "found" || last.state === "absent" || last.state === "auth" || last.state === "edge") return last;
    if (last.state !== "rate_limited" && last.status && last.status < 500) return last;
  }
  return last.state === "rate_limited" ? last : { ...last, state: "uncertain" };
}

async function searchRead(sku) {
  return searchSkuCompletely(sku, async (page) => {
    await sleep(PACE_MS);
    const response = await readGini(GINI_PRODUCTS_PATH, `?search=${encodeURIComponent(sku)}&per_page=100&page=${page}`);
    if (response.authFailure) return { status: 401, edgeBlocked: false, json: null };
    return response;
  });
}

async function classifySku(sku) {
  const direct = await directRead(sku);
  if (direct.state === "auth") {
    return { sku, ...classifyRemoteObservation({ direct, search: { state: "auth", complete: false, incomplete: true, matches: [] }, expectedKey: sku }), searchPages: 0 };
  }
  const search = await searchRead(sku);
  const classified = classifyRemoteObservation({ direct, search, expectedKey: sku });
  return {
    sku,
    ...classified,
    directStatus: Number(direct.status) || 0,
    searchComplete: search.complete === true,
    searchLastPage: Number(search.lastPage) || 0,
  };
}

function tally(rows) {
  const counts = { EXISTS: 0, VERIFIED_MISSING: 0, UNCERTAIN: 0 };
  for (const row of rows) counts[row.classification] = (counts[row.classification] || 0) + 1;
  return counts;
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const serverDir = findServerRoot(scriptDirectory());
  const envBefore = Boolean(process.env.MONGO_URL || process.env.MONGODB_URI);
  if (serverDir) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset for this shell and the server .env file. No database was opened.");
    process.exitCode = 2;
    return;
  }
  const allowLoopback = process.argv.includes(LOOPBACK_FLAG);
  if (target.loopback && !allowLoopback) {
    console.error(
      "Refusing loopback database. --confirm-production does not prove this shell is production. On the verified Hostinger server, re-run with --allow-verified-production-loopback."
    );
    process.exitCode = 2;
    return;
  }

  installGetOnlyFetch();
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      readPreference: "primary",
      maxPoolSize: 1,
    });
    let output;
    try {
      output = await (async () => {
      const db = mongoose.connection.db;
      const names = await collectionNames(db);
      const jobs = useCollection(db, names, "ginisyncjobs");
      const results = useCollection(db, names, "ginisyncproductresults");
      const sends = useCollection(db, names, "ginisyncsendstates");
      const audits = useCollection(db, names, "ginisynconeaudits");
      const connections = useCollection(db, names, "giniconnections");
      const preview = await readPreview(jobs);
      const sendStateCount = sends ? await sends.countDocuments({}, { maxTimeMS: QUERY_MS }) : null;
      const historicalCreatedCount = results
        ? await results.countDocuments({ classification: "CREATED" }, { maxTimeMS: QUERY_MS })
        : null;
      const syncOneRows = await readSyncOneSuccesses(audits);
      const syncOneSuccessCount = audits
        ? await audits.countDocuments({ action: "CREATE", success: true }, { maxTimeMS: QUERY_MS })
        : null;
      const readyRows = preview ? await readReadyOverlap(results, preview._id, LOCAL_REFERENCE_SKUS) : [];
      const readyByKey = new Map(readyRows.map((row) => [giniSkuKey(row.sku) || row.skuKey, row]));
      const historicalReady = LOCAL_REFERENCE_SKUS.filter((sku) => readyByKey.has(giniSkuKey(sku)));
      const connection = connections
        ? publicConnection(await connections.findOne({}, { projection: { clientSecretEnc: 0 }, maxTimeMS: QUERY_MS }))
        : { found: false, hostMatches: false, clientMaskMatches: false };
      const gates = writeGateSnapshot(process.env);
      const deployment = inspectDeployment(scriptDirectory());
      if (target.loopback) {
        const decision = evaluateLoopbackAuthorization({
          confirmProduction: true,
          allowLoopback: true,
          loopback: true,
          databaseName: target.database,
          deployment,
          merchant: connection,
          preview: preview
            ? {
                found: true,
                total: Number(preview.total) || 0,
                readyCreate: Number(preview.readyCreate) || 0,
                alreadyExists: Number(preview.alreadyExists) || 0,
                blocked: Number(preview.blocked) || 0,
                inactive: Number(preview.inactive) || 0,
              }
            : { found: false },
        });
        if (!decision.allowed) {
          const refusal = new Error(
            "Refusing loopback database. Production deployment context was not verified. No GINI request was sent."
          );
          refusal.code = "loopback_refused";
          throw refusal;
        }
      }
      const syncOnePublic = syncOneRows.map((row) => ({
        sku: String(row.sku || ""),
        productId: String(row.productId || ""),
        httpStatus: Number(row.httpStatus) || 0,
        giniProductId: String(row.giniProductId || ""),
        errorCode: String(row.errorCode || ""),
        createdAt: row.createdAt || null,
        storedInSendState: sendStateCount === 0 ? false : null,
      }));
      const held = new Set([
        ...LOCAL_REFERENCE_SKUS.map((sku) => giniSkuKey(sku)),
        ...syncOnePublic.map((row) => giniSkuKey(row.sku)).filter(Boolean),
      ]);
      const samples = preview ? await sampleReadyCandidates(results, preview._id, held) : [];
      const merchantOk = connection.hostMatches === true && connection.clientMaskMatches === true;
      let remoteAuthFailed = false;
      const classifyHeld = async (sku) => {
        if (!preview) {
          return { sku, classification: "UNCERTAIN", reason: "preview_not_found", giniProductId: "", merchantId: "" };
        }
        if (!merchantOk) {
          return { sku, classification: "UNCERTAIN", reason: "merchant_not_confirmed", giniProductId: "", merchantId: "" };
        }
        if (remoteAuthFailed) return { sku, classification: "UNCERTAIN", reason: "auth", giniProductId: "", merchantId: "" };
        const report = await classifySku(sku);
        if (report.reason === "auth") remoteAuthFailed = true;
        return report;
      };
      const historicalReports = [];
      for (const sku of historicalReady) historicalReports.push(await classifyHeld(sku));
      const syncOneReports = [];
      for (const row of syncOnePublic) {
        if (!row.sku) continue;
        if (historicalReports.some((item) => giniSkuKey(item.sku) === giniSkuKey(row.sku))) continue;
        syncOneReports.push(await classifyHeld(row.sku));
      }
      let recommendation = null;
      const sampleReports = [];
      for (const sample of samples) {
        const report = await classifyHeld(sample.sku);
        sampleReports.push({ ...sample, ...report });
        if (!recommendation && report.classification === "VERIFIED_MISSING") recommendation = { ...sample, ...report };
      }
      const evidence = {
        previewMatchesReported: Boolean(preview),
        sendStateCount,
        historicalCreatedCount,
        syncOneSuccessCount,
        historicalReadyCount: historicalReady.length,
        writeGatesEnabled: gates.anyEnabled === true,
        merchantHostMatches: connection.hostMatches === true,
        clientMaskMatches: connection.clientMaskMatches === true,
        candidateClassification: recommendation?.classification || "",
        candidateHeld: recommendation ? held.has(giniSkuKey(recommendation.sku)) : true,
      };
      const allowed = canRecommendCandidate(evidence);
      return {
        readOnly: true,
        methods: ["GET"],
        database: { protocol: target.protocol, host: target.host, name: target.database, loopback: target.loopback },
        connectionSource: envBefore ? "process environment" : "server .env file",
        deployment,
        writeGates: gates,
        merchant: connection,
        preview: preview
          ? {
              found: true,
              id: String(preview._id),
              total: Number(preview.total) || 0,
              readyCreate: Number(preview.readyCreate) || 0,
              alreadyExists: Number(preview.alreadyExists) || 0,
              blocked: Number(preview.blocked) || 0,
              inactive: Number(preview.inactive) || 0,
            }
          : { found: false },
        productionHistory: {
          sendStateCount,
          historicalCreatedCount,
          localReferenceSkuCount: LOCAL_REFERENCE_SKUS.length,
          localUnresolvedSkuCount: LOCAL_HISTORICAL_SKUS.length,
          note: "Local confirmed-send documents were not read and were not copied into production.",
        },
        historicalReady: {
          expectedCount: CONFIRMED_READY_OVERLAP,
          count: historicalReady.length,
          counts: tally(historicalReports),
          skus: historicalReports,
          notInReadyCreate: LOCAL_REFERENCE_SKUS.filter((sku) => !readyByKey.has(giniSkuKey(sku))),
        },
        syncOne: {
          successCount: syncOneSuccessCount,
          audits: syncOnePublic,
          remote: syncOneReports,
          note: "A Sync One audit is not a GiniSyncSendState record. Full Sync does not treat it as a saved send.",
        },
        holdSkus: [...held],
        candidate: allowed
          ? {
              allowed: true,
              sku: recommendation.sku,
              productId: recommendation.productId,
              classification: recommendation.classification,
              reason: recommendation.reason,
            }
          : {
              allowed: false,
              sku: "",
              reason: recommendation
                ? "A verified-missing sample was found, but the production evidence did not match the confirmed audit."
                : "No sampled READY_CREATE SKU outside the hold list was verified missing.",
            },
        candidateSamples: sampleReports.map((row) => ({
          sku: row.sku,
          productId: row.productId,
          classification: row.classification,
          reason: row.reason,
        })),
        blockers: [
          "Production GiniSyncSendState is not a copy of the local historical sends.",
          "Full Sync skips a create only when the live lookup matches or a production send id already exists.",
          "A limited Full Sync walks products by _id and stops after N creates. It does not target one chosen SKU.",
          "The running Hostinger application keeps its current lookup until a deliberate deploy. This preflight does not deploy or restart it.",
          "Re-sync is a separate deployed-code path and is not the exclusion mechanism for this preflight.",
          "All eight write gates stay off. This script does not enable them.",
        ],
      };
      })();
    } finally {
      await finishConnection(mongoose.connection);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    console.error(`Preflight read failed: ${sanitizeText(err?.message || err)}`);
    process.exitCode = err?.code === "loopback_refused" ? 2 : 3;
  } finally {
    await finishConnection(mongoose.connection);
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(`Preflight read failed: ${sanitizeText(err?.message || err)}`);
    if (!process.exitCode) process.exitCode = 3;
  });
}
