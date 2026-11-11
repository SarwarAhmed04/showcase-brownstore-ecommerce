import { GINI_PUT_DOCUMENTED_FIELDS } from "./giniProductUpdateContract.js";
import { normalizeGiniItemCode } from "./giniSyncOnePlan.js";

/**
 * Evidence is the official "Gini API v2 - Third Party" collection downloaded
 * from https://merchant.gini.iq/developer/docs/postman/download on 11 Nov 2026.
 * SHA-256 956f331e1e8e6075a631af2ab693777141782387dfda74ad5d7086566aa2f7b7.
 * No live PATCH, PUT, POST, or DELETE was sent.
 *
 * Update Variant Stock is PATCH /products/{sku}/stock with variant_id plus
 * price and/or quantity. Save Variants has no description and no variant id,
 * so replace-versus-merge stays unstated. Delete Variant has no description.
 * is_visible is documented for products only. Update Attribute has a full
 * values example and no description of omitted values.
 */
export const GINI_VARIANT_STOCK_PATH_SUFFIX = "/stock";
export const GINI_VARIANT_STOCK_METHOD = "PATCH";
export const GINI_VARIANT_STOCK_MAX_QUANTITY = 10000;

export const KE20_STOCK_PILOT = Object.freeze({
  parentSku: "KE20",
  giniProductId: "618623",
  visibility: "hidden",
  variantId: "164307",
  variantSku: "KE20-BLACK",
  currentQuantity: 10,
  proposedQuantity: 9,
  unchangedPrice: 26500,
  untouchedVariantId: "164306",
  untouchedVariantSku: "KE20-BLUE",
  parentQuantity: 20,
  parentPrice: 26500,
  appliedParentQuantity: 19,
  ownerProductId: "6adc7938b3764a909f6929d6",
});

export const GINI_VARIANT_UPDATE_CAPABILITIES = Object.freeze({
  reviewedAgainst: "Gini API v2 - Third Party collection, Update Variant Stock",
  documentedProductPutIncludesVariants: GINI_PUT_DOCUMENTED_FIELDS.includes("variants"),
  collectionBaseUrl: "https://app.gini.iq/api/v2.0/third-party",
  singleVariantStockUpdate: "DOCUMENTED_NOT_LIVE_TESTED",
  putVariantsReplacesCompleteSet: "NOT_STATED",
  partialUpdates: "DOCUMENTED_FOR_ONE_VARIANT_PRICE_OR_QUANTITY",
  quantityChanges: "DOCUMENTED_NOT_LIVE_TESTED",
  quantityZero: "NOT_STATED_ON_SINGLE_PATCH",
  bulkQuantityZero: "DOCUMENTED_ON_ASYNC_BULK_ONLY",
  addColor: "REQUEST_EXISTS_OMITTED_VALUES_NOT_STATED",
  removeColor: "NO_DOCUMENTED_DEACTIVATE",
  variantDeletion: "ENDPOINT_EXISTS_EFFECT_NOT_STATED",
  variantDeactivation: "NOT_DOCUMENTED",
  preserveRemoteVariantIds: "REQUIRED",
  writesEnabled: false,
  liveTested: false,
});

export function unsupportedVariantOperations() {
  return [
    { operation: "single_variant_price_or_quantity", status: GINI_VARIANT_UPDATE_CAPABILITIES.singleVariantStockUpdate },
    { operation: "replace_complete_variant_set", status: GINI_VARIANT_UPDATE_CAPABILITIES.putVariantsReplacesCompleteSet },
    { operation: "quantity_zero_on_single_patch", status: GINI_VARIANT_UPDATE_CAPABILITIES.quantityZero },
    { operation: "add_color", status: GINI_VARIANT_UPDATE_CAPABILITIES.addColor },
    { operation: "remove_color", status: GINI_VARIANT_UPDATE_CAPABILITIES.removeColor },
    { operation: "delete_variant", status: GINI_VARIANT_UPDATE_CAPABILITIES.variantDeletion },
    { operation: "deactivate_variant", status: GINI_VARIANT_UPDATE_CAPABILITIES.variantDeactivation },
    { operation: "update_without_remote_variant_id", status: "BLOCKED" },
  ];
}

function whole(value, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
}

/**
 * Builds the documented one-variant stock body. It does not send it.
 * Quantity 0 is refused because Update Variant Stock states an upper bound
 * of 10,000 and does not state that 0 is accepted.
 */
export function buildSingleVariantStockPatch({ parentSku, variantId, price, quantity } = {}) {
  const sku = normalizeGiniItemCode(parentSku);
  const id = whole(variantId, { min: 1 });
  const nextPrice = price == null || price === "" ? null : whole(price, { min: 1 });
  const nextQuantity = quantity == null || quantity === "" ? null : whole(quantity, { min: 0, max: GINI_VARIANT_STOCK_MAX_QUANTITY });
  const closed = (code) => ({
    ok: false,
    code,
    method: GINI_VARIANT_STOCK_METHOD,
    path: sku ? `/api/v2.0/third-party/products/${encodeURIComponent(sku)}/stock` : "",
    body: null,
    rawBody: "",
    sendsOtherVariants: false,
    replacesVariantSet: false,
    liveSend: false,
  });
  if (!sku) return closed("missing_parent_sku");
  if (!id) return closed("missing_remote_variant_id");
  if (price != null && price !== "" && nextPrice == null) return closed("invalid_price");
  if (quantity != null && quantity !== "" && nextQuantity == null) return closed("invalid_quantity");
  if (nextQuantity === 0) return closed("quantity_zero_not_stated");
  if (nextPrice == null && nextQuantity == null) return closed("nothing_to_update");
  const body = { variant_id: id };
  if (nextPrice != null) body.price = nextPrice;
  if (nextQuantity != null) body.quantity = nextQuantity;
  return {
    ok: true,
    code: "ready_not_sent",
    method: GINI_VARIANT_STOCK_METHOD,
    path: `/api/v2.0/third-party/products/${encodeURIComponent(sku)}/stock`,
    contentType: "application/json",
    body,
    rawBody: JSON.stringify(body),
    sendsOtherVariants: false,
    replacesVariantSet: false,
    liveSend: false,
  };
}

export function ke20BlackQuantityPilotPatch() {
  return buildSingleVariantStockPatch({
    parentSku: KE20_STOCK_PILOT.parentSku,
    variantId: KE20_STOCK_PILOT.variantId,
    quantity: KE20_STOCK_PILOT.proposedQuantity,
  });
}
