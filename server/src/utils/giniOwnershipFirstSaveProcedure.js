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
    ],
    open: {
      executed: false,
      note: "Do not run these steps until a separate authorization says to open the first pilot.",
      steps: [
        "Record read-only baselines: owner and operation counts for skuKey 38104, both product documents, and their updatedAt values.",
        "Change only OWNERSHIP_SAVE_RELEASED and OWNERSHIP_SAVE_INDEXES_READY from false to true in server/src/utils/giniVariantOwnershipAudit.js.",
        "Set GINI_VARIANT_OWNERSHIP_SAVE_ENABLED and GINI_ALLOW_OWNERSHIP_SAVE to the string true on the API process environment only. Do not commit either name.",
        "Restart that API process once so the source locks and environment gates load together.",
        "Sign in as the same administrator who will save. POST /api/admin/platforms/gini/variant-sync/ownership/preview for parentSku 38104 and product 6adf9ca49dedbaa3dd573cce with confirm true.",
        "Accept the preview only when productionReview.verified is true, liveIndexesReady is true, selected.vendor is IT Lobby, selected.sourceItemId is 6adf9824ef43bcf3ec7d1ee4, and the excluded product is Jawal Flex 6ae08bbd9dedbaa3dd5740d9.",
        "Within 15 minutes, the same authenticated administrator presses Save ownership. The route sets confirm and confirmOwnershipSave from that action and uses req.user._id, ignoring any administrator id in the body.",
      ],
    },
    close: {
      executed: false,
      note: "Run this immediately after one successful save, or immediately after any failed attempt once the gates were opened.",
      steps: [
        "Remove GINI_VARIANT_OWNERSHIP_SAVE_ENABLED and GINI_ALLOW_OWNERSHIP_SAVE from the API process environment.",
        "Set OWNERSHIP_SAVE_RELEASED and OWNERSHIP_SAVE_INDEXES_READY back to false in server/src/utils/giniVariantOwnershipAudit.js.",
        "Restart the API process. The in-memory preview snapshot dies on restart, and the source locks load closed.",
        "POST the save route again. It must return 409 ownership_save_disabled with saved false, sentToGini 0, and databaseRechecked false.",
        "Repeat the read-only verification below before any further ownership work.",
      ],
    },
    failure: [
      { code: "ownership_save_disabled", action: "Safe stop. At least one gate is closed. Do not retry the save." },
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
    ],
    sourceReleased: OWNERSHIP_SAVE_RELEASED === true,
    sourceIndexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
  };
}
