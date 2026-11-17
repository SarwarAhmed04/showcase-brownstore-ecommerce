import crypto from "crypto";
import { blockerMessage } from "./giniSyncEvaluate.js";
import { assessSimpleProduct, giniSkuKey, normalizeGiniItemCode } from "./giniSyncOnePlan.js";
import { variationCombinations } from "./giniVariantCatalog.js";

export const GINI_UNIFIED_ACTIONS = Object.freeze(["CREATE", "UPDATE", "UNCHANGED", "BLOCKED"]);

/**
 * GINI API limits that this job does not try to work around.
 * Update Variant Stock documents price and quantity for one variant id.
 * It does not document quantity 0, adding a color, or deleting a variant.
 * Save Variants is the verified create step used after an empty variant list.
 * It is not used here to replace variants that already exist.
 * Product updates send price and quantity only. is_visible stays on Publish.
 */
export const GINI_UNIFIED_LIMITATIONS = Object.freeze([
  "An exact SKU GET runs before every create, including products that were imported to GINI through Excel and have no BrownStore send record.",
  "Multi-variant updates change only a child whose approved SKU matches a GINI variant. Unknown remote variants are left in place.",
  "Update Variant Stock does not document quantity 0, adding a color, or deleting a variant, so those products stay blocked.",
  "The verified two-stage create is used only when the parent SKU is absent. An existing variant set is not replaced.",
  "Existing product visibility is read and checked. This job does not change is_visible. Publish stays separate.",
  "A new multi-variant parent is created hidden, the same way product 38104 was verified. It is not published by this job.",
  "A new simple product is created hidden, like a new multi-variant parent. Products already on GINI do not receive an is_visible change. Publish stays separate.",
  "Production writes stay off unless a non-production process sets both unified write flags. NODE_ENV=production never enables them.",
]);

const REASONS = {
  lookup_uncertain: "GINI did not confirm this SKU, so it was not created or updated.",
  approved_child_sku_missing: "An approved child SKU is not on this GINI product.",
  unknown_remote_variant: "GINI has a variant SKU that is not an approved BrownStore child. It was left in place.",
  ownership_unverified: "This parent SKU has no verified owner for this BrownStore product.",
  child_id_mismatch: "The approved child SKU is on GINI under a different variant id.",
  visibility_unreadable: "GINI did not return is_visible, so the product was not changed.",
  visibility_changed: "Stored visibility no longer matches GINI. No visibility write was sent.",
  preview_drift: "The product changed after this preview was approved.",
  quantity_zero_not_stated: "Update Variant Stock does not state that quantity 0 is accepted.",
  existing_gini_product: "This exact SKU is already on GINI. It was not created again.",
  parent_not_hidden: "A new variant parent must be hidden with quantity 0 before its variants are sent.",
  variants_partial: "Only some approved variants were found after an uncertain write. They were not sent again.",
  not_sellable: "This product has no single simple sellable variant and no multi-variant set.",
  size_attribute_unverified: "This product has more than one size, and GINI has no verified size attribute for it.",
  missing_variant_sku_approval: "A sellable variant does not have an approved child SKU.",
  missing_attribute: "A sellable color is not mapped to the verified GINI color attribute.",
};

export function unifiedReason(code) {
  return REASONS[code] || blockerMessage(code);
}

export function giniUnifiedSyncWritesEnabled(env = process.env) {
  if (String(env?.NODE_ENV || "") === "production") return false;
  return env?.GINI_UNIFIED_SYNC_WRITES_ENABLED === "true" && env?.GINI_ALLOW_LIVE_UNIFIED_SYNC === "true";
}

/** Pick the sender from sellable color/size rows, not from the variant array length alone. */
export function selectSellableFlow(doc) {
  const combinations = variationCombinations(doc);
  if (combinations.length >= 2) return { flow: "variant", sellableCount: combinations.length, reasons: [] };
  const simple = assessSimpleProduct(doc);
  if (simple.simple) return { flow: "simple", sellableCount: Math.max(combinations.length, 1), reasons: [] };
  const reasons = simple.blockers.length ? simple.blockers : ["not_sellable"];
  return { flow: "blocked", sellableCount: combinations.length, reasons };
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function fingerprintOf(plan) {
  return crypto.createHash("sha256").update(JSON.stringify({
    sku: plan.sku,
    flow: plan.flow,
    action: plan.action,
    price: plan.price,
    quantity: plan.quantity,
    visibility: plan.visibility || "",
    giniProductId: plan.giniProductId || "",
    children: plan.children || [],
    reasons: plan.reasons || [],
  })).digest("hex");
}

function finish(plan) {
  const reasons = unique(plan.reasons);
  return {
    ...plan,
    reasons,
    messages: reasons.map(unifiedReason),
    fingerprint: fingerprintOf({ ...plan, reasons }),
  };
}

function childPlan(combinations, identities, remoteRows) {
  const reasons = [];
  const children = [];
  const approved = new Map();
  for (const combo of combinations || []) {
    const saved = (identities || []).find((row) => String(row.sourceVariantId) === String(combo.sourceVariantId) && String(row.sourceSizeId || "") === String(combo.sourceSizeId || ""));
    const sku = saved?.approvedSku || "";
    if (!giniSkuKey(sku) || giniSkuKey(sku) !== giniSkuKey(combo.proposedSku)) {
      reasons.push("missing_variant_sku_approval");
      continue;
    }
    approved.set(giniSkuKey(sku), combo);
    const remote = (remoteRows || []).find((row) => giniSkuKey(row.sku) === giniSkuKey(sku));
    if (!remote) {
      reasons.push("approved_child_sku_missing");
      continue;
    }
    if (saved.confirmedGiniVariantId && String(remote.id || "") !== String(saved.confirmedGiniVariantId)) {
      reasons.push("child_id_mismatch");
    }
    const price = Number.isInteger(Number(combo.price)) ? Number(combo.price) : null;
    const quantity = Number.isInteger(Number(combo.stock)) ? Number(combo.stock) : null;
    children.push({
      sku,
      variantId: String(remote.id || ""),
      price,
      quantity,
      remotePrice: remote.price,
      remoteQuantity: remote.quantity,
      changed: remote.price !== price || remote.quantity !== quantity,
    });
    if (quantity === 0 && remote.quantity !== 0) reasons.push("quantity_zero_not_stated");
  }
  for (const row of remoteRows || []) {
    if (!approved.has(giniSkuKey(row.sku))) reasons.push("unknown_remote_variant");
  }
  return { reasons: unique(reasons), children };
}

/**
 * One preview row. Exact SKU presence decides create versus update.
 * Callers pass blockers from the simple plan or the variant classifier.
 */
export function planUnifiedProduct({
  doc,
  flow,
  flowReasons = [],
  blockers = [],
  remote = { state: "not_read" },
  combinations = [],
  identities = [],
  owner = null,
  price = null,
  quantity = null,
} = {}) {
  const sku = normalizeGiniItemCode(doc?.itemCode);
  const selected = flow || selectSellableFlow(doc).flow;
  const base = {
    productId: String(doc?._id || ""),
    sku,
    skuKey: giniSkuKey(sku),
    flow: selected,
    action: "BLOCKED",
    reasons: [...flowReasons],
    price,
    quantity,
    visibility: remote?.visibility || "",
    giniProductId: remote?.id ? String(remote.id) : "",
    children: [],
    retryable: false,
  };
  if (selected !== "simple" && selected !== "variant") {
    return finish({ ...base, flow: "blocked", reasons: [...base.reasons, ...blockers, "not_sellable"] });
  }
  const local = unique([...(blockers || []), ...base.reasons]);
  if (local.length) return finish({ ...base, reasons: local });
  const state = remote?.state || "not_read";
  if (state === "uncertain" || state === "not_read") {
    return finish({ ...base, reasons: ["lookup_uncertain"], retryable: true });
  }
  if (selected === "variant" && state === "present") {
    const sameOwner = owner && String(owner.productId || "") === String(doc?._id || "") && owner.status === "verified_remote";
    if (!sameOwner) return finish({ ...base, reasons: ["ownership_unverified"] });
    if (remote.visibility !== "hidden" && remote.visibility !== "visible") {
      return finish({ ...base, reasons: ["visibility_unreadable"] });
    }
    const matched = childPlan(combinations, identities, remote.variants || []);
    if (matched.reasons.length) return finish({ ...base, reasons: matched.reasons, children: matched.children });
    const changed = matched.children.some((row) => row.changed);
    return finish({
      ...base,
      action: changed ? "UPDATE" : "UNCHANGED",
      reasons: [],
      children: matched.children,
    });
  }
  if (state === "absent") {
    if (selected === "variant" && owner && String(owner.productId || "") !== String(doc?._id || "")) {
      return finish({ ...base, reasons: ["ownership_unverified"] });
    }
    return finish({ ...base, action: "CREATE", reasons: [], giniProductId: "" });
  }
  if (selected === "simple") {
    if (remote.visibility !== "hidden" && remote.visibility !== "visible") {
      return finish({ ...base, reasons: ["visibility_unreadable"] });
    }
    const same = Number(remote.price) === Number(price) && Number(remote.quantity) === Number(quantity);
    return finish({ ...base, action: same ? "UNCHANGED" : "UPDATE", reasons: [] });
  }
  return finish({ ...base, reasons: ["lookup_uncertain"], retryable: true });
}
