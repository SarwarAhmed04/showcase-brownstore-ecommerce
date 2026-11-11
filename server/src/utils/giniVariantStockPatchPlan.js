import { giniSkuKey } from "./giniSyncOnePlan.js";
import { presentRemoteVariant, readRemoteParent, readRemoteVariantRows } from "./giniVariantChangedPlan.js";
import { KE20_STOCK_PILOT, buildSingleVariantStockPatch } from "./giniVariantUpdateContract.js";

export const KE20_STOCK_PATCH_RAW_BODY = "{\"variant_id\":164307,\"quantity\":9}";
export const KE20_STOCK_RESTORE_RAW_BODY = "{\"variant_id\":164307,\"quantity\":10}";
export const KE20_STOCK_PATCH_PATH = "/api/v2.0/third-party/products/KE20/stock";
export const KE20_REQUIRED_HOST = "merchant.gini.iq";

export function giniVariantStockPatchWritesEnabled(env = process.env) {
  return env.GINI_VARIANT_STOCK_PATCH_ENABLED === "true" && env.GINI_ALLOW_LIVE_VARIANT_STOCK_PATCH === "true";
}

export function readKe20Parent(response) {
  const parent = readRemoteParent(response, KE20_STOCK_PILOT.parentSku);
  const price = Number(response?.json?.data?.price);
  return { ...parent, price: Number.isFinite(price) ? price : null };
}

function variantRows(response) {
  const read = readRemoteVariantRows(response);
  return read.rows ? read.rows.map(presentRemoteVariant) : null;
}

function sameVariant(row, expected) {
  return Boolean(row)
    && String(row.id) === String(expected.id)
    && giniSkuKey(row.sku) === giniSkuKey(expected.sku)
    && row.quantity === expected.quantity
    && row.price === expected.price;
}

function assess(parent, variants, expected) {
  const blockers = [];
  if (!parent || parent.state !== "present") blockers.push("parent_not_read");
  else {
    if (String(parent.id) !== KE20_STOCK_PILOT.giniProductId) blockers.push("parent_id_mismatch");
    if (giniSkuKey(parent.sku) !== giniSkuKey(KE20_STOCK_PILOT.parentSku)) blockers.push("parent_sku_mismatch");
    if (parent.visibility !== "hidden") blockers.push("parent_not_hidden");
    if (parent.quantity !== expected.parentQuantity) blockers.push("parent_quantity_mismatch");
    if (parent.price !== expected.parentPrice) blockers.push("parent_price_mismatch");
  }
  if (!Array.isArray(variants)) blockers.push("variants_not_read");
  else {
    if (variants.length !== 2) blockers.push("unexpected_variant_count");
    const black = variants.find((row) => String(row.id) === KE20_STOCK_PILOT.variantId);
    const blue = variants.find((row) => String(row.id) === KE20_STOCK_PILOT.untouchedVariantId);
    if (!sameVariant(black, expected.black)) blockers.push("black_mismatch");
    if (!sameVariant(blue, expected.blue)) blockers.push("blue_mismatch");
  }
  return { ok: blockers.length === 0, blockers };
}

const BLACK = { id: KE20_STOCK_PILOT.variantId, sku: KE20_STOCK_PILOT.variantSku, price: KE20_STOCK_PILOT.unchangedPrice };
const BLUE = { id: KE20_STOCK_PILOT.untouchedVariantId, sku: KE20_STOCK_PILOT.untouchedVariantSku, price: KE20_STOCK_PILOT.unchangedPrice };

export function assessKe20Baseline(parent, variants) {
  return assess(parent, variants, {
    parentQuantity: KE20_STOCK_PILOT.parentQuantity,
    parentPrice: KE20_STOCK_PILOT.parentPrice,
    black: { ...BLACK, quantity: KE20_STOCK_PILOT.currentQuantity },
    blue: { ...BLUE, quantity: 10 },
  });
}

export function assessKe20Applied(parent, variants) {
  return assess(parent, variants, {
    parentQuantity: KE20_STOCK_PILOT.appliedParentQuantity,
    parentPrice: KE20_STOCK_PILOT.parentPrice,
    black: { ...BLACK, quantity: KE20_STOCK_PILOT.proposedQuantity },
    blue: { ...BLUE, quantity: 10 },
  });
}

export function assessKe20Restored(parent, variants) {
  return assessKe20Baseline(parent, variants);
}

export function assessKe20Ownership({ owner, identities } = {}) {
  const blockers = [];
  const ownerProduct = KE20_STOCK_PILOT.ownerProductId;
  if (!owner || owner.status !== "verified_remote" || String(owner.giniProductId) !== KE20_STOCK_PILOT.giniProductId || String(owner.productId) !== ownerProduct) {
    blockers.push("owner_mismatch");
  }
  const black = (identities || []).find((row) => giniSkuKey(row.approvedSku) === giniSkuKey(KE20_STOCK_PILOT.variantSku));
  const blue = (identities || []).find((row) => giniSkuKey(row.approvedSku) === giniSkuKey(KE20_STOCK_PILOT.untouchedVariantSku));
  if (!black || String(black.confirmedGiniVariantId) !== KE20_STOCK_PILOT.variantId || String(black.productId) !== ownerProduct) blockers.push("black_identity_mismatch");
  if (!blue || String(blue.confirmedGiniVariantId) !== KE20_STOCK_PILOT.untouchedVariantId || String(blue.productId) !== ownerProduct) blockers.push("blue_identity_mismatch");
  return { ok: blockers.length === 0, blockers };
}

export function ke20ApplyRequest() {
  const patch = buildSingleVariantStockPatch({
    parentSku: KE20_STOCK_PILOT.parentSku,
    variantId: KE20_STOCK_PILOT.variantId,
    quantity: KE20_STOCK_PILOT.proposedQuantity,
  });
  return checked(patch, KE20_STOCK_PATCH_RAW_BODY);
}

export function ke20RestoreRequest() {
  const patch = buildSingleVariantStockPatch({
    parentSku: KE20_STOCK_PILOT.parentSku,
    variantId: KE20_STOCK_PILOT.variantId,
    quantity: KE20_STOCK_PILOT.currentQuantity,
  });
  return checked(patch, KE20_STOCK_RESTORE_RAW_BODY);
}

function checked(patch, rawBody) {
  const keys = patch.body ? Object.keys(patch.body) : [];
  const exact = patch.ok && patch.rawBody === rawBody && patch.path === KE20_STOCK_PATCH_PATH && keys.every((key) => key === "variant_id" || key === "quantity");
  return exact ? patch : { ...patch, ok: false, code: patch.ok ? "request_shape_rejected" : patch.code, liveSend: false };
}

export function ke20IntentionalDifference() {
  return "BrownStore stock stays at 10. This test would temporarily set GINI KE20-BLACK stock to 9. KE20-BLUE stays at 10.";
}

export function ke20RestorePlan() {
  return {
    automatic: false,
    method: "PATCH",
    path: KE20_STOCK_PATCH_PATH,
    rawBody: KE20_STOCK_RESTORE_RAW_BODY,
    afterVerifiedApplyOnly: true,
    note: "Restore KE20-BLACK from 9 to 10 only after a separate confirmation. The quantity-9 PATCH does not restore itself.",
  };
}

export { variantRows };
