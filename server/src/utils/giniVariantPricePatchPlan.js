import { giniSkuKey } from "./giniSyncOnePlan.js";
import { KE20_STOCK_PILOT, buildSingleVariantStockPatch } from "./giniVariantUpdateContract.js";
import { presentRemoteVariant, readRemoteParent, readRemoteVariantRows } from "./giniVariantChangedPlan.js";
import { KE20_REQUIRED_HOST } from "./giniVariantStockPatchPlan.js";

export { KE20_REQUIRED_HOST };

export const KE20_PRICE_PATCH_PATH = "/api/v2.0/third-party/products/KE20/stock";
export const KE20_BLUE_PRICE_PATCH_RAW_BODY = "{\"variant_id\":164306,\"price\":28000}";
export const KE20_BLACK_PRICE_PATCH_RAW_BODY = "{\"variant_id\":164307,\"price\":28000}";

export const KE20_PRICE_PILOT = Object.freeze({
  parentSku: "KE20",
  giniProductId: KE20_STOCK_PILOT.giniProductId,
  ownerProductId: KE20_STOCK_PILOT.ownerProductId,
  visibility: "hidden",
  parentQuantity: 20,
  baselinePrice: 26500,
  targetPrice: 28000,
  stock: 10,
  blue: Object.freeze({ id: "164306", sku: "KE20-BLUE", rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY }),
  black: Object.freeze({ id: "164307", sku: "KE20-BLACK", rawBody: KE20_BLACK_PRICE_PATCH_RAW_BODY }),
});

const BLOCKING_JOURNAL = ["in_progress", "uncertain", "verified", "rejected"];

export function ke20PricePatchWritesEnabled(env = process.env) {
  return env.GINI_KE20_PRICE_PATCH_ENABLED === "true" && env.GINI_ALLOW_LIVE_KE20_PRICE_PATCH === "true";
}

export function ke20PriceStage(value) {
  return value === "blue" || value === "black" ? value : "";
}

export function ke20PriceOperationKey(stage) {
  const spec = KE20_PRICE_PILOT[stage];
  return spec ? `ke20-price-${spec.id}` : "";
}

export function readKe20PriceParent(response) {
  const parent = readRemoteParent(response, KE20_PRICE_PILOT.parentSku);
  const price = Number(response?.json?.data?.price);
  return { ...parent, price: Number.isFinite(price) ? price : null };
}

export function readKe20PriceVariants(response) {
  const read = readRemoteVariantRows(response);
  return read.rows ? read.rows.map(presentRemoteVariant) : null;
}

function variantSpec(stage) {
  return KE20_PRICE_PILOT[stage];
}

function sameVariant(row, expected) {
  return Boolean(row)
    && String(row.id) === expected.id
    && giniSkuKey(row.sku) === giniSkuKey(expected.sku)
    && row.quantity === expected.quantity
    && row.price === expected.price;
}

function expectedState(stage, phase) {
  const bluePrice = stage === "black" || phase === "after" ? KE20_PRICE_PILOT.targetPrice : KE20_PRICE_PILOT.baselinePrice;
  const blackPrice = stage === "black" && phase === "after" ? KE20_PRICE_PILOT.targetPrice : KE20_PRICE_PILOT.baselinePrice;
  const parentPrice = stage === "black" && phase === "after" ? KE20_PRICE_PILOT.targetPrice : KE20_PRICE_PILOT.baselinePrice;
  return {
    parentPrice,
    blue: { id: KE20_PRICE_PILOT.blue.id, sku: KE20_PRICE_PILOT.blue.sku, price: bluePrice, quantity: KE20_PRICE_PILOT.stock },
    black: { id: KE20_PRICE_PILOT.black.id, sku: KE20_PRICE_PILOT.black.sku, price: blackPrice, quantity: KE20_PRICE_PILOT.stock },
  };
}

export function assessKe20PriceState(parent, variants, stage, phase) {
  const expected = expectedState(stage, phase);
  const blockers = [];
  if (!parent || parent.state !== "present") blockers.push("parent_not_read");
  else {
    if (String(parent.id) !== KE20_PRICE_PILOT.giniProductId) blockers.push("parent_id_mismatch");
    if (giniSkuKey(parent.sku) !== giniSkuKey(KE20_PRICE_PILOT.parentSku)) blockers.push("parent_sku_mismatch");
    if (parent.visibility !== "hidden") blockers.push("parent_not_hidden");
    if (parent.quantity !== KE20_PRICE_PILOT.parentQuantity) blockers.push("parent_quantity_mismatch");
    if (parent.price !== expected.parentPrice) blockers.push("parent_price_mismatch");
  }
  if (!Array.isArray(variants)) blockers.push("variants_not_read");
  else {
    if (variants.length !== 2) blockers.push("unexpected_variant_count");
    const blue = variants.find((row) => String(row.id) === KE20_PRICE_PILOT.blue.id);
    const black = variants.find((row) => String(row.id) === KE20_PRICE_PILOT.black.id);
    if (!sameVariant(blue, expected.blue)) blockers.push("blue_mismatch");
    if (!sameVariant(black, expected.black)) blockers.push("black_mismatch");
  }
  return { ok: blockers.length === 0, blockers, expected };
}

export function assessKe20PriceOwnership({ owner, identities } = {}) {
  const blockers = [];
  const ownerProduct = KE20_PRICE_PILOT.ownerProductId;
  if (!owner || owner.status !== "verified_remote" || String(owner.giniProductId) !== KE20_PRICE_PILOT.giniProductId || String(owner.productId) !== ownerProduct) {
    blockers.push("owner_mismatch");
  }
  for (const stage of ["blue", "black"]) {
    const spec = variantSpec(stage);
    const row = (identities || []).find((item) => giniSkuKey(item.approvedSku) === giniSkuKey(spec.sku));
    if (!row || String(row.confirmedGiniVariantId) !== spec.id || String(row.productId) !== ownerProduct) blockers.push(`${stage}_identity_mismatch`);
  }
  return { ok: blockers.length === 0, blockers };
}

function approvalMatches(row, stage) {
  const spec = variantSpec(stage);
  return Boolean(row)
    && giniSkuKey(row.parentSku) === giniSkuKey(KE20_PRICE_PILOT.parentSku)
    && String(row.variantId) === spec.id
    && row.status === "approved"
    && Number(row.baselinePrice) === KE20_PRICE_PILOT.baselinePrice
    && Number(row.baselineQuantity) === KE20_PRICE_PILOT.stock
    && Number(row.proposedPrice) === KE20_PRICE_PILOT.targetPrice
    && String(row.rawBody || "") === spec.rawBody
    && !String(row.rawBody || "").includes("quantity");
}

export function assessKe20PriceApproval(approvals) {
  const blockers = [];
  for (const stage of ["blue", "black"]) {
    if (!(approvals || []).some((row) => approvalMatches(row, stage))) blockers.push(`${stage}_approval_missing`);
  }
  return { ok: blockers.length === 0, blockers };
}

export function ke20PriceRequest(stage) {
  const spec = variantSpec(stage);
  if (!spec) return { ok: false, code: "stage_required", method: "PATCH", path: "", body: null, rawBody: "", liveSend: false };
  const patch = buildSingleVariantStockPatch({
    parentSku: KE20_PRICE_PILOT.parentSku,
    variantId: spec.id,
    price: KE20_PRICE_PILOT.targetPrice,
  });
  const keys = patch.body ? Object.keys(patch.body) : [];
  const exact = patch.ok
    && patch.rawBody === spec.rawBody
    && patch.path === KE20_PRICE_PATCH_PATH
    && keys.length === 2
    && keys[0] === "variant_id"
    && keys[1] === "price"
    && !patch.rawBody.includes("quantity")
    && !patch.rawBody.includes("is_visible")
    && !patch.rawBody.includes(stage === "blue" ? KE20_PRICE_PILOT.black.id : KE20_PRICE_PILOT.blue.id);
  return exact ? patch : { ...patch, ok: false, code: patch.ok ? "request_shape_rejected" : patch.code, liveSend: false };
}

export function ke20PriceJournalBlocks(status) {
  return BLOCKING_JOURNAL.includes(status);
}

export function ke20PriceNextStage(blueStatus, blackStatus) {
  if (blueStatus !== "verified") return "blue";
  if (blackStatus !== "verified") return "black";
  return "";
}
