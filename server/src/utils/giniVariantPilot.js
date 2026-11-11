import { mappingFromTree } from "./giniSyncEvaluate.js";
import { giniSkuKey } from "./giniSyncOnePlan.js";
import { explicitRemoteAttributeId } from "./giniVariantTestContract.js";

export const GINI_VARIANT_PILOT_LIMIT = 5;
export const GINI_VARIANT_PILOT_COLOR_ATTRIBUTE_ID = "3696";

/** The completed Xiaomi test stays outside this pilot. */
export const GINI_VARIANT_PILOT_EXCLUDED_PARENT_SKU = "75244";

/**
 * Controlled set. Slots 4 and 5 intentionally have no product id:
 * two vendors share the parent SKU and a person must choose one.
 */
export const GINI_VARIANT_PILOT_SLOTS = Object.freeze([
  Object.freeze({ order: 1, parentSku: "KE20", productId: "6adc7938b3764a909f6929d6" }),
  Object.freeze({ order: 2, parentSku: "EFR-575D-1ADF", productId: "6adc7944b3764a909f6930de" }),
  Object.freeze({ order: 3, parentSku: "EI-8888", productId: "6adc7945b3764a909f6931b1" }),
  Object.freeze({ order: 4, parentSku: "71868", productId: "" }),
  Object.freeze({ order: 5, parentSku: "69392", productId: "" }),
]);

const UNCERTAIN = new Set([
  "parent_lookup_uncertain",
  "variants_unread",
  "parent_uncertain",
  "variants_uncertain",
  "parent_in_progress",
  "variants_in_progress",
]);

export function giniColorValueLabels(attribute) {
  const body = attribute?.data && typeof attribute.data === "object" ? attribute.data : attribute || {};
  const values = Array.isArray(body.values) ? body.values : [];
  return values
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      return String(item?.value || item?.name || "").trim();
    })
    .filter(Boolean);
}

export function canonicalGiniColor(color, labels) {
  const wanted = String(color || "").trim().toLowerCase();
  if (!wanted) return "";
  return (labels || []).find((label) => label.toLowerCase() === wanted) || "";
}

function visibilityOf(value) {
  if (value === 0 || value === false || value === "0" || value === "false") return "hidden";
  if (value === 1 || value === true || value === "1" || value === "true") return "visible";
  return "unverified";
}

export function remoteRecordFromGet(parentResponse, variantResponse = null) {
  if (!parentResponse || parentResponse.error) return { exists: false, state: "uncertain", status: Number(parentResponse?.status) || 0 };
  if (parentResponse.status === 404) return { exists: false, state: "absent", status: 404 };
  if (parentResponse.status !== 200) return { exists: false, state: "uncertain", status: Number(parentResponse.status) || 0 };
  const data = parentResponse.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.sku) {
    return { exists: false, state: "uncertain", status: 200 };
  }
  const quantity = Number(data.quantity);
  let variants = null;
  if (variantResponse) {
    if (variantResponse.status !== 200 || !Array.isArray(variantResponse.json?.data)) variants = { state: "uncertain", rows: null };
    else variants = { state: variantResponse.json.data.length ? "present" : "empty", rows: variantResponse.json.data };
  }
  return {
    exists: true,
    state: "present",
    status: 200,
    sku: String(data.sku),
    id: data.id == null ? "" : String(data.id),
    quantity: Number.isFinite(quantity) ? quantity : null,
    visibility: visibilityOf(data.is_visible ?? data.isVisible),
    variants,
  };
}

export function classifyPilotRemoteVariants(rows, expected) {
  if (!Array.isArray(rows)) return "uncertain";
  if (!rows.length) return "empty";
  const seen = new Set();
  for (const row of rows) {
    const key = giniSkuKey(row?.sku);
    const match = (expected || []).find((item) => giniSkuKey(item.proposedSku) === key);
    const color = String(row?.attributes?.[0]?.value || row?.value || "").trim().toLowerCase();
    const attributeId = explicitRemoteAttributeId(row);
    if (!match || !key || seen.has(key)) return "unrelated";
    if (color && color !== String(match.giniColor || "").toLowerCase()) return "unrelated";
    if (attributeId && attributeId !== String(match.attributeId || "")) return "unrelated";
    if (Number(row?.quantity) !== Number(match.stock)) return "unrelated";
    seen.add(key);
  }
  if (seen.size !== expected.length) return "partial";
  return "match";
}

function activeCandidate(candidates) {
  if (candidates.length === 1) return candidates[0];
  const owners = candidates.filter((row) => !row.blockers?.includes("duplicate_parent_sku") && !row.blockers?.includes("other_vendor_owns_parent"));
  return owners.length === 1 ? owners[0] : null;
}

function withColor(row, labels) {
  const giniColor = canonicalGiniColor(row.color, labels);
  return { ...row, giniColor, attributeId: giniColor ? row.attributeId || GINI_VARIANT_PILOT_COLOR_ATTRIBUTE_ID : row.attributeId || "" };
}

function assessSlot({ slot, products, texts, labels, attributeOk, categories, categoriesUnavailable, remote, operationStatus }) {
  const pinned = String(slot.productId || "");
  const candidates = (products || []).filter((row) => {
    if (giniSkuKey(row.parentSku) !== giniSkuKey(slot.parentSku)) return false;
    if (pinned && row.productId !== pinned) return false;
    return true;
  });
  const active = activeCandidate(candidates);
  const source = active || candidates[0] || null;
  const text = texts?.[source?.productId] || {};
  const combinations = (source?.combinations || []).map((row) => withColor(row, labels));
  const blockers = [];
  if (giniSkuKey(slot.parentSku) === giniSkuKey(GINI_VARIANT_PILOT_EXCLUDED_PARENT_SKU)) blockers.push("pilot_product_excluded");
  if (!source) blockers.push("product_not_in_catalog");
  if (pinned && source && giniSkuKey(source.parentSku) !== giniSkuKey(slot.parentSku)) blockers.push("parent_sku_mismatch");
  if (!pinned && candidates.length > 1 && !active) blockers.push("duplicate_parent_sku");
  if (source?.blockers?.includes("duplicate_parent_sku")) blockers.push("duplicate_parent_sku");
  if (source?.blockers?.includes("other_vendor_owns_parent")) blockers.push("other_vendor_owns_parent");
  if (source?.multipleSizes || source?.blockers?.includes("size_attribute_unverified")) blockers.push("size_attribute_unverified");
  if (categoriesUnavailable) blockers.push("categories_unavailable");
  else if (source?.categoryId || source?.subcategoryId) {
    const mapped = mappingFromTree({ categoryId: source.categoryId, subcategoryId: source.subcategoryId }, categories || []);
    blockers.push(...mapped.blockers);
  } else if (source) blockers.push("missing_mapping");
  if (!attributeOk) blockers.push("color_attribute_mismatch");
  if (combinations.some((row) => !row.giniColor)) blockers.push("color_not_on_gini");
  if (source && !String(text.name || source.name || "").trim()) blockers.push("missing_name");
  if (source && !String(text.description || "").trim()) blockers.push("missing_description");
  if (source?.blockers?.includes("missing_image") || combinations.some((row) => row.images < 1)) blockers.push("missing_image");
  if (source?.blockers?.includes("zero_stock") || combinations.some((row) => row.stock < 1)) blockers.push("zero_stock");
  if (source?.blockers?.includes("invalid_price") || combinations.some((row) => !Number.isInteger(row.price) || row.price < 1)) blockers.push("invalid_price");
  if (combinations.length < 2) blockers.push("not_multi_variant");
  if (source?.blockers?.includes("missing_variant_sku_approval")) blockers.push("missing_variant_sku_approval");
  if (source?.blockers?.includes("variant_sku_conflict")) blockers.push("variant_sku_conflict");
  if (!remote || remote.state === "uncertain") blockers.push("parent_lookup_uncertain");
  else if (remote.state === "present" && giniSkuKey(remote.sku) !== giniSkuKey(slot.parentSku)) blockers.push("parent_sku_mismatch");
  else if (remote.state === "present") {
    const variantState = remote.variants?.state === "present"
      ? classifyPilotRemoteVariants(remote.variants.rows, combinations)
      : remote.variants?.state || "uncertain";
    const expectedQuantity = variantState === "match" ? combinations.reduce((sum, row) => sum + Number(row.stock), 0) : 0;
    if (remote.visibility === "visible") blockers.push("parent_visible_unexpected");
    else if (remote.visibility !== "hidden" || remote.quantity !== expectedQuantity) blockers.push("parent_quantity_mismatch");
    if (variantState === "uncertain") blockers.push("variants_unread");
    else if (variantState === "partial" || variantState === "unrelated") blockers.push("remote_variants_not_replaced");
  }
  if (UNCERTAIN.has(operationStatus)) blockers.push(operationStatus);
  const variantState = remote?.state === "present"
    ? (remote.variants?.state === "present" ? classifyPilotRemoteVariants(remote.variants.rows, combinations) : remote.variants?.state || "uncertain")
    : "";
  const expectedQuantity = variantState === "match" ? combinations.reduce((sum, row) => sum + Number(row.stock), 0) : null;
  const verified = operationStatus === "variants_verified" && variantState === "match" && remote?.visibility === "hidden" && remote?.quantity === expectedQuantity;
  return {
    order: slot.order,
    parentSku: slot.parentSku,
    productId: active?.productId || "",
    name: text.name || source?.name || "",
    description: text.description || "",
    vendor: active?.vendor || "",
    vendorId: active?.vendorId || "",
    categoryId: source?.categoryId || "",
    subcategoryId: source?.subcategoryId || "",
    status: active?.status || (candidates.length > 1 ? "NEEDS_REVIEW" : source?.status || "BLOCKED"),
    blockers: [...new Set(blockers)],
    combinations,
    candidates: candidates.map((row) => ({
      productId: row.productId,
      vendor: row.vendor,
      name: row.name,
      status: row.status,
      blockers: row.blockers || [],
    })),
    remote: remote
      ? {
          state: remote.state,
          status: remote.status || 0,
          id: remote.id || "",
          visibility: remote.visibility || "",
          quantity: remote.quantity ?? null,
          variantState: remote.variants?.state || (remote.state === "absent" ? "absent" : "unread"),
        }
      : null,
    operationStatus: operationStatus || "idle",
    verified,
    ownerRequired: !pinned && candidates.length > 1 && !active,
  };
}

export function buildPilotView({
  products = [],
  texts = {},
  attribute = null,
  categories = [],
  categoriesUnavailable = false,
  remoteBySku = {},
  operations = [],
  writesEnabled = false,
  categoryCounts = null,
  catalogSummary = null,
} = {}) {
  const body = attribute?.data && typeof attribute.data === "object" ? attribute.data : attribute || {};
  const labels = giniColorValueLabels(body);
  const attributeOk = String(body.id || "") === GINI_VARIANT_PILOT_COLOR_ATTRIBUTE_ID && body.name === "Color" && labels.length > 0;
  const operationByProduct = new Map((operations || []).map((row) => [String(row.productId), row.status || ""]));
  const assessed = GINI_VARIANT_PILOT_SLOTS.map((slot) => {
    const candidates = (products || []).filter((row) => giniSkuKey(row.parentSku) === giniSkuKey(slot.parentSku));
    const active = slot.productId ? candidates.find((row) => row.productId === slot.productId) : activeCandidate(candidates);
    return assessSlot({
      slot,
      products,
      texts,
      labels,
      attributeOk,
      categories,
      categoriesUnavailable,
      remote: remoteBySku[slot.parentSku] || remoteBySku[giniSkuKey(slot.parentSku)] || null,
      operationStatus: operationByProduct.get(String(active?.productId || "")) || "",
    });
  });
  let stopped = false;
  let stopCode = "";
  const slots = assessed.map((slot) => {
    if (slot.verified) return { ...slot, queue: stopped ? "waiting" : "verified", queueCode: stopped ? stopCode : "" };
    if (stopped) return { ...slot, queue: "waiting", queueCode: stopCode, stageAReady: false, stageBReady: false };
    const uncertain = slot.blockers.some((code) => UNCERTAIN.has(code));
    if (uncertain) {
      stopped = true;
      stopCode = "pilot_stopped_uncertain";
      return { ...slot, queue: "stopped", queueCode: stopCode, stageAReady: false, stageBReady: false };
    }
    if (slot.blockers.length) {
      stopped = true;
      stopCode = "pilot_waiting_for_previous";
      return { ...slot, queue: "blocked", queueCode: "pilot_waiting_for_previous", stageAReady: false, stageBReady: false };
    }
    stopped = true;
    stopCode = "pilot_waiting_for_previous";
    const parentReady = slot.operationStatus !== "parent_verified" && slot.operationStatus !== "variants_verified";
    const variantsReady = slot.operationStatus === "parent_verified";
    return {
      ...slot,
      queue: "next",
      queueCode: "",
      stageAReady: writesEnabled === true && parentReady,
      stageBReady: writesEnabled === true && variantsReady,
    };
  }).map((slot) => ({
    ...slot,
    stageAReady: slot.stageAReady === true,
    stageBReady: slot.stageBReady === true,
  }));
  return {
    ok: true,
    limit: GINI_VARIANT_PILOT_LIMIT,
    sentToGini: 0,
    canSend: false,
    bulkSyncEnabled: false,
    writesEnabled: writesEnabled === true,
    writeGate: "Both GINI_VARIANT_SYNC_WRITES_ENABLED and GINI_ALLOW_LIVE_VARIANT_SYNC are required. Neither is turned on by this preview.",
    confirmation: "Each product needs its own confirmation. One uncertain result stops the later products.",
    excludedParentSku: GINI_VARIANT_PILOT_EXCLUDED_PARENT_SKU,
    colorAttribute: { id: GINI_VARIANT_PILOT_COLOR_ATTRIBUTE_ID, name: "Color", values: labels, live: attributeOk },
    categoryCounts,
    catalogSummary,
    steps: [
      "Refresh the pilot preview. It reads GINI with GET and does not send a product.",
      "For a shared parent SKU, choose one vendor. The other vendor listing is not merged or sent.",
      "Approve that product's proposed variant SKUs. The approval is stored in BrownStore.",
      "Turn on both variant-sync write gates only when this pilot is authorized.",
      "Confirm Stage A for the current product and wait until a GET shows the hidden parent.",
      "Confirm Stage B for that same product and wait until a GET shows every variant.",
      "Repeat for the next product. An uncertain result stops the pilot and is not retried.",
    ],
    products: slots,
  };
}
