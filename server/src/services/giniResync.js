import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniProductUpdateJob } from "../models/GiniProductUpdateJob.js";
import { GiniResyncAudit } from "../models/GiniResyncAudit.js";
import { GiniResyncJob } from "../models/GiniResyncJob.js";
import { GiniResyncLock } from "../models/GiniResyncLock.js";
import { GiniResyncPreview } from "../models/GiniResyncPreview.js";
import { GiniSyncJob } from "../models/GiniSyncJob.js";
import { GiniSyncProductResult } from "../models/GiniSyncProductResult.js";
import { GiniSyncSendState } from "../models/GiniSyncSendState.js";
import { Product } from "../models/Product.js";
import { partnerPricePreview } from "../utils/partnerCatalog.js";
import { evaluatePlatformEligibility } from "../utils/platformEligibility.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import { toResolvedProduct } from "../utils/productView.js";
import { isGiniHistoricalHoldSku } from "../utils/giniHistoricalHold.js";
import { buildGiniPlanFromParts, giniPayloadHash, mappingFromTree } from "../utils/giniSyncEvaluate.js";
import { resyncIndexesEnforced } from "../utils/giniResyncIndexes.js";
import { GINI_PRODUCTS_PATH, giniCatalogText, giniSkuKey, normalizeGiniItemCode } from "../utils/giniSyncOnePlan.js";
import {
  assessGiniResyncRemote,
  classifyGiniResyncRow,
  GINI_RESYNC_CREATE_METHOD,
  GINI_RESYNC_PREVIEW_TTL_MS,
  giniResyncPreviewSignature,
  giniResyncWritesEnabled,
  resyncReason,
  resyncRowCanSend,
} from "../utils/giniResyncContract.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";
import {
  fetchGiniCategoryTree,
  getGiniConnectionPublic,
  GINI_SECRET_UNREADABLE_MESSAGE,
  GiniConnectionError,
  performGiniRequest,
  sanitizeGiniText,
} from "./giniConnection.js";

const BATCH_LOCK = "__gini_resync_batch__";
const ACTIVE_CREATE = ["preview_running", "running", "paused", "auth_failed", "rate_limited", "edge_blocked"];
const OPEN_AUDIT = ["pending", "uncertain", "rate_limited"];
const FATAL_REMOTE = new Set(["auth", "edge", "rate_limited"]);

let paceOverride = null;
let beforeSend = null;

export class GiniResyncError extends Error {
  constructor(message, { status = 400, code = "gini_resync_error" } = {}) {
    super(message);
    this.name = "GiniResyncError";
    this.status = status;
    this.code = code;
  }
}

export { giniResyncWritesEnabled };

export function setGiniResyncPaceMs(ms) {
  paceOverride = ms == null ? null : Number(ms);
}

export function setGiniResyncBeforeSend(fn) {
  beforeSend = typeof fn === "function" ? fn : null;
}

export function resetGiniResyncForTests() {
  paceOverride = null;
  beforeSend = null;
}

function fail(message, code, status = 409) {
  throw new GiniResyncError(message, { status, code });
}

function holdBlocks(...values) {
  return values.some((value) => isGiniHistoricalHoldSku(value));
}

async function assertResyncIndexes() {
  if (await resyncIndexesEnforced()) return;
  fail("GINI re-sync indexes are not initialized. No product was created.", "resync_indexes_unavailable", 409);
}

async function blockedHold(sku, state, jobId = "", auditId = "") {
  if (auditId) {
    await GiniResyncAudit.updateOne(
      { _id: auditId },
      {
        $set: {
          status: "failed",
          requestSent: false,
          errorCode: "historical_sku_hold",
          errorMessage: resyncReason("historical_sku_hold"),
        },
      }
    );
  }
  if (jobId && state?.skuKey) await releaseLock(state.skuKey, jobId);
  return outcome(sku, {
    code: "historical_sku_hold",
    previousGiniProductId: state?.giniProductId || "",
    message: resyncReason("historical_sku_hold"),
  });
}

function safeText(value) {
  return sanitizeGiniText(value, [], 300)
    .replace(/x-signature\s*[:=]\s*\S+/gi, "[redacted]")
    .replace(/x-api-key\s*[:=]\s*\S+/gi, "[redacted]")
    .slice(0, 300);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function paceMs() {
  if (paceOverride != null) return paceOverride;
  const raw = Number(process.env.GINI_RESYNC_PACE_MS);
  if (!Number.isFinite(raw) || raw < 0) return 250;
  return raw;
}

async function pace() {
  const ms = paceMs();
  if (ms > 0) await sleep(ms);
}

function accountFrom(connection) {
  let baseHost = "";
  try {
    baseHost = new URL(connection?.baseUrl || "").host;
  } catch {
    baseHost = "";
  }
  return {
    clientId: String(connection?.clientId || ""),
    baseHost,
    status: String(connection?.status || ""),
  };
}

function merchantIdOf(data) {
  const value = data?.merchant_id ?? data?.seller_id ?? data?.store_id ?? data?.merchantId;
  return value == null ? "" : String(value).trim();
}

function readSummary(read) {
  return { state: String(read?.state || ""), status: Number(read?.status) || 0 };
}

function foundProduct(read) {
  return Boolean(read && read.state === "found" && String(read.giniProductId || "").trim() && giniSkuKey(read.sku));
}

function interpretGet(response) {
  if (!response) return { state: "uncertain", status: 0 };
  if (response.edgeBlocked) return { state: "edge", status: Number(response.status) || 403 };
  if (response.status === 401 || response.status === 403) return { state: "auth", status: response.status };
  if (response.status === 429) return { state: "rate_limited", status: 429, retryAfter: response.retryAfter };
  if (response.status === 404) return { state: "absent", status: 404 };
  if (response.status !== 200) return { state: "uncertain", status: Number(response.status) || 0 };
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return { state: "uncertain", status: 200 };
  const giniProductId = data.id == null ? "" : String(data.id).trim();
  const sku = data.sku == null ? "" : String(data.sku);
  if (!giniProductId || !giniSkuKey(sku)) return { state: "uncertain", status: 200 };
  return { state: "found", status: 200, giniProductId, sku, merchantId: merchantIdOf(data) };
}

function fatalRead(read) {
  return FATAL_REMOTE.has(read?.state);
}

async function readIdentifier(identifier) {
  const value = String(identifier || "").trim();
  if (!value) return { state: "uncertain", status: 0 };
  let last = { state: "uncertain", status: 0 };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pace();
    let response;
    try {
      response = await performGiniRequest({
        method: "GET",
        path: `${GINI_PRODUCTS_PATH}/${encodeURIComponent(value)}`,
      });
    } catch (err) {
      if (err instanceof GiniConnectionError && (err.code === "connection_required" || err.code === "secret_unreadable")) {
        return { state: "auth", status: Number(err.status) || 409 };
      }
      last = { state: "uncertain", status: Number(err?.status) || 0 };
      if (paceMs() === 0) continue;
      await sleep(Math.min(1000 * 2 ** attempt, 8000));
      continue;
    }
    last = interpretGet(response);
    if (last.state === "absent" || last.state === "found" || fatalRead(last)) return last;
    if (attempt < 2 && paceMs() > 0) await sleep(Math.min(1000 * 2 ** attempt, 8000));
  }
  return last;
}

function interpretSearchPage(response) {
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
  return {
    state: "page",
    status: 200,
    matches,
    lastPage: lastPageKnown ? lastPage : 0,
    lastPageKnown,
  };
}

const SEARCH_PAGE_CAP = 5;

function unfinishedSearch(status, matches = []) {
  return { state: "uncertain", status, matches, incomplete: true };
}

async function searchSku(sku) {
  const matches = [];
  let page = 1;
  let lastPage = 1;
  let finished = false;
  while (page <= lastPage && page <= SEARCH_PAGE_CAP) {
    await pace();
    let response;
    try {
      response = await performGiniRequest({
        method: "GET",
        path: GINI_PRODUCTS_PATH,
        query: `?search=${encodeURIComponent(sku)}&per_page=100&page=${page}`,
      });
    } catch (err) {
      if (err instanceof GiniConnectionError && (err.code === "connection_required" || err.code === "secret_unreadable")) {
        return { state: "auth", status: Number(err.status) || 409, matches: [] };
      }
      return { state: "uncertain", status: Number(err?.status) || 0, matches: [] };
    }
    const parsed = interpretSearchPage(response);
    if (parsed.state !== "page") return { state: parsed.state, status: parsed.status, matches: [] };
    if (!parsed.lastPageKnown || parsed.lastPage < page) return unfinishedSearch(parsed.status);
    matches.push(...parsed.matches);
    lastPage = parsed.lastPage;
    if (page >= lastPage) finished = true;
    page += 1;
  }
  const same = matches.filter((item) => giniSkuKey(item.sku) === giniSkuKey(sku));
  const ids = [...new Set(same.map((item) => item.giniProductId))];
  if (ids.length > 1) return { state: "duplicate", status: 200, matches: same };
  if (ids.length === 1) return { state: "found", status: 200, matches: same };
  if (!finished) return unfinishedSearch(200);
  return { state: "absent", status: 200, matches: [] };
}

async function verifyRemote(sku, savedId) {
  const skuRead = await readIdentifier(sku);
  if (fatalRead(skuRead)) {
    const empty = { state: "uncertain", status: 0, matches: [] };
    return { skuRead, idRead: empty, search: empty, assessed: assessGiniResyncRemote({ savedSku: sku, savedGiniProductId: savedId, skuRead, idRead: empty, search: empty }) };
  }
  const idRead = /^\d+$/.test(String(savedId || ""))
    ? await readIdentifier(savedId)
    : { state: "uncertain", status: 0 };
  if (fatalRead(idRead)) {
    const empty = { state: "uncertain", status: 0, matches: [] };
    return { skuRead, idRead, search: empty, assessed: assessGiniResyncRemote({ savedSku: sku, savedGiniProductId: savedId, skuRead, idRead, search: empty }) };
  }
  const search = await searchSku(sku);
  return {
    skuRead,
    idRead,
    search,
    assessed: assessGiniResyncRemote({ savedSku: sku, savedGiniProductId: savedId, skuRead, idRead, search }),
  };
}

function confirmedCreateId(response, skuKey) {
  const data = response?.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const id = data.id == null ? "" : String(data.id).trim();
  if (!/^\d+$/.test(id)) return "";
  if (data.sku != null && String(data.sku).trim() && giniSkuKey(data.sku) !== skuKey) return "";
  return id;
}

async function verifyNewProduct(sku, newId) {
  const skuRead = await readIdentifier(sku);
  const idRead = await readIdentifier(newId);
  const search = await searchSku(sku);
  if (fatalRead(skuRead) || fatalRead(idRead) || fatalRead(search)) return { ok: false, uncertain: true };
  if (!foundProduct(skuRead) || !foundProduct(idRead)) return { ok: false, uncertain: true };
  if (String(skuRead.giniProductId) !== String(newId) || String(idRead.giniProductId) !== String(newId)) {
    return { ok: false, uncertain: true };
  }
  if (giniSkuKey(skuRead.sku) !== giniSkuKey(sku) || giniSkuKey(idRead.sku) !== giniSkuKey(sku)) {
    return { ok: false, uncertain: true };
  }
  if (search.state !== "found") return { ok: false, uncertain: true };
  const matches = (search.matches || []).filter((item) => giniSkuKey(item.sku) === giniSkuKey(sku));
  const ids = [...new Set(matches.map((item) => String(item.giniProductId)))];
  if (ids.length !== 1 || ids[0] !== String(newId)) return { ok: false, uncertain: true };
  return { ok: true, merchantId: skuRead.merchantId || idRead.merchantId || "" };
}

async function skuOwners() {
  const owners = new Map();
  const cursor = Product.find({ itemCode: { $type: "string", $ne: "" } }).select("_id itemCode").lean().cursor();
  for await (const doc of cursor) {
    const key = giniSkuKey(doc.itemCode);
    if (!key) continue;
    const list = owners.get(key);
    const id = String(doc._id);
    if (list) list.push(id);
    else owners.set(key, [id]);
  }
  return owners;
}

function productName(doc) {
  const text = giniCatalogText(toResolvedProduct(doc) || doc);
  return text.name || text.nameEn || text.nameAr || "";
}

function publicRow(row) {
  return {
    sku: row.sku || "",
    productId: row.productId || "",
    name: row.name || "",
    classification: row.classification || "",
    code: row.code || "",
    reason: row.reason || "",
    blockers: row.blockers || [],
    eligible: row.eligible === true,
    locallyEligible: row.locallyEligible === true,
    historical: row.historical === true,
    remoteState: row.remoteState || "",
    identityMatched: row.identityMatched === true,
    savedGiniProductId: row.savedGiniProductId || "",
    giniProductId: row.savedGiniProductId || "",
    liveGiniProductId: row.liveGiniProductId || "",
    savedPayloadHash: row.savedPayloadHash || "",
    currentHash: row.currentHash || "",
    giniPrice: row.giniPrice ?? null,
    quantity: row.quantity ?? null,
    imageCount: row.imageCount || 0,
    reads: row.reads || {},
  };
}

function emptyPreview(message, account = null) {
  return {
    readOnly: true,
    dryRun: true,
    sentToGini: 0,
    resyncWritesEnabled: giniResyncWritesEnabled(),
    createMethod: GINI_RESYNC_CREATE_METHOD,
    endpoint: GINI_PRODUCTS_PATH,
    putFallback: false,
    previewId: "",
    previewSignature: "",
    expiresAt: null,
    account,
    confirmed: 0,
    stillExisting: 0,
    verifiedMissing: 0,
    eligible: 0,
    blocked: 0,
    reconciliation: 0,
    historical: 0,
    missingEligible: [],
    existingProducts: [],
    blockedProducts: [],
    reconciliationProducts: [],
    provesDeletionFromPortal: false,
    message,
  };
}

async function requireAccount() {
  const connection = await getGiniConnectionPublic();
  if (connection.secretUnreadable) fail(GINI_SECRET_UNREADABLE_MESSAGE, "secret_unreadable", 409);
  if (!connection.clientId || !connection.hasSecret || connection.status !== "connected") {
    fail("Connect GINI API first.", "connection_required", 409);
  }
  const account = accountFrom(connection);
  if (!account.clientId || !account.baseHost) fail("Connect GINI API first.", "connection_required", 409);
  return { connection, account };
}

export async function runGiniResyncPreview() {
  await assertResyncIndexes();
  const { account } = await requireAccount();
  let categories = [];
  let categoryBlockers = [];
  try {
    const live = await fetchGiniCategoryTree();
    if (live.connectionRequired) fail("Connect GINI API first.", "connection_required", 409);
    categories = live.categories || [];
  } catch (err) {
    if (err instanceof GiniResyncError || err instanceof GiniConnectionError) {
      if (err.code === "connection_required" || err.code === "secret_unreadable") throw err;
    }
    categoryBlockers = ["categories_unavailable"];
  }

  const sends = await GiniSyncSendState.find({ partner: "gini" }).sort({ sku: 1 }).lean();
  if (!sends.length) {
    return emptyPreview("No confirmed GINI sends are saved. Nothing was created.", account);
  }
  const productIds = sends.map((row) => row.productId).filter((id) => mongoose.isValidObjectId(String(id || "")));
  const [docs, rules, eligibility, owners] = await Promise.all([
    Product.find({ _id: { $in: productIds } }).lean(),
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    skuOwners(),
  ]);
  const byId = new Map(docs.map((doc) => [String(doc._id), doc]));
  const rows = [];
  let stopCode = "";
  const merchantIds = new Set();

  for (const send of sends) {
    const savedSku = normalizeGiniItemCode(send.sku);
    const doc = byId.get(String(send.productId || "")) || null;
    const resolved = doc ? toResolvedProduct(doc) : null;
    const currentSku = doc ? normalizeGiniItemCode(doc.itemCode) : "";
    const skuKey = giniSkuKey(savedSku);
    const ownerIds = skuKey ? owners.get(skuKey) || [] : [];
    let plan = null;
    let inactive = !doc || resolved?.isActive === false;
    let inactiveReasons = !doc ? [] : resolved?.isActive === false ? ["product_inactive"] : [];
    if (doc && !stopCode) {
      const decision = evaluatePlatformEligibility(doc, eligibility);
      const reasons = (decision.reasons || []).filter((reason) => reason.code !== "taxonomy_config_missing");
      if (reasons.length) {
        inactive = true;
        inactiveReasons = [...inactiveReasons, ...reasons.map((reason) => reason.code)];
      }
      const mapping = categoryBlockers.length
        ? { blockers: categoryBlockers, category: null, subcategory: null }
        : mappingFromTree(taxonomyValuesForProduct(doc, eligibility), categories);
      plan = buildGiniPlanFromParts({
        doc,
        resolved,
        priced: partnerPricePreview(doc, rules),
        duplicateProductIds: ownerIds,
        mapping,
        existing: null,
      });
    } else if (doc && stopCode) {
      plan = null;
    }

    let remote = {
      skuRead: { state: "uncertain", status: 0 },
      idRead: { state: "uncertain", status: 0 },
      search: { state: "uncertain", status: 0, matches: [] },
      assessed: assessGiniResyncRemote({
        savedSku,
        savedGiniProductId: send.giniProductId,
        skuRead: { state: "uncertain", status: 0 },
        idRead: { state: "uncertain", status: 0 },
        search: { state: "uncertain", status: 0, matches: [] },
      }),
    };
    if (!stopCode && savedSku) {
      remote = await verifyRemote(savedSku, send.giniProductId);
      if (["gini_access_forbidden", "gini_edge_blocked", "rate_limited"].includes(remote.assessed.code) && remote.assessed.remoteState === "uncertain") {
        stopCode = remote.assessed.code;
      }
    } else if (stopCode) {
      remote.assessed = {
        remoteState: "uncertain",
        code: stopCode,
        liveGiniProductId: "",
        identityMatched: false,
      };
    }

    for (const read of [remote.skuRead, remote.idRead, ...(remote.search?.matches || [])]) {
      if (read?.merchantId) merchantIds.add(String(read.merchantId));
    }
    const classified = classifyGiniResyncRow({
      savedSku,
      currentSku,
      productFound: Boolean(doc),
      inactive,
      inactiveReasons,
      planBlockers: [...categoryBlockers, ...(plan?.blockers || [])],
      duplicate: !skuKey || ownerIds.length !== 1 || !ownerIds.includes(String(send.productId || "")),
      remote: remote.assessed,
    });
    rows.push({
      sku: savedSku,
      skuKey,
      productId: String(send.productId || ""),
      name: doc ? productName(doc) : "",
      ...classified,
      savedGiniProductId: String(send.giniProductId || ""),
      savedPayloadHash: String(send.payloadHash || ""),
      currentHash: plan ? giniPayloadHash(plan.payloadPreview) : "",
      savedJobId: String(send.jobId || ""),
      savedConfirmedAt: send.confirmedAt || null,
      giniPrice: plan?.giniPrice ?? null,
      quantity: plan?.quantity ?? null,
      imageCount: plan?.imageCount || 0,
      merchantId: remote.skuRead?.merchantId || remote.idRead?.merchantId || "",
      reads: {
        sku: readSummary(remote.skuRead),
        id: readSummary(remote.idRead),
        search: readSummary(remote.search),
      },
    });
  }

  if (merchantIds.size > 1) {
    for (const row of rows) {
      if (!row.merchantId) continue;
      row.classification = "RECONCILIATION";
      row.eligible = false;
      row.locallyEligible = false;
      row.remoteState = row.remoteState === "verified_missing" ? "conflict" : row.remoteState;
      row.code = "account_conflict";
      row.blockers = ["account_conflict"];
      row.reason = resyncReason("account_conflict");
    }
  }

  const signature = giniResyncPreviewSignature(rows, account);
  const expiresAt = new Date(Date.now() + GINI_RESYNC_PREVIEW_TTL_MS);
  const saved = await GiniResyncPreview.create({
    partner: "gini",
    signature,
    expiresAt,
    account,
    rows,
  });
  return presentPreview(saved, account, merchantIds);
}

function presentPreview(snapshot, account, merchantIds = new Set()) {
  const rows = snapshot.rows || [];
  const missingEligible = rows.filter((row) => row.classification === "VERIFIED_MISSING" && row.eligible === true).map(publicRow);
  const existingProducts = rows.filter((row) => row.classification === "EXISTING").map(publicRow);
  const blockedProducts = rows.filter((row) => row.classification === "BLOCKED").map(publicRow);
  const reconciliationProducts = rows.filter((row) => row.classification === "RECONCILIATION").map(publicRow);
  return {
    readOnly: true,
    dryRun: true,
    sentToGini: 0,
    resyncWritesEnabled: giniResyncWritesEnabled(),
    createMethod: GINI_RESYNC_CREATE_METHOD,
    endpoint: GINI_PRODUCTS_PATH,
    putFallback: false,
    previewId: String(snapshot._id),
    previewSignature: snapshot.signature,
    expiresAt: snapshot.expiresAt,
    account: {
      clientId: account?.clientId || snapshot.account?.clientId || "",
      baseHost: account?.baseHost || snapshot.account?.baseHost || "",
      status: account?.status || snapshot.account?.status || "",
      merchantIds: [...merchantIds],
    },
    confirmed: rows.length,
    stillExisting: rows.filter((row) => row.identityMatched === true).length,
    verifiedMissing: rows.filter((row) => row.remoteState === "verified_missing").length,
    eligible: missingEligible.length,
    blocked: blockedProducts.length,
    reconciliation: reconciliationProducts.length,
    historical: rows.filter((row) => row.historical === true).length,
    missingEligible,
    existingProducts,
    blockedProducts,
    reconciliationProducts,
    provesDeletionFromPortal: false,
    message: "Read only. No GINI product was created, updated, or deleted.",
  };
}

async function loadSnapshot({ previewId, previewSignature }) {
  if (!mongoose.isValidObjectId(String(previewId || ""))) fail("Run Re-sync Preview before creating a product.", "preview_required", 409);
  const snapshot = await GiniResyncPreview.findById(previewId);
  if (!snapshot || snapshot.partner !== "gini") fail("Run Re-sync Preview before creating a product.", "preview_required", 409);
  if (!snapshot.expiresAt || new Date(snapshot.expiresAt).getTime() <= Date.now()) {
    fail("This Re-sync Preview expired. Run it again.", "preview_stale", 409);
  }
  const account = snapshot.account || {};
  const signature = giniResyncPreviewSignature(snapshot.rows, account);
  if (!previewSignature || previewSignature !== snapshot.signature || signature !== snapshot.signature) {
    fail("This Re-sync Preview does not match the stored preview.", "preview_mismatch", 409);
  }
  const { account: liveAccount } = await requireAccount();
  if (liveAccount.clientId !== account.clientId || liveAccount.baseHost !== account.baseHost) {
    fail("The GINI merchant account changed. Run Re-sync Preview again.", "preview_stale", 409);
  }
  return { snapshot, account: liveAccount };
}

async function assertNoOtherWriter() {
  const [createJob, updateJob] = await Promise.all([
    GiniSyncJob.findOne({ partner: "gini", status: { $in: ACTIVE_CREATE } }).select("_id").lean(),
    GiniProductUpdateJob.findOne({ partner: "gini", status: { $in: ["running", "paused"] } }).select("_id").lean(),
  ]);
  if (createJob) fail("A GINI create sync is active. Stop it before re-syncing a deleted product.", "sync_active", 409);
  if (updateJob) fail("A GINI update is active. Stop it before re-syncing a deleted product.", "sync_active", 409);
}

function selectedSkus(skus) {
  if (!Array.isArray(skus) || !skus.length) fail("Select the verified-missing SKUs to re-sync.", "selection_required", 400);
  const normalized = skus.map((sku) => normalizeGiniItemCode(sku));
  if (normalized.some((sku) => !sku)) fail("Select the verified-missing SKUs to re-sync.", "invalid_sku", 400);
  if (new Set(normalized.map((sku) => giniSkuKey(sku))).size !== normalized.length) {
    fail("Select each SKU once.", "invalid_sku", 400);
  }
  return normalized;
}

async function acquireLock(skuKey, jobId) {
  try {
    await GiniResyncLock.create({ skuKey, jobId: String(jobId) });
  } catch (err) {
    if (err?.code === 11000) fail("A GINI re-sync is already running for this SKU.", "resync_in_progress", 409);
    throw err;
  }
}

async function releaseLock(skuKey, jobId) {
  await GiniResyncLock.deleteOne({ skuKey, jobId: String(jobId) });
}

async function markJob(jobId, patch) {
  await GiniResyncJob.updateOne({ _id: jobId }, { $set: patch });
  return GiniResyncJob.findById(jobId).lean();
}

async function commitRecreated({ state, audit, newId, currentHash, price, quantity, imageCount }) {
  const previousId = String(state.giniProductId || "");
  const previousHash = String(state.payloadHash || "");
  const patch = {
    giniProductId: String(newId),
    payloadHash: currentHash,
    lastResyncConfirmedAt: new Date(),
    lastResyncAuditId: String(audit._id),
  };
  if (!state.originalGiniProductId) patch.originalGiniProductId = previousId;
  if (!state.createPayloadHash && previousHash) patch.createPayloadHash = previousHash;
  const updated = await GiniSyncSendState.updateOne(
    { _id: state._id, giniProductId: previousId, skuKey: state.skuKey, jobId: state.jobId },
    {
      $set: patch,
      $push: {
        resyncHistory: {
          previousGiniProductId: previousId,
          newGiniProductId: String(newId),
          previousPayloadHash: previousHash,
          payloadHash: currentHash,
          auditId: String(audit._id),
          confirmedAt: new Date(),
        },
      },
    }
  );
  if (!updated.matchedCount) return false;
  try {
    await GiniSyncProductResult.create({
      jobId: audit._id,
      partner: "gini",
      productId: String(state.productId || ""),
      sku: state.sku || "",
      skuKey: state.skuKey,
      classification: "CREATED",
      giniProductId: String(newId),
      giniPrice: price ?? null,
      quantity: quantity ?? null,
      imageCount: imageCount || 0,
      payloadHash: currentHash,
    });
  } catch (err) {
    if (err?.code !== 11000) {
      await GiniResyncAudit.updateOne({ _id: audit._id }, { $set: { errorMessage: safeText(err?.message) } });
    }
  }
  await GiniResyncAudit.updateOne(
    { _id: audit._id },
    {
      $set: {
        status: "confirmed",
        responseGiniProductId: String(newId),
        nextPayloadHash: currentHash,
        errorCode: audit.errorCode || "",
      },
    }
  );
  await releaseLock(state.skuKey, audit.jobId);
  return true;
}

async function currentPlan(doc, owners) {
  const [rules, eligibility, live] = await Promise.all([
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    loadEligibilityContext("gini"),
    fetchGiniCategoryTree(),
  ]);
  if (!live?.categories || live.connectionRequired) return { ok: false, code: "categories_unavailable" };
  const resolved = toResolvedProduct(doc);
  const decision = evaluatePlatformEligibility(doc, eligibility);
  const reasons = (decision.reasons || []).filter((reason) => reason.code !== "taxonomy_config_missing");
  if (!resolved || resolved.isActive === false || reasons.length) return { ok: false, code: "not_resync_eligible" };
  const skuKey = giniSkuKey(doc.itemCode);
  const ownerIds = skuKey ? owners.get(skuKey) || [] : [];
  const plan = buildGiniPlanFromParts({
    doc,
    resolved,
    priced: partnerPricePreview(doc, rules),
    duplicateProductIds: ownerIds,
    mapping: mappingFromTree(taxonomyValuesForProduct(doc, eligibility), live.categories),
    existing: null,
  });
  const blockers = (plan.blockers || []).filter((code) => code !== "existing_gini_product" && code !== "gini_lookup_failed");
  if (blockers.length || !plan.payloadPreview) return { ok: false, code: blockers[0] || "not_resync_eligible" };
  return { ok: true, plan, hash: giniPayloadHash(plan.payloadPreview) };
}

function outcome(sku, fields) {
  return {
    sku,
    ok: Boolean(fields.ok),
    sent: Boolean(fields.sent),
    halt: Boolean(fields.halt),
    code: fields.code || "",
    httpStatus: Number(fields.httpStatus) || 0,
    previousGiniProductId: fields.previousGiniProductId || "",
    giniProductId: fields.giniProductId || "",
    message: fields.message || resyncReason(fields.code || ""),
  };
}

async function sendOne({ sku, row, job, owners }) {
  if (holdBlocks(sku, row?.sku, row?.skuKey)) return blockedHold(sku, { giniProductId: row?.savedGiniProductId || "" });
  const skuKey = giniSkuKey(sku);
  const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey }).lean();
  if (!state || String(state.giniProductId || "") !== String(row.savedGiniProductId || "")) {
    return outcome(sku, { code: "preview_stale", previousGiniProductId: state?.giniProductId || "" });
  }
  const open = await GiniResyncAudit.findOne({
    skuKey,
    requestSent: true,
    status: { $in: OPEN_AUDIT },
  }).lean();
  if (open) return outcome(sku, { code: "resync_uncertain", halt: true, previousGiniProductId: state.giniProductId });

  const doc = mongoose.isValidObjectId(state.productId) ? await Product.findById(state.productId).lean() : null;
  if (!doc || giniSkuKey(doc.itemCode) !== skuKey) {
    return outcome(sku, { code: "not_resync_eligible", previousGiniProductId: state.giniProductId });
  }
  if (holdBlocks(sku, state.sku, doc.itemCode)) return blockedHold(sku, state);
  const planned = await currentPlan(doc, owners);
  if (!planned.ok || planned.hash !== row.currentHash) {
    return outcome(sku, { code: planned.ok ? "preview_stale" : "not_resync_eligible", previousGiniProductId: state.giniProductId });
  }
  const remote = await verifyRemote(sku, state.giniProductId);
  if (remote.assessed.identityMatched || remote.assessed.remoteState === "existing" || remote.assessed.remoteState === "conflict") {
    return outcome(sku, {
      code: remote.assessed.code || "confirmed_local_send",
      previousGiniProductId: state.giniProductId,
      giniProductId: remote.assessed.liveGiniProductId || "",
    });
  }
  if (remote.assessed.remoteState !== "verified_missing") {
    return outcome(sku, { code: remote.assessed.code || "confirmed_send_unverified", halt: true, previousGiniProductId: state.giniProductId });
  }

  await acquireLock(skuKey, job._id);
  const attempt = (await GiniResyncAudit.countDocuments({ skuKey })) + 1;
  const audit = await GiniResyncAudit.create({
    partner: "gini",
    jobId: String(job._id),
    productId: String(state.productId || ""),
    sku,
    skuKey,
    attempt,
    method: GINI_RESYNC_CREATE_METHOD,
    path: GINI_PRODUCTS_PATH,
    previousGiniProductId: String(state.giniProductId || ""),
    previousPayloadHash: String(state.payloadHash || ""),
    nextPayloadHash: planned.hash,
    savedJobId: String(state.jobId || ""),
    savedConfirmedAt: state.confirmedAt || null,
    status: "pending",
    requestSent: false,
  });

  let files = [];
  try {
    const images = planned.plan.payloadPreview?.images || [];
    for (let index = 0; index < images.length; index += 1) {
      files.push(await downloadGiniProductImage(images[index].url, index));
    }
  } catch (err) {
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "failed", errorCode: "invalid_image", errorMessage: safeText(err?.message) } }
    );
    await releaseLock(skuKey, job._id);
    return outcome(sku, { code: "invalid_image", previousGiniProductId: state.giniProductId });
  }

  if (holdBlocks(sku, state.sku, doc.itemCode)) return blockedHold(sku, state, job._id, audit._id);
  if (beforeSend) await beforeSend({ sku, productId: state.productId });
  await GiniResyncAudit.updateOne({ _id: audit._id }, { $set: { requestSent: true } });
  await GiniResyncJob.updateOne({ _id: job._id }, { $set: { requestSent: true } });

  let response;
  try {
    if (GINI_RESYNC_CREATE_METHOD !== "POST") fail("Re-sync create must use POST.", "resync_method_rejected", 500);
    response = await performGiniRequest({ method: "POST", path: GINI_PRODUCTS_PATH, form: buildGiniCreateForm(planned.plan.payloadPreview, files) });
  } catch (err) {
    const lost = await recoverLost(sku, state, audit, planned);
    if (lost) return lost;
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "uncertain", errorCode: "create_uncertain", errorMessage: safeText(err?.message) } }
    );
    return outcome(sku, { code: "create_uncertain", halt: true, sent: true, previousGiniProductId: state.giniProductId, message: resyncReason("create_uncertain") });
  }

  const createdId = confirmedCreateId(response, skuKey);
  if ((response.status === 200 || response.status === 201) && createdId && createdId === String(state.giniProductId)) {
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "failed", httpStatus: response.status, errorCode: "same_id_not_recreated", responseGiniProductId: createdId } }
    );
    await releaseLock(skuKey, job._id);
    return outcome(sku, { code: "same_id_not_recreated", sent: true, httpStatus: response.status, previousGiniProductId: state.giniProductId, giniProductId: createdId });
  }
  if ((response.status === 200 || response.status === 201) && createdId) {
    const verified = await verifyNewProduct(sku, createdId);
    if (verified.ok) {
      const saved = await commitRecreated({
        state,
        audit,
        newId: createdId,
        currentHash: planned.hash,
        price: planned.plan.giniPrice,
        quantity: planned.plan.quantity,
        imageCount: planned.plan.imageCount,
      });
      if (!saved) {
        return outcome(sku, { code: "resync_uncertain", halt: true, sent: true, previousGiniProductId: state.giniProductId, giniProductId: createdId });
      }
      return outcome(sku, {
        ok: true,
        sent: true,
        httpStatus: response.status,
        previousGiniProductId: state.giniProductId,
        giniProductId: createdId,
        message: "GINI confirmed a new product id. The original create record was kept.",
      });
    }
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "uncertain", httpStatus: response.status, errorCode: "create_uncertain", responseGiniProductId: createdId } }
    );
    return outcome(sku, { code: "create_uncertain", halt: true, sent: true, httpStatus: response.status, previousGiniProductId: state.giniProductId, giniProductId: createdId });
  }

  const recovered = await recoverLost(sku, state, audit, planned);
  if (recovered?.ok) return recovered;
  const http = Number(response.status) || 0;
  const uncertain = !http || http >= 500 || http === 429 || response.edgeBlocked || http === 200 || http === 201;
  await GiniResyncAudit.updateOne(
    { _id: audit._id },
    {
      $set: {
        status: uncertain ? "uncertain" : "failed",
        httpStatus: http,
        errorCode: uncertain ? "create_uncertain" : "gini_create_failed",
        errorMessage: safeText(response.safeErrorMessage),
      },
    }
  );
  if (!uncertain) await releaseLock(skuKey, job._id);
  return outcome(sku, {
    code: uncertain ? "create_uncertain" : "gini_create_failed",
    halt: uncertain,
    sent: true,
    httpStatus: http,
    previousGiniProductId: state.giniProductId,
    message: safeText(response.safeErrorMessage) || resyncReason(uncertain ? "create_uncertain" : "gini_create_failed"),
  });
}

async function recoverLost(sku, state, audit, planned) {
  const remote = await verifyRemote(sku, state.giniProductId);
  const liveId = String(remote.assessed.liveGiniProductId || "");
  if (!liveId || liveId === String(state.giniProductId) || remote.assessed.remoteState !== "existing") return null;
  if (remote.assessed.code !== "confirmed_send_id_mismatch") return null;
  const verified = await verifyNewProduct(sku, liveId);
  if (!verified.ok) return null;
  audit.errorCode = "create_recovered_by_sku";
  const saved = await commitRecreated({
    state,
    audit,
    newId: liveId,
    currentHash: planned.hash,
    price: planned.plan.giniPrice,
    quantity: planned.plan.quantity,
    imageCount: planned.plan.imageCount,
  });
  if (!saved) return outcome(sku, { code: "resync_uncertain", halt: true, sent: true, previousGiniProductId: state.giniProductId, giniProductId: liveId });
  await GiniResyncAudit.updateOne({ _id: audit._id }, { $set: { errorCode: "create_recovered_by_sku" } });
  return outcome(sku, {
    ok: true,
    sent: true,
    code: "create_recovered_by_sku",
    previousGiniProductId: state.giniProductId,
    giniProductId: liveId,
    message: "The create response was lost. A new GINI id for this SKU was verified, so no second create was sent.",
  });
}

function resultPayload(job, results) {
  const sentToGini = results.filter((item) => item.sent).length;
  return {
    ok: results.length > 0 && results.every((item) => item.ok),
    sentToGini,
    method: GINI_RESYNC_CREATE_METHOD,
    endpoint: GINI_PRODUCTS_PATH,
    putFallback: false,
    expectedCount: Number(job?.expectedCount) || results.length,
    resyncWritesEnabled: giniResyncWritesEnabled(),
    results,
    job: job
      ? {
          id: String(job._id || ""),
          status: job.status || "",
          sentToGini: Number(job.sentToGini) || sentToGini,
          errorCode: job.errorCode || "",
          errorMessage: job.errorMessage || "",
          startedAt: job.startedAt || null,
          finishedAt: job.finishedAt || null,
        }
      : null,
  };
}

export async function startGiniResync({
  confirm = false,
  previewId = "",
  previewSignature = "",
  skus = null,
  expectedCount = null,
  scope = "",
  all = false,
  authorizeHistorical = false,
} = {}) {
  if (all === true || scope === "all" || scope === "full") {
    fail("Re-sync will not create every confirmed product. Select the SKUs after a fresh preview.", "bulk_resync_refused", 409);
  }
  if (authorizeHistorical === true) {
    fail(resyncReason("historical_sku_hold"), "historical_sku_hold", 409);
  }
  if (confirm !== true) fail("Confirm the selected SKUs after Re-sync Preview.", "confirm_required", 400);
  if (scope !== "one" && scope !== "selected") fail("Choose selected products or one product.", "selection_required", 400);
  const normalized = selectedSkus(skus);
  if (normalized.some((sku) => isGiniHistoricalHoldSku(sku))) {
    fail(resyncReason("historical_sku_hold"), "historical_sku_hold", 409);
  }
  if (!giniResyncWritesEnabled()) fail("GINI re-sync writes are disabled.", "resync_writes_disabled", 409);
  const count = Number(expectedCount);
  if (!Number.isInteger(count) || count !== normalized.length) {
    fail("Confirm the exact number of selected SKUs.", "confirm_required", 400);
  }
  if (scope === "one" && normalized.length !== 1) fail("The one-product re-sync accepts one SKU.", "single_product_required", 400);
  await assertResyncIndexes();

  const { snapshot } = await loadSnapshot({ previewId, previewSignature });
  await assertNoOtherWriter();
  const chosen = [];
  for (const sku of normalized) {
    const row = (snapshot.rows || []).find((item) => giniSkuKey(item.sku) === giniSkuKey(sku));
    if (holdBlocks(sku, row?.sku, row?.skuKey)) fail(resyncReason("historical_sku_hold"), "historical_sku_hold", 409);
    if (!resyncRowCanSend(row)) {
      const code = row?.code || "not_resync_eligible";
      fail(resyncReason(code), code, 409);
    }
    chosen.push(row);
  }
  const open = await GiniResyncAudit.find({
    skuKey: { $in: chosen.map((row) => row.skuKey) },
    requestSent: true,
    status: { $in: OPEN_AUDIT },
  }).lean();
  if (open.length) fail("A previous re-sync response is unverified. Reconcile it before sending again.", "resync_uncertain", 409);

  const job = await GiniResyncJob.create({
    partner: "gini",
    status: "running",
    previewId: String(snapshot._id),
    previewSignature: String(previewSignature),
    scope,
    expectedCount: count,
    skus: normalized,
    requestSent: false,
    sentToGini: 0,
    startedAt: new Date(),
  });
  try {
    await acquireLock(BATCH_LOCK, job._id);
  } catch (err) {
    await markJob(job._id, {
      status: "failed",
      finishedAt: new Date(),
      errorCode: err?.code || "resync_in_progress",
      errorMessage: safeText(err?.message),
    });
    throw err;
  }

  const results = [];
  try {
    const owners = await skuOwners();
    let halted = false;
    for (let index = 0; index < chosen.length; index += 1) {
      const row = chosen[index];
      if (halted) {
        results.push(outcome(row.sku, { code: "not_sent", previousGiniProductId: row.savedGiniProductId, message: "Not sent because an earlier response was unverified." }));
        continue;
      }
      const result = await sendOne({ sku: normalized[index], row, job, owners });
      results.push(result);
      if (result.halt) halted = true;
    }
    const sentToGini = results.filter((item) => item.sent).length;
    const uncertain = results.some((item) => item.halt);
    const finished = await markJob(job._id, {
      status: uncertain ? "uncertain" : "completed",
      sentToGini,
      results,
      finishedAt: new Date(),
      errorCode: uncertain ? "create_uncertain" : "",
    });
    return resultPayload(finished, results);
  } catch (err) {
    await markJob(job._id, {
      status: "failed",
      finishedAt: new Date(),
      results,
      errorCode: err?.code || "gini_resync_error",
      errorMessage: safeText(err?.message),
    });
    throw err;
  } finally {
    await releaseLock(BATCH_LOCK, job._id);
  }
}

export async function reconcileGiniResync({ confirm = false, sku = "" } = {}) {
  if (confirm !== true) fail("Confirm the read-only reconciliation.", "confirm_required", 400);
  await assertResyncIndexes();
  const normalized = normalizeGiniItemCode(sku);
  const skuKey = giniSkuKey(normalized);
  if (!normalized || !skuKey) fail("Choose one SKU to reconcile.", "invalid_sku", 400);
  await requireAccount();
  const running = await GiniResyncJob.findOne({ partner: "gini", status: "running" }).select("_id").lean();
  if (running) fail("A GINI re-sync is running.", "resync_in_progress", 409);
  const state = await GiniSyncSendState.findOne({ partner: "gini", skuKey }).lean();
  if (!state?.giniProductId) fail("This SKU has no confirmed GINI send.", "confirmed_send_missing", 404);
  const remote = await verifyRemote(normalized, state.giniProductId);
  const audit = await GiniResyncAudit.findOne({ skuKey, requestSent: true, status: { $in: OPEN_AUDIT } }).sort({ createdAt: -1 });
  const base = {
    ok: true,
    sentToGini: 0,
    method: "GET",
    endpoint: GINI_PRODUCTS_PATH,
    putFallback: false,
    sku: normalized,
    previousGiniProductId: String(state.giniProductId || ""),
    remoteState: remote.assessed.remoteState,
    code: remote.assessed.code,
    giniProductId: remote.assessed.liveGiniProductId || "",
    reconciled: false,
    message: "Read only. No product was created.",
  };
  if (!audit) return base;

  const history = `read:${remote.assessed.remoteState}`;
  if (remote.assessed.remoteState === "verified_missing") {
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "reconciled_absent", errorCode: "confirmed_send_missing" }, $push: { reconcileHistory: history } }
    );
    await GiniResyncLock.deleteOne({ skuKey });
    return {
      ...base,
      reconciled: true,
      code: "reconciled_absent",
      message: "GINI still does not return this SKU or the saved id. The saved send was kept and no create was sent.",
    };
  }
  if (remote.assessed.remoteState === "existing" && remote.assessed.code === "confirmed_send_id_mismatch") {
    const liveId = String(remote.assessed.liveGiniProductId || "");
    const verified = liveId ? await verifyNewProduct(normalized, liveId) : { ok: false };
    if (verified.ok && liveId !== String(state.giniProductId)) {
      const doc = mongoose.isValidObjectId(state.productId) ? await Product.findById(state.productId).lean() : null;
      const owners = await skuOwners();
      const planned = doc ? await currentPlan(doc, owners) : { ok: false };
      if (planned.ok) {
        audit.errorCode = "create_recovered_by_sku";
        const saved = await commitRecreated({
          state,
          audit,
          newId: liveId,
          currentHash: planned.hash,
          price: planned.plan.giniPrice,
          quantity: planned.plan.quantity,
          imageCount: planned.plan.imageCount,
        });
        if (saved) {
          return {
            ...base,
            reconciled: true,
            ok: true,
            code: "create_recovered_by_sku",
            giniProductId: liveId,
            message: "The earlier create response was lost. The new GINI id was verified by reading it back. No second create was sent.",
          };
        }
      }
    }
  }
  if (remote.assessed.identityMatched) {
    await GiniResyncAudit.updateOne(
      { _id: audit._id },
      { $set: { status: "still_present", errorCode: "confirmed_local_send" }, $push: { reconcileHistory: history } }
    );
    await GiniResyncLock.deleteOne({ skuKey });
    return {
      ...base,
      reconciled: true,
      code: "still_present",
      message: "The saved GINI product is still present. Nothing was created.",
    };
  }
  await GiniResyncAudit.updateOne({ _id: audit._id }, { $push: { reconcileHistory: history } });
  return {
    ...base,
    code: "confirmed_send_unverified",
    message: "GINI still did not confirm this SKU. The re-sync lock was kept and no create was sent.",
  };
}

export async function getLatestGiniResyncJob() {
  const job = await GiniResyncJob.findOne({ partner: "gini" }).sort({ createdAt: -1 }).lean();
  if (!job) return { job: null, sentToGini: 0, resyncWritesEnabled: giniResyncWritesEnabled() };
  return {
    ...resultPayload(job, Array.isArray(job.results) ? job.results : []),
    resyncWritesEnabled: giniResyncWritesEnabled(),
  };
}
