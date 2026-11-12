import { applyCommissionRate } from "./commission.js";
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
  visibility: "hidden",
  parentQuantity: 20,
  baselinePrice: 26500,
  targetPrice: 28000,
  stock: 10,
  blue: Object.freeze({ id: "164306", sku: "KE20-BLUE", rawBody: KE20_BLUE_PRICE_PATCH_RAW_BODY }),
  black: Object.freeze({ id: "164307", sku: "KE20-BLACK", rawBody: KE20_BLACK_PRICE_PATCH_RAW_BODY }),
});

export const EI8888_PRICE_PATCH_PATH = "/api/v2.0/third-party/products/EI-8888/stock";
export const EI8888_BLUE_PRICE_PATCH_RAW_BODY = "{\"variant_id\":164312,\"price\":126500}";
export const EI8888_PURPLE_PRICE_PATCH_RAW_BODY = "{\"variant_id\":164313,\"price\":126500}";

export const EI8888_PRICE_PILOT = Object.freeze({
  parentSku: "EI-8888",
  giniProductId: "618651",
  visibility: "hidden",
  parentQuantity: 20,
  baselinePrice: 119750,
  targetPrice: 126500,
  stock: 10,
  commissionPercentage: 5.5,
  blue: Object.freeze({ id: "164312", sku: "EI-8888-BLUE", rawBody: EI8888_BLUE_PRICE_PATCH_RAW_BODY }),
  purple: Object.freeze({ id: "164313", sku: "EI-8888-PURPLE", rawBody: EI8888_PURPLE_PRICE_PATCH_RAW_BODY }),
});

const BLOCKING_JOURNAL = ["in_progress", "uncertain", "verified", "rejected"];

function defineStagedPricePilot(spec, stageOrder, gates) {
  const parentKey = giniSkuKey(spec.parentSku);
  const disabledCode = `${parentKey.replace(/-/g, "")}_price_patch_disabled`;

  function variantSpec(stage) {
    return spec[stage] || null;
  }

  function writesEnabled(env = process.env) {
    return env[gates.enabledEnv] === "true" && env[gates.allowEnv] === "true";
  }

  function stageName(value) {
    return stageOrder.includes(value) ? value : "";
  }

  function operationKey(stage) {
    const row = variantSpec(stage);
    return row ? `${parentKey}-price-${row.id}` : "";
  }

  function readParent(response) {
    const parent = readRemoteParent(response, spec.parentSku);
    const price = Number(response?.json?.data?.price);
    return { ...parent, price: Number.isFinite(price) ? price : null };
  }

  function readVariants(response) {
    const read = readRemoteVariantRows(response);
    return read.rows ? read.rows.map(presentRemoteVariant) : null;
  }

  function sameVariant(row, expected) {
    return Boolean(row)
      && String(row.id) === expected.id
      && giniSkuKey(row.sku) === giniSkuKey(expected.sku)
      && row.quantity === expected.quantity
      && row.price === expected.price;
  }

  function expectedState(stage, phase) {
    const stageIndex = stageOrder.indexOf(stage);
    const prices = {};
    stageOrder.forEach((key, index) => {
      const done = index < stageIndex || (index === stageIndex && phase === "after");
      prices[key] = done ? spec.targetPrice : spec.baselinePrice;
    });
    const parentPrice = stageIndex === stageOrder.length - 1 && phase === "after" ? spec.targetPrice : spec.baselinePrice;
    const variants = {};
    for (const key of stageOrder) {
      variants[key] = { id: spec[key].id, sku: spec[key].sku, price: prices[key], quantity: spec.stock };
    }
    return { parentPrice, ...variants };
  }

  function assessState(parent, variants, stage, phase) {
    const expected = expectedState(stage, phase);
    const blockers = [];
    if (!parent || parent.state !== "present") blockers.push("parent_not_read");
    else {
      if (String(parent.id) !== spec.giniProductId) blockers.push("parent_id_mismatch");
      if (giniSkuKey(parent.sku) !== parentKey) blockers.push("parent_sku_mismatch");
      if (parent.visibility !== "hidden") blockers.push("parent_not_hidden");
      if (parent.quantity !== spec.parentQuantity) blockers.push("parent_quantity_mismatch");
      if (parent.price !== expected.parentPrice) blockers.push("parent_price_mismatch");
    }
    if (!Array.isArray(variants)) blockers.push("variants_not_read");
    else {
      if (variants.length !== stageOrder.length) blockers.push("unexpected_variant_count");
      for (const key of stageOrder) {
        const row = variants.find((item) => String(item.id) === spec[key].id);
        if (!sameVariant(row, expected[key])) blockers.push(`${key}_mismatch`);
      }
    }
    return { ok: blockers.length === 0, blockers, expected };
  }

  function identityView(row) {
    return {
      productId: String(row.productId),
      approvedSku: String(row.approvedSku || ""),
      confirmedGiniVariantId: String(row.confirmedGiniVariantId),
      sourceVariantId: String(row.sourceVariantId),
      sourceSizeId: String(row.sourceSizeId),
    };
  }

  function resolveIdentity({ owner, identities } = {}) {
    const blockers = [];
    const productId = String(owner?.productId || "");
    const ownerSku = giniSkuKey(owner?.parentSku || owner?.skuKey || "");
    if (!owner || owner.status !== "verified_remote" || String(owner.giniProductId) !== spec.giniProductId || ownerSku !== parentKey || !productId) {
      blockers.push("owner_mismatch");
    }
    const resolved = {};
    for (const stage of stageOrder) {
      const rowSpec = variantSpec(stage);
      const related = (identities || []).filter((row) => giniSkuKey(row?.approvedSku || row?.approvedSkuKey) === giniSkuKey(rowSpec.sku) || String(row?.confirmedGiniVariantId || "") === rowSpec.id);
      const exact = related.filter((row) => giniSkuKey(row.approvedSku || row.approvedSkuKey) === giniSkuKey(rowSpec.sku)
        && String(row.confirmedGiniVariantId || "") === rowSpec.id
        && String(row.productId || "") === productId
        && productId
        && giniSkuKey(row.parentSku || row.parentSkuKey) === parentKey
        && row.status === "verified"
        && String(row.sourceVariantId || "").trim()
        && String(row.sourceSizeId || "").trim());
      if (exact.length !== 1 || related.length !== 1) blockers.push(`${stage}_identity_mismatch`);
      else resolved[stage] = exact[0];
    }
    if (stageOrder.every((stage) => resolved[stage])) {
      const [first, second] = stageOrder;
      const sameSource = String(resolved[first].sourceVariantId) === String(resolved[second].sourceVariantId)
        && String(resolved[first].sourceSizeId) === String(resolved[second].sourceSizeId);
      if (sameSource) {
        for (const stage of stageOrder) blockers.push(`${stage}_identity_mismatch`);
      }
    }
    const ok = blockers.length === 0;
    const view = { ok, blockers, productId: ok ? productId : "" };
    for (const stage of stageOrder) view[stage] = ok ? identityView(resolved[stage]) : null;
    return view;
  }

  function approvalMatches(row, stage, identity) {
    const rowSpec = variantSpec(stage);
    const verified = identity?.[stage];
    const commissioned = spec.commissionPercentage == null
      || Number(row?.proposedPrice) === applyCommissionRate(spec.baselinePrice, spec.commissionPercentage);
    return Boolean(row)
      && identity?.ok
      && verified
      && commissioned
      && String(row.productId || "") === String(identity.productId)
      && String(verified.confirmedGiniVariantId) === rowSpec.id
      && giniSkuKey(row.parentSku) === parentKey
      && String(row.variantId) === rowSpec.id
      && (!row.variantSku || giniSkuKey(row.variantSku) === giniSkuKey(rowSpec.sku))
      && row.status === "approved"
      && Number(row.baselinePrice) === spec.baselinePrice
      && Number(row.baselineQuantity) === spec.stock
      && Number(row.proposedPrice) === spec.targetPrice
      && String(row.rawBody || "") === rowSpec.rawBody
      && !String(row.rawBody || "").includes("quantity");
  }

  function assessApproval(approvals, identity) {
    const blockers = [];
    if (!identity?.ok) blockers.push("approval_identity_unverified");
    for (const stage of stageOrder) {
      if (!(approvals || []).some((row) => approvalMatches(row, stage, identity))) blockers.push(`${stage}_approval_missing`);
    }
    return { ok: blockers.length === 0, blockers };
  }

  function assessCommission(snapshot) {
    if (spec.commissionPercentage == null) return { ok: true, blockers: [], expected: null };
    const expectedPrice = applyCommissionRate(spec.baselinePrice, spec.commissionPercentage);
    const expected = {
      percentage: spec.commissionPercentage,
      basePrice: spec.baselinePrice,
      giniPrice: spec.targetPrice,
    };
    const blockers = [];
    if (!snapshot) blockers.push("commission_snapshot_missing");
    else {
      if (Number(snapshot.percentage) !== spec.commissionPercentage) blockers.push("commission_rate_mismatch");
      if (Number(snapshot.basePrice) !== spec.baselinePrice) blockers.push("commission_base_mismatch");
      if (Number(snapshot.giniPrice) !== spec.targetPrice || Number(snapshot.giniPrice) !== expectedPrice) blockers.push("commission_price_mismatch");
    }
    if (expectedPrice !== spec.targetPrice) blockers.push("commission_rounding_mismatch");
    return { ok: blockers.length === 0, blockers, expected };
  }

  function request(stage) {
    const rowSpec = variantSpec(stage);
    if (!rowSpec) return { ok: false, code: "stage_required", method: "PATCH", path: "", body: null, rawBody: "", liveSend: false };
    const patch = buildSingleVariantStockPatch({
      parentSku: spec.parentSku,
      variantId: rowSpec.id,
      price: spec.targetPrice,
    });
    const keys = patch.body ? Object.keys(patch.body) : [];
    const otherIds = stageOrder.filter((key) => key !== stage).map((key) => spec[key].id);
    const exact = patch.ok
      && patch.rawBody === rowSpec.rawBody
      && patch.path === gates.path
      && keys.length === 2
      && keys[0] === "variant_id"
      && keys[1] === "price"
      && !patch.rawBody.includes("quantity")
      && !patch.rawBody.includes("is_visible")
      && otherIds.every((id) => !patch.rawBody.includes(id))
      && (spec.commissionPercentage == null || applyCommissionRate(spec.baselinePrice, spec.commissionPercentage) === spec.targetPrice);
    return exact ? patch : { ...patch, ok: false, code: patch.ok ? "request_shape_rejected" : patch.code, liveSend: false };
  }

  function journalBlocks(status) {
    return BLOCKING_JOURNAL.includes(status);
  }

  function nextStage(statuses = {}) {
    for (const stage of stageOrder) {
      if (statuses[stage] !== "verified") return stage;
    }
    return "";
  }

  function verifiedJournal(journals, stage) {
    const rowSpec = variantSpec(stage);
    const rows = (journals || []).filter((row) => String(row?.variantId || "") === rowSpec.id && giniSkuKey(row?.parentSku) === parentKey);
    if (rows.length !== 1) return null;
    const row = rows[0];
    if (row.status !== "verified" || row.stage !== stage || String(row.rawBody || "") !== rowSpec.rawBody) return null;
    return row;
  }

  function planReconciliation({ parent, variants, owner, identities, approvals, journals } = {}) {
    const identity = resolveIdentity({ owner, identities });
    const approval = assessApproval(approvals, identity);
    const remote = assessState(parent, variants, stageOrder[stageOrder.length - 1], "after");
    const verified = stageOrder.map((stage) => verifiedJournal(journals, stage));
    const blockers = [
      ...(identity.ok ? [] : identity.blockers),
      ...(approval.ok ? [] : approval.blockers),
      ...(remote.ok ? [] : remote.blockers),
    ];
    if (verified.some((row) => !row)) blockers.push("verified_journal_mismatch");
    const history = (approvals || []).filter((row) => giniSkuKey(row?.parentSku) === parentKey).map((row) => ({
      variantId: String(row.variantId || ""),
      status: row.status || "",
      baselinePrice: row.baselinePrice ?? null,
      baselineQuantity: row.baselineQuantity ?? null,
      proposedPrice: row.proposedPrice ?? null,
      rawBody: row.rawBody || "",
    }));
    const ready = blockers.length === 0;
    const observation = (stage) => ({
      collection: "ginivariantidentities",
      action: "set_verified_observation",
      filter: {
        productId: identity.productId,
        approvedSku: spec[stage].sku,
        confirmedGiniVariantId: spec[stage].id,
      },
      set: { lastVerifiedPrice: spec.targetPrice, lastVerifiedQuantity: spec.stock },
      preserve: ["productId", "sourceVariantId", "sourceSizeId", "approvedSku", "confirmedGiniVariantId", "status"],
    });
    return {
      ok: ready,
      canApply: false,
      writesEnabled: false,
      applied: false,
      parentSku: spec.parentSku,
      blockers,
      historyPreserved: true,
      history,
      updates: ready ? stageOrder.map(observation) : [],
    };
  }

  return {
    disabledCode,
    requiresCommission: spec.commissionPercentage != null,
    writesEnabled,
    stageName,
    operationKey,
    readParent,
    readVariants,
    assessState,
    resolveIdentity,
    assessApproval,
    assessCommission,
    request,
    journalBlocks,
    nextStage,
    planReconciliation,
    stageOrder,
  };
}

const ke20Pilot = defineStagedPricePilot(KE20_PRICE_PILOT, ["blue", "black"], {
  enabledEnv: "GINI_KE20_PRICE_PATCH_ENABLED",
  allowEnv: "GINI_ALLOW_LIVE_KE20_PRICE_PATCH",
  path: KE20_PRICE_PATCH_PATH,
});

const ei8888Pilot = defineStagedPricePilot(EI8888_PRICE_PILOT, ["blue", "purple"], {
  enabledEnv: "GINI_EI8888_PRICE_PATCH_ENABLED",
  allowEnv: "GINI_ALLOW_LIVE_EI8888_PRICE_PATCH",
  path: EI8888_PRICE_PATCH_PATH,
});

export const ke20PricePatchApi = ke20Pilot;
export const ei8888PricePatchApi = ei8888Pilot;

export function ke20PricePatchWritesEnabled(env = process.env) {
  return ke20Pilot.writesEnabled(env);
}

export function ke20PriceStage(value) {
  return ke20Pilot.stageName(value);
}

export function ke20PriceOperationKey(stage) {
  return ke20Pilot.operationKey(stage);
}

export function readKe20PriceParent(response) {
  return ke20Pilot.readParent(response);
}

export function readKe20PriceVariants(response) {
  return ke20Pilot.readVariants(response);
}

export function assessKe20PriceState(parent, variants, stage, phase) {
  return ke20Pilot.assessState(parent, variants, stage, phase);
}

export function resolveKe20PriceIdentity(input = {}) {
  return ke20Pilot.resolveIdentity(input);
}

export function assessKe20PriceOwnership(input = {}) {
  return ke20Pilot.resolveIdentity(input);
}

export function assessKe20PriceApproval(approvals, identity) {
  return ke20Pilot.assessApproval(approvals, identity);
}

export function ke20PriceRequest(stage) {
  return ke20Pilot.request(stage);
}

export function ke20PriceJournalBlocks(status) {
  return ke20Pilot.journalBlocks(status);
}

export function ke20PriceNextStage(blueStatus, blackStatus) {
  return ke20Pilot.nextStage({ blue: blueStatus, black: blackStatus });
}

export function planKe20PostPatchReconciliation(input = {}) {
  return ke20Pilot.planReconciliation(input);
}

export function ei8888PricePatchWritesEnabled(env = process.env) {
  return ei8888Pilot.writesEnabled(env);
}

export function ei8888PriceStage(value) {
  return ei8888Pilot.stageName(value);
}

export function ei8888PriceOperationKey(stage) {
  return ei8888Pilot.operationKey(stage);
}

export function readEi8888PriceParent(response) {
  return ei8888Pilot.readParent(response);
}

export function readEi8888PriceVariants(response) {
  return ei8888Pilot.readVariants(response);
}

export function assessEi8888PriceState(parent, variants, stage, phase) {
  return ei8888Pilot.assessState(parent, variants, stage, phase);
}

export function resolveEi8888PriceIdentity(input = {}) {
  return ei8888Pilot.resolveIdentity(input);
}

export function assessEi8888PriceOwnership(input = {}) {
  return ei8888Pilot.resolveIdentity(input);
}

export function assessEi8888PriceApproval(approvals, identity) {
  return ei8888Pilot.assessApproval(approvals, identity);
}

export function assessEi8888CommissionSnapshot(snapshot) {
  return ei8888Pilot.assessCommission(snapshot);
}

export function ei8888PriceRequest(stage) {
  return ei8888Pilot.request(stage);
}

export function ei8888PriceJournalBlocks(status) {
  return ei8888Pilot.journalBlocks(status);
}

export function ei8888PriceNextStage(blueStatus, purpleStatus) {
  return ei8888Pilot.nextStage({ blue: blueStatus, purple: purpleStatus });
}

export function planEi8888PostPatchReconciliation(input = {}) {
  return ei8888Pilot.planReconciliation(input);
}
