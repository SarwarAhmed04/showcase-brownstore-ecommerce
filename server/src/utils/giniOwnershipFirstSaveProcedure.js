import { giniSkuKey } from "./giniSyncOnePlan.js";
import {
  OWNERSHIP_SAVE_EXCLUDED,
  OWNERSHIP_SAVE_INDEXES_READY,
  OWNERSHIP_SAVE_PILOT,
  OWNERSHIP_SAVE_RELEASED,
  ownershipSaveAuthorization,
} from "./giniVariantOwnershipAudit.js";

const SOURCE_FILE = "server/src/utils/giniVariantOwnershipAudit.js";
const SNAPSHOT_MS = 15 * 60 * 1000;

function gateState(env = process.env) {
  const authorization = ownershipSaveAuthorization(env);
  return [
    {
      name: "OWNERSHIP_SAVE_RELEASED",
      kind: "source",
      location: `${SOURCE_FILE} export const OWNERSHIP_SAVE_RELEASED`,
      openWhen: "the loaded module value is exactly true",
      open: authorization.released === true,
      closedValue: false,
    },
    {
      name: "OWNERSHIP_SAVE_INDEXES_READY",
      kind: "source",
      location: `${SOURCE_FILE} export const OWNERSHIP_SAVE_INDEXES_READY`,
      openWhen: "the loaded module value is exactly true",
      open: authorization.indexesReady === true,
      closedValue: false,
    },
    {
      name: "GINI_VARIANT_OWNERSHIP_SAVE_ENABLED",
      kind: "environment",
      location: "environment of the running API process; absent from server/.env and server/.env.example",
      openWhen: "the process value is the string true",
      open: authorization.explicitGate === true,
      closedValue: "unset",
    },
    {
      name: "GINI_ALLOW_OWNERSHIP_SAVE",
      kind: "environment",
      location: "environment of the running API process; absent from server/.env and server/.env.example",
      openWhen: "the process value is the string true",
      open: authorization.allowGate === true,
      closedValue: "unset",
    },
  ];
}

/**
 * The live save may describe this pair only.
 * Any other candidate count, vendor, product, or source item is refused.
 */
export function firstLivePairDecision(candidates = []) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (rows.length !== 2) return "pilot_not_authorized";
  const owner = rows.find((row) => String(row?.productId || "") === OWNERSHIP_SAVE_PILOT.productId);
  const excluded = rows.find((row) => String(row?.productId || "") === OWNERSHIP_SAVE_EXCLUDED.productId);
  if (!owner || !excluded || owner === excluded) return "pilot_not_authorized";
  const ownerMatches = String(owner.vendor || "") === OWNERSHIP_SAVE_PILOT.vendorName
    && String(owner.sourceItemId || "") === OWNERSHIP_SAVE_PILOT.sourceItemId
    && giniSkuKey(owner.parentSku) === giniSkuKey(OWNERSHIP_SAVE_PILOT.parentSku);
  const excludedMatches = String(excluded.vendor || "") === OWNERSHIP_SAVE_EXCLUDED.vendorName
    && String(excluded.sourceItemId || "") === OWNERSHIP_SAVE_EXCLUDED.sourceItemId
    && giniSkuKey(excluded.parentSku) === giniSkuKey(OWNERSHIP_SAVE_EXCLUDED.parentSku);
  if (!ownerMatches || !excludedMatches) return "pilot_not_authorized";
  return "";
}

export function firstLiveInsertAllowed(documents) {
  const owner = documents?.owner;
  const operation = documents?.operation;
  const excluded = operation?.excludedProductIds || [];
  if (!owner || !operation) return false;
  if (owner.status !== "approved" || owner.giniProductId) return false;
  if (operation.status !== "recorded") return false;
  if (String(owner.productId || "") !== OWNERSHIP_SAVE_PILOT.productId) return false;
  if (String(owner.vendorId || "") === "") return false;
  if (giniSkuKey(owner.parentSku) !== giniSkuKey(OWNERSHIP_SAVE_PILOT.parentSku)) return false;
  if (String(operation.productId || "") !== OWNERSHIP_SAVE_PILOT.productId) return false;
  if (String(operation.sourceItemId || "") !== OWNERSHIP_SAVE_PILOT.sourceItemId) return false;
  if (excluded.length !== 1 || excluded[0] !== OWNERSHIP_SAVE_EXCLUDED.productId) return false;
  return true;
}

/**
 * Describes the first live ownership save.
 * Calling this does not open a gate, write MongoDB, or send anything to GINI.
 */
export function describeFirstLiveOwnershipSaveAuthorization(env = process.env) {
  const gates = gateState(env);
  const authorization = ownershipSaveAuthorization(env);
  return {
    phase: "prepared_not_authorized",
    execute: false,
    authorized: false,
    writesPermitted: false,
    enabled: authorization.enabled === true,
    anyGateOpen: gates.some((gate) => gate.open === true),
    gates,
    snapshotTtlMs: SNAPSHOT_MS,
    binding: {
      parentSku: OWNERSHIP_SAVE_PILOT.parentSku,
      productId: OWNERSHIP_SAVE_PILOT.productId,
      sourceItemId: OWNERSHIP_SAVE_PILOT.sourceItemId,
      vendorName: OWNERSHIP_SAVE_PILOT.vendorName,
      excluded: {
        parentSku: OWNERSHIP_SAVE_EXCLUDED.parentSku,
        productId: OWNERSHIP_SAVE_EXCLUDED.productId,
        sourceItemId: OWNERSHIP_SAVE_EXCLUDED.sourceItemId,
        vendorName: OWNERSHIP_SAVE_EXCLUDED.vendorName,
        deletedFromBrownStore: false,
      },
    },
    allowedWrites: [
      {
        collection: "ginivariantparentowners",
        count: 1,
        status: "approved",
        giniProductId: "",
      },
      {
        collection: "ginivariantownershipoperations",
        count: 1,
        status: "recorded",
      },
    ],
    forbidden: [
      "other_parent_sku",
      "other_vendor",
      "jawal_flex_delete",
      "variant_sku_approval",
      "stock_merge",
      "price_update",
      "gini_send",
      "remote_verified_status",
      "sed",
      "source_backup_file",
    ],
    rollback: {
      executed: false,
      method: "git-restore-recorded-sha",
      createsBackupFile: false,
      usesSed: false,
      note: "Record git rev-parse HEAD while the working tree is clean and both source locks are false. Restore that commit's copy of the audit file. Do not copy the file to a backup path.",
    },
    open: {
      executed: false,
      note: "Do not run these steps until a separate authorization says to open the first pilot.",
      steps: [
        "On the Hostinger checkout that serves the API, record branch main, git rev-parse HEAD, and an empty git status --porcelain. Refuse a dirty tree or any SHA other than that clean closed commit.",
        "Confirm the loaded and on-disk locks: OWNERSHIP_SAVE_RELEASED false, OWNERSHIP_SAVE_INDEXES_READY false, and both environment gates unset. Confirm brownstore on 127.0.0.1, owner count 0, operation count 0, conflicts 0, the three unique indexes, one API process, the production backup, and both product updatedAt values.",
        "Open the two source locks only with the exact line-replace program. It changes false to true on those two lines and does not create a backup file. Do not use sed. Do not commit the edit and do not deploy.",
        "Set GINI_VARIANT_OWNERSHIP_SAVE_ENABLED and GINI_ALLOW_OWNERSHIP_SAVE to the string true on that one API process only. Do not write either name into server/.env or server/.env.example.",
        "Restart that one API process so the source locks and environment gates load together. Do not leave a second API process running.",
        "The same administrator POSTs /api/admin/platforms/gini/variant-sync/ownership/preview for parentSku 38104 and product 6adf9ca49dedbaa3dd573cce with confirm true. A snapshot from before this restart is dead.",
        "Accept the preview only when productionReview.verified is true, liveIndexesReady is true, selected.vendor is IT Lobby, selected.sourceItemId is 6adf9824ef43bcf3ec7d1ee4, and the excluded product is Jawal Flex 6ae08bbd9dedbaa3dd5740d9.",
        "Within 15 minutes, that same authenticated administrator presses Save ownership in the dashboard. The button stays disabled until all four gates, the fresh snapshot, and that confirmation are valid. The route uses req.user._id and ignores any administrator id in the body.",
      ],
    },
    close: {
      executed: false,
      note: "The armed API window and its separate supervisor close the gates on success, failure, timeout, or an interrupted process. Run the checks below after that automatic close, and run them by hand if the supervisor has not finished.",
      steps: [
        "Confirm the recorded SHA still contains both source locks set to false. Then git restore --source that SHA -- server/src/utils/giniVariantOwnershipAudit.js. Do not look for a backup file.",
        "Remove GINI_VARIANT_OWNERSHIP_SAVE_ENABLED and GINI_ALLOW_OWNERSHIP_SAVE from the API process environment.",
        "Restart the one API process. The in-memory preview snapshot dies on restart, and the source locks load closed.",
        "POST the save route again. It must return 409 ownership_save_disabled with saved false, sentToGini 0, and databaseRechecked false.",
        "Run the read-only verification below before any further ownership work.",
      ],
    },
    failure: [
      { code: "ownership_save_disabled", action: "Safe stop. At least one gate is closed. Do not retry the save." },
      { code: "ownership_window_closed", action: "Safe stop. The 15-minute window is closed or was never armed. Do not open the gates again under this authorization." },
      { code: "production_context_unverified", action: "Safe stop. Run a new preview in this API process. A restarted process, a CLI snapshot, or a snapshot pasted from another process cannot authorize the save." },
      { code: "production_snapshot_expired", action: "Safe stop. The 15-minute snapshot is dead. Run a new preview. Do not extend the old snapshot." },
      { code: "snapshot_admin_mismatch", action: "Safe stop. The signed-in administrator differs from the preview. That same person must preview again and save." },
      { code: "approval_required", action: "Safe stop. The request lacked confirm, confirmOwnershipSave, or the authenticated administrator." },
      { code: "pilot_not_authorized", action: "Safe stop. The SKU, vendor, product, source item, or candidate pair is outside IT Lobby 38104 and Jawal Flex. Do not widen the binding." },
      { code: "ownership_indexes_not_ready", action: "Safe stop. Do not create or drop indexes from this procedure." },
      { code: "conflicting_owner", action: "Safe stop. Do not overwrite an existing owner." },
      { code: "owner_already_approved", action: "Safe stop. A different approved owner is present. Do not replace it." },
      { code: "owner_already_verified", action: "Safe stop. Do not downgrade or replace a verified owner." },
      { code: "stale_identity", action: "Safe stop. Product, vendor, or source item changed after the preview. Run a new preview." },
      { code: "ownership_save_failed", action: "No owner document was inserted. Close the gates, then inspect the database with the read-only checks." },
      { code: "ownership_operation_incomplete", action: "The approved owner insert succeeded and the operation insert did not. Do not delete the owner and do not insert a second owner. If the same snapshot is still unexpired, the same administrator may repeat the save once so only the missing operation is inserted. Then close the gates." },
      { code: "audit_incomplete", action: "The owner insert succeeded and the operation row conflicts. Close the gates. Do not delete either row in this procedure." },
      { code: "ownership_already_recorded", action: "The approved owner and recorded operation already match. No new document is inserted. Close the gates." },
      { code: "index_conflict", action: "A unique index blocked a different owner or operation. Close the gates. Do not drop the index." },
      { code: "concurrent_request_refused", action: "Safe stop. Another save is in flight or a second request arrived. Do not open a second window." },
      { code: "run_already_used", action: "Safe stop. This single-use window was already consumed. Do not open the gates again under this authorization." },
      { code: "source_lock_not_exact", action: "Safe stop. The two source lines are not the expected closed or open lines. Do not edit further. Restore the recorded SHA." },
      { code: "recorded_sha_mismatch", action: "Safe stop. Do not restore HEAD and do not look for a backup file. Restore only the recorded SHA after its closed lock lines are confirmed." },
    ],
    verification: [
      "ginivariantparentowners has one row for skuKey 38104: productId 6adf9ca49dedbaa3dd573cce, status approved, giniProductId empty.",
      "ginivariantownershipoperations has one row for skuKey 38104: status recorded, sourceItemId 6adf9824ef43bcf3ec7d1ee4, excludedProductIds [6ae08bbd9dedbaa3dd5740d9].",
      "No owner or operation row for any other skuKey was added during the window. Compare the pre-save counts.",
      "products still contains Jawal Flex 6ae08bbd9dedbaa3dd5740d9 with source item 6adf9cf4ef43bcf3ec7daac1, and both product updatedAt values are unchanged.",
      "The save response has sentToGini 0, canSend false, approvesVariantSkus false, and mergesStock false.",
      "All four gates report open false, and a later save returns ownership_save_disabled.",
    ],
    safeStop: [
      "Leave OWNERSHIP_SAVE_RELEASED and OWNERSHIP_SAVE_INDEXES_READY false.",
      "Leave both environment gates unset.",
      "Do not restart the API with those gates present.",
      "Do not call the save route.",
      "Do not write to Production MongoDB.",
      "Do not use sed and do not copy the audit file to a backup path.",
    ],
    sourceReleased: OWNERSHIP_SAVE_RELEASED === true,
    sourceIndexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
  };
}

const LOCK_KEYS = ["OWNERSHIP_SAVE_RELEASED", "OWNERSHIP_SAVE_INDEXES_READY"];

export const CLOSED_LOCK_LINES = Object.freeze({
  OWNERSHIP_SAVE_RELEASED: "export const OWNERSHIP_SAVE_RELEASED = false;",
  OWNERSHIP_SAVE_INDEXES_READY: "export const OWNERSHIP_SAVE_INDEXES_READY = false;",
});

export const OPEN_LOCK_LINES = Object.freeze({
  OWNERSHIP_SAVE_RELEASED: "export const OWNERSHIP_SAVE_RELEASED = true;",
  OWNERSHIP_SAVE_INDEXES_READY: "export const OWNERSHIP_SAVE_INDEXES_READY = true;",
});

export const FIRST_LIVE_AUDIT_FILE = SOURCE_FILE;

function lineCount(text, line) {
  return String(text || "").split(/\r?\n/).filter((row) => row === line).length;
}

/**
 * Replaces the two source-lock lines and no other bytes.
 * It does not write a file, create a backup, or open a gate by itself.
 */
export function rewriteOwnershipSourceLocks(text, mode) {
  const from = mode === "open" ? CLOSED_LOCK_LINES : mode === "close" ? OPEN_LOCK_LINES : null;
  const to = mode === "open" ? OPEN_LOCK_LINES : mode === "close" ? CLOSED_LOCK_LINES : null;
  if (!from || !to) return { ok: false, code: "source_lock_not_exact", text };
  for (const key of LOCK_KEYS) {
    if (lineCount(text, from[key]) !== 1 || lineCount(text, to[key]) !== 0) {
      return { ok: false, code: "source_lock_not_exact", text };
    }
  }
  let next = String(text);
  for (const key of LOCK_KEYS) next = next.replace(from[key], to[key]);
  return { ok: true, code: "", text: next };
}

export function hostingerOpenSourceProgram() {
  const pairs = LOCK_KEYS.map((key) => [CLOSED_LOCK_LINES[key], OPEN_LOCK_LINES[key]]);
  return `import fs from "node:fs";
const file = ${JSON.stringify(FIRST_LIVE_AUDIT_FILE)};
const pairs = ${JSON.stringify(pairs)};
const text = fs.readFileSync(file, "utf8");
let next = text;
for (const [from, to] of pairs) {
  const hits = next.split(from).length - 1;
  if (hits !== 1 || next.includes(to)) {
    console.error("source_lock_not_exact");
    process.exit(2);
  }
  next = next.replace(from, to);
}
fs.writeFileSync(file, next);
console.log("source_locks_written_not_loaded");
`;
}

export function hostingerRollbackCommand(recordedSha) {
  if (!/^[0-9a-f]{40}$/.test(String(recordedSha || ""))) {
    return { ok: false, code: "git_sha_missing", command: "", createsBackupFile: false, usesSed: false };
  }
  return {
    ok: true,
    code: "",
    command: `git restore --source=${recordedSha} -- ${FIRST_LIVE_AUDIT_FILE}`,
    closedLineChecks: LOCK_KEYS.map((key) => `git grep -F -n ${JSON.stringify(CLOSED_LOCK_LINES[key])} ${recordedSha} -- ${FIRST_LIVE_AUDIT_FILE}`),
    createsBackupFile: false,
    usesSed: false,
  };
}

export function assessFirstLivePreflight(observed = {}) {
  const failures = [];
  const sha = String(observed.gitSha || "");
  if (!/^[0-9a-f]{40}$/.test(sha)) failures.push("git_sha_missing");
  if (String(observed.branch || "") !== "main") failures.push("branch_not_main");
  if (String(observed.porcelain || "") !== "") failures.push("working_tree_dirty");
  if (observed.auditMatchesHead !== true) failures.push("audit_file_differs_from_head");
  if (observed.releasedLine !== CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED) failures.push("release_lock_not_closed");
  if (observed.indexesLine !== CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY) failures.push("index_lock_not_closed");
  if (String(observed.envEnabled ?? "") === "true") failures.push("environment_gate_open");
  if (String(observed.envAllow ?? "") === "true") failures.push("allow_gate_open");
  if (observed.databaseName !== "brownstore") failures.push("database_name");
  if (!["127.0.0.1", "localhost", "::1"].includes(String(observed.mongoHost || ""))) failures.push("mongo_host");
  if (observed.ownerCount !== 0) failures.push("owner_count");
  if (observed.operationCount !== 0) failures.push("operation_count");
  if (observed.conflicts !== 0) failures.push("conflicts");
  if (observed.liveIndexesReady !== true) failures.push("live_indexes");
  if (observed.backupCompleted !== true) failures.push("backup_missing");
  if (observed.singleApiProcess !== true) failures.push("api_process_count");
  if (!observed.itLobbyUpdatedAt || !observed.jawalUpdatedAt) failures.push("updated_at_baseline_missing");
  if (String(observed.itLobbyProductId || "") !== OWNERSHIP_SAVE_PILOT.productId) failures.push("product_id");
  if (String(observed.itLobbySourceItemId || "") !== OWNERSHIP_SAVE_PILOT.sourceItemId) failures.push("source_item");
  if (String(observed.itLobbyVendor || "") !== OWNERSHIP_SAVE_PILOT.vendorName) failures.push("vendor");
  if (String(observed.jawalProductId || "") !== OWNERSHIP_SAVE_EXCLUDED.productId) failures.push("excluded_product");
  if (String(observed.jawalSourceItemId || "") !== OWNERSHIP_SAVE_EXCLUDED.sourceItemId) failures.push("excluded_source");
  if (observed.jawalPresent !== true) failures.push("jawal_missing");
  if (observed.inFlight === true) failures.push("concurrent_request_refused");
  return {
    ok: failures.length === 0,
    failures,
    execute: false,
    writesPermitted: false,
    authorizedToRunNow: false,
    recordedSha: failures.includes("git_sha_missing") ? "" : sha,
  };
}

export function planEmergencyStop({
  recordedSha = "",
  releasedLine = "",
  indexesLine = "",
} = {}) {
  const rollback = hostingerRollbackCommand(recordedSha);
  if (!rollback.ok) {
    return {
      execute: false,
      code: "recorded_sha_mismatch",
      restore: false,
      command: "",
      closedLineChecks: [],
      createsBackupFile: false,
      usesSed: false,
      then: ["Do not copy a backup file into place. Stop and keep the gates closed."],
    };
  }
  const closed = releasedLine === CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED
    && indexesLine === CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY;
  return {
    execute: false,
    code: closed ? "confirm_closed_then_restart" : "restore_recorded_sha",
    restore: closed !== true,
    command: rollback.command,
    closedLineChecks: rollback.closedLineChecks,
    createsBackupFile: false,
    usesSed: false,
    then: [
      "Remove GINI_VARIANT_OWNERSHIP_SAVE_ENABLED and GINI_ALLOW_OWNERSHIP_SAVE from the API process environment. Leave server/.env unchanged.",
      "Restart the one API process without those two names.",
      "POST /api/admin/platforms/gini/variant-sync/ownership/save and require HTTP 409, code ownership_save_disabled, saved false, sentToGini 0, and databaseRechecked false.",
    ],
  };
}

export function planHostingerFirstLive(observed = {}) {
  const preflight = assessFirstLivePreflight(observed);
  const rollback = hostingerRollbackCommand(preflight.recordedSha);
  const emergencyStop = planEmergencyStop({
    recordedSha: preflight.recordedSha,
    releasedLine: observed.releasedLine,
    indexesLine: observed.indexesLine,
  });
  if (!preflight.ok) {
    return {
      phase: "refused",
      execute: false,
      authorizedToRunNow: false,
      writesPermitted: false,
      failures: preflight.failures,
      recordedSha: preflight.recordedSha,
      openProgram: "",
      rollback,
      emergencyStop,
      forbiddenMethods: ["sed", "source-backup-file", ".bak"],
    };
  }
  return {
    phase: "planned_not_started",
    execute: false,
    authorizedToRunNow: false,
    writesPermitted: false,
    failures: [],
    recordedSha: preflight.recordedSha,
    editMethod: "exact-line-replace",
    rollbackMethod: "git-restore-recorded-sha",
    singleUse: true,
    forbiddenMethods: ["sed", "source-backup-file", ".bak"],
    openProgram: hostingerOpenSourceProgram(),
    rollback,
    emergencyStop,
    previewBody: {
      parentSku: OWNERSHIP_SAVE_PILOT.parentSku,
      productId: OWNERSHIP_SAVE_PILOT.productId,
      confirm: true,
    },
  };
}

export function acceptFirstLivePreview(body = {}) {
  const selected = body?.selected || {};
  const excluded = Array.isArray(body?.excluded) ? body.excluded : [];
  const snapshot = body?.authorizationSnapshot || null;
  if (body?.productionReview?.verified !== true) return "production_context_unverified";
  if (body?.productionReview?.liveIndexesReady !== true) return "ownership_indexes_not_ready";
  if (body?.code !== "selection_prepared_not_saved") return body?.code || "pilot_not_authorized";
  if (Number(body?.sentToGini) !== 0 || body?.saved !== false) return "gini_send";
  if (selected.vendor !== OWNERSHIP_SAVE_PILOT.vendorName) return "pilot_not_authorized";
  if (selected.productId !== OWNERSHIP_SAVE_PILOT.productId) return "pilot_not_authorized";
  if (selected.sourceItemId !== OWNERSHIP_SAVE_PILOT.sourceItemId) return "pilot_not_authorized";
  if (!snapshot?.id || !snapshot.administratorId) return "approval_required";
  if (snapshot.productId !== OWNERSHIP_SAVE_PILOT.productId || snapshot.sourceItemId !== OWNERSHIP_SAVE_PILOT.sourceItemId) return "pilot_not_authorized";
  if (snapshot.vendorId !== selected.vendorId) return "pilot_not_authorized";
  if (excluded.length !== 1) return "pilot_not_authorized";
  if (excluded[0]?.productId !== OWNERSHIP_SAVE_EXCLUDED.productId) return "pilot_not_authorized";
  if (excluded[0]?.vendor !== OWNERSHIP_SAVE_EXCLUDED.vendorName) return "pilot_not_authorized";
  if (excluded[0]?.sourceItemId !== OWNERSHIP_SAVE_EXCLUDED.sourceItemId) return "pilot_not_authorized";
  if (excluded[0]?.deletedFromBrownStore !== false) return "jawal_flex_delete";
  return "";
}

export function firstLiveSaveBody(preview) {
  if (acceptFirstLivePreview(preview) !== "") return null;
  return {
    parentSku: OWNERSHIP_SAVE_PILOT.parentSku,
    productId: preview.selected.productId,
    vendorId: preview.selected.vendorId,
    sourceItemId: preview.selected.sourceItemId,
    snapshotId: preview.authorizationSnapshot.id,
    confirm: true,
    confirmOwnershipSave: true,
  };
}

export function decideSingleUse({ inFlight = false, ownerCount = 0, operationCount = 0, consumed = false } = {}) {
  if (inFlight === true) return { ok: false, code: "concurrent_request_refused" };
  if (consumed === true) return { ok: false, code: "run_already_used" };
  if (ownerCount !== 0 || operationCount !== 0) return { ok: false, code: "conflicting_owner" };
  return { ok: true, code: "" };
}

export function verifyFirstLiveEvidence(before = {}, after = {}, response = {}) {
  const failures = [];
  if (Number(response?.sentToGini) !== 0) failures.push("sent_to_gini");
  if (response?.saved !== true || response?.code !== "ownership_recorded") failures.push("save_response");
  if (response?.canSend !== false) failures.push("can_send");
  if (response?.approvesVariantSkus !== false) failures.push("variant_sku_approval");
  if (response?.mergesStock !== false) failures.push("stock_merge");
  if (response?.publishesToGini !== false) failures.push("gini_send");
  if (after?.ownerCount !== 1) failures.push("owner_count");
  if (after?.operationCount !== 1) failures.push("operation_count");
  const owner = after?.owner || {};
  if (owner.productId !== OWNERSHIP_SAVE_PILOT.productId) failures.push("owner_product");
  if (owner.status !== "approved") failures.push("owner_status");
  if (String(owner.giniProductId || "") !== "") failures.push("gini_product_id");
  if (giniSkuKey(owner.parentSku || owner.skuKey) !== giniSkuKey(OWNERSHIP_SAVE_PILOT.parentSku)) failures.push("owner_sku");
  const operation = after?.operation || {};
  if (operation.status !== "recorded") failures.push("operation_status");
  if (operation.productId !== OWNERSHIP_SAVE_PILOT.productId) failures.push("operation_product");
  if (operation.sourceItemId !== OWNERSHIP_SAVE_PILOT.sourceItemId) failures.push("operation_source");
  const excluded = operation.excludedProductIds || [];
  if (excluded.length !== 1 || excluded[0] !== OWNERSHIP_SAVE_EXCLUDED.productId) failures.push("excluded");
  if (after?.jawalPresent !== true) failures.push("jawal_missing");
  if (after?.jawalSourceItemId !== OWNERSHIP_SAVE_EXCLUDED.sourceItemId) failures.push("jawal_source");
  if (after?.jawalVendor !== OWNERSHIP_SAVE_EXCLUDED.vendorName) failures.push("jawal_vendor");
  if (!before?.itLobbyUpdatedAt || after?.itLobbyUpdatedAt !== before.itLobbyUpdatedAt) failures.push("it_lobby_updated_at");
  if (!before?.jawalUpdatedAt || after?.jawalUpdatedAt !== before.jawalUpdatedAt) failures.push("jawal_updated_at");
  if (Number(after?.otherSkuOwnerDelta) !== 0 || Number(after?.otherSkuOperationDelta) !== 0) failures.push("other_sku");
  if (after?.gatesClosed !== true) failures.push("gates_open");
  if (after?.disabledSave?.code !== "ownership_save_disabled" || Number(after?.disabledSave?.sentToGini) !== 0) failures.push("gates_not_reclosed");
  return { ok: failures.length === 0, failures };
}

const EVIDENCE_MUTATION = /\.(updateOne|updateMany|deleteOne|deleteMany|insertOne|insertMany|replaceOne|findOneAndUpdate|findOneAndDelete|findOneAndReplace|bulkWrite|drop)\(|\bcreateIndex\b|\bdropDatabase\b/;

export function hostingerReadOnlyEvidenceScript() {
  return `const IT = ${JSON.stringify(OWNERSHIP_SAVE_PILOT.productId)};
const JAWAL = ${JSON.stringify(OWNERSHIP_SAVE_EXCLUDED.productId)};
const owners = db.ginivariantparentowners.find({ skuKey: "38104" }, { productId: 1, skuKey: 1, parentSku: 1, status: 1, giniProductId: 1, vendorId: 1 }).toArray();
const operations = db.ginivariantownershipoperations.find({ skuKey: "38104" }, { productId: 1, skuKey: 1, sourceItemId: 1, status: 1, excludedProductIds: 1 }).toArray();
const products = db.products.find({ _id: { $in: [ObjectId(IT), ObjectId(JAWAL)] } }, { updatedAt: 1, ibsherId: 1, itemCode: 1, createdBy: 1 }).toArray();
const otherOwners = db.ginivariantparentowners.countDocuments({ skuKey: { $ne: "38104" } });
const otherOperations = db.ginivariantownershipoperations.countDocuments({ skuKey: { $ne: "38104" } });
print(JSON.stringify({ owners, operations, products, otherOwners, otherOperations }));
`;
}

export function evidenceScriptIsReadOnly(script) {
  return EVIDENCE_MUTATION.test(String(script || "")) !== true;
}
