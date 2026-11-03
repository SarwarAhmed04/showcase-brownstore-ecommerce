import { GiniProductUpdateAudit } from "../models/GiniProductUpdateAudit.js";
import { GiniSyncProductResult } from "../models/GiniSyncProductResult.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";

const CREATE_CLASSIFICATIONS = new Set(["CREATED", "ALREADY_EXISTS"]);
const CONFIRMED_FIELD_STATUSES = new Set(["updated", "reconciled_applied"]);

/**
 * Confirmed price and quantity for a GINI send.
 * The original create result stays untouched. A verified JSON PUT that explains
 * the whole payload moves GiniSyncSendState.payloadHash. A verified price or
 * quantity PUT that leaves another field unsynced keeps that hash and is applied
 * from its own audit. Pending, uncertain, failed, and image replacements are not
 * confirmed field values. Image count stays on the create row.
 */
export function confirmedFieldSnapshotKey(sku, giniProductId, payloadHash) {
  return `${giniSkuKey(sku)}|${String(giniProductId || "")}|${String(payloadHash || "")}`;
}

function integerField(value, minimum) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) return null;
  return number;
}

function sameProduct(row, send) {
  if (String(row?.giniProductId || "") !== String(send?.giniProductId || "")) return false;
  const rowKey = String(row?.skuKey || "");
  const sendKey = String(send?.skuKey || "");
  if (rowKey && sendKey && rowKey !== sendKey) return false;
  return true;
}

function earliest(rows) {
  return [...rows].sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime())[0] || null;
}

function createBaseline(rows, send) {
  const creates = rows.filter((row) => sameProduct(row, send) && CREATE_CLASSIFICATIONS.has(row.classification));
  const createHash = String(send.createPayloadHash || "");
  const preferred = createHash ? creates.filter((row) => String(row.payloadHash || "") === createHash) : [];
  return earliest(preferred.length ? preferred : creates);
}

function fieldUpdates(audit) {
  const updates = {};
  const changes = Array.isArray(audit?.changes) ? audit.changes : [];
  for (const change of changes) {
    if (change?.field === "price") updates.price = change.new;
    if (change?.field === "quantity") updates.quantity = change.new;
  }
  const body = audit?.body && typeof audit.body === "object" && !Array.isArray(audit.body) ? audit.body : {};
  if (updates.price === undefined && body.price !== undefined) updates.price = body.price;
  if (updates.quantity === undefined && body.quantity !== undefined) updates.quantity = body.quantity;
  return updates;
}

function confirmedFieldAudit(audit) {
  if (!audit?.requestSent) return false;
  if (audit.kind === "image_replacement" || audit.method === "POST") return false;
  if (!CONFIRMED_FIELD_STATUSES.has(String(audit.status || ""))) return false;
  if (!audit.previousPayloadHash) return false;
  if (audit.confirmsPayloadHash === false) return true;
  if (!audit.nextPayloadHash) return false;
  return true;
}

function applyConfirmedAudits(baseline, audits) {
  const price = integerField(baseline.giniPrice, 1);
  const quantity = integerField(baseline.quantity, 0);
  if (price == null || quantity == null) return null;
  const snapshot = { giniPrice: price, quantity, imageCount: integerField(baseline.imageCount, 0) };
  let hash = String(baseline.payloadHash || "");
  const ordered = [...audits].filter(confirmedFieldAudit).sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime());
  for (const audit of ordered) {
    if (String(audit.previousPayloadHash) !== hash) continue;
    const updates = fieldUpdates(audit);
    const nextPrice = updates.price === undefined ? snapshot.giniPrice : integerField(updates.price, 1);
    const nextQuantity = updates.quantity === undefined ? snapshot.quantity : integerField(updates.quantity, 0);
    if (nextPrice == null || nextQuantity == null) continue;
    snapshot.giniPrice = nextPrice;
    snapshot.quantity = nextQuantity;
    if (audit.confirmsPayloadHash !== false && audit.nextPayloadHash) hash = String(audit.nextPayloadHash);
  }
  return snapshot;
}

export async function loadConfirmedFieldSnapshots(sends) {
  const snapshots = new Map();
  const list = (sends || []).filter((row) => row?.giniProductId && row?.payloadHash);
  if (!list.length) return snapshots;
  const ids = [...new Set(list.map((row) => String(row.giniProductId)))];
  const skuKeys = [...new Set(list.map((row) => String(row.skuKey || "")).filter(Boolean))];
  const [rows, audits] = await Promise.all([
    GiniSyncProductResult.find({
      partner: "gini",
      giniProductId: { $in: ids },
    })
      .select("skuKey giniProductId payloadHash giniPrice quantity imageCount classification createdAt")
      .lean(),
    GiniProductUpdateAudit.find({
      partner: "gini",
      skuKey: { $in: skuKeys },
      requestSent: true,
      kind: { $ne: "image_replacement" },
      status: { $in: [...CONFIRMED_FIELD_STATUSES] },
    })
      .select("skuKey giniProductId kind method status requestSent previousPayloadHash nextPayloadHash confirmsPayloadHash changes body createdAt")
      .lean(),
  ]);
  for (const send of list) {
    const currentHash = String(send.payloadHash || "");
    const matching = rows.filter((row) => sameProduct(row, send) && CREATE_CLASSIFICATIONS.has(row.classification) && String(row.payloadHash || "") === currentHash);
    const exact = earliest(matching);
    const baseline = exact || createBaseline(rows, send);
    if (!baseline) continue;
    const relatedAudits = audits.filter(
      (audit) => String(audit.giniProductId || "") === String(send.giniProductId || "") && String(audit.skuKey || "") === String(send.skuKey || "")
    );
    const applicable = exact ? relatedAudits.filter((audit) => audit.confirmsPayloadHash === false) : relatedAudits;
    const snapshot = applyConfirmedAudits(baseline, applicable);
    if (!snapshot) continue;
    snapshots.set(confirmedFieldSnapshotKey(send.skuKey || send.sku, send.giniProductId, currentHash), snapshot);
  }
  return snapshots;
}

export async function confirmedFieldsForSend(send) {
  const snapshots = await loadConfirmedFieldSnapshots([send]);
  return snapshots.get(confirmedFieldSnapshotKey(send?.skuKey || send?.sku, send?.giniProductId, send?.payloadHash)) || null;
}
