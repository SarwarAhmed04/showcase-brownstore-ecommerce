import { giniSkuKey } from "./giniSyncOnePlan.js";
import { explicitRemoteAttributeId } from "./giniVariantTestContract.js";
import { giniColorValueLabels } from "./giniVariantPilot.js";
import { buildSingleVariantStockPatch } from "./giniVariantUpdateContract.js";

export const KNOWN_GINI_VARIANT_PARENTS = Object.freeze([
  Object.freeze({ parentSku: "KE20", label: "HOT PLATES" }),
  Object.freeze({ parentSku: "EFR-575D-1ADF", label: "Chronograph Watch" }),
  Object.freeze({ parentSku: "EI-8888", label: "Steam Iron" }),
  Object.freeze({ parentSku: "71868", label: "F8 Ultra" }),
  Object.freeze({ parentSku: "69392", label: "C85 Smartphone" }),
  Object.freeze({ parentSku: "75244", label: "Xiaomi 17T Pro" }),
]);

const OPERATION_UNCERTAIN = new Set([
  "parent_uncertain",
  "variants_uncertain",
  "parent_in_progress",
  "variants_in_progress",
]);

const HARD_BLOCKS = new Set([
  "missing_mapping",
  "missing_image",
  "invalid_price",
  "not_multi_variant",
  "duplicate_parent_sku",
  "other_vendor_owns_parent",
  "size_attribute_unverified",
  "variant_sku_conflict",
  "missing_variant_sku_approval",
  "missing_color_mapping",
  "unknown_remote_variant",
  "removed_color_needs_review",
  "conflicting_identity",
  "parent_visible_unexpected",
  "parent_visibility_unverified",
  "attribute_id_mismatch",
  "color_mismatch",
  "duplicate_remote_variant_sku",
  "attribute_id_unverified",
  "ownership_unverified",
  "variant_baseline_conflict",
]);

const UNCERTAIN_BLOCKS = new Set([
  "incomplete_api_response",
  "known_parent_not_reconciled",
  "color_attribute_unread",
  "parent_sku_mismatch",
  "variant_patch_uncertain",
  "variant_patch_in_progress",
  ...OPERATION_UNCERTAIN,
]);

export function isKnownVariantParent(sku) {
  const key = giniSkuKey(sku);
  return KNOWN_GINI_VARIANT_PARENTS.some((row) => giniSkuKey(row.parentSku) === key);
}

function visibilityOf(value) {
  if (value === 0 || value === false || value === "0" || value === "false") return "hidden";
  if (value === 1 || value === true || value === "1" || value === "true") return "visible";
  return "unverified";
}

function attributeValue(row) {
  const raw = row?.attributes?.[0]?.value ?? row?.value ?? row?.color ?? "";
  if (typeof raw === "string" || typeof raw === "number") return String(raw).trim();
  if (raw && typeof raw === "object") return String(raw.en || raw.name || raw.value || "").trim();
  return "";
}

function presentId(value) {
  if (value == null || value === "") return "";
  return String(value);
}

export function interpretColorAttribute(response) {
  if (!response || response.status !== 200) return { state: "uncertain", id: "", name: "", labels: null, expectedPresent: false };
  const body = response.json?.data && typeof response.json.data === "object" ? response.json.data : response.json;
  const id = presentId(body?.id);
  const labels = id === "3696" ? giniColorValueLabels(body) : [];
  if (id !== "3696" || !labels.length) return { state: "uncertain", id, name: String(body?.name || ""), labels: null, expectedPresent: false };
  const expectedPresent = ["Blue", "Black", "Purple"].every((color) => labels.some((label) => label.toLowerCase() === color.toLowerCase()));
  return { state: "read", id: "3696", name: String(body?.name || "Color"), labels, expectedPresent };
}

export function colorMappingPreview(combinations, labels, attributeId = "") {
  const confirmedId = attributeId === "3696" && Array.isArray(labels) ? "3696" : "";
  const seen = new Set();
  const rows = [];
  for (const combo of combinations || []) {
    const color = String(combo?.color || "").trim();
    const key = color.toLowerCase();
    if (!color || seen.has(key)) continue;
    seen.add(key);
    if (!Array.isArray(labels)) {
      rows.push({ color, giniValue: "", attributeId: "", status: "attribute_unread" });
      continue;
    }
    const match = labels.find((label) => label.toLowerCase() === key) || "";
    rows.push(match
      ? { color, giniValue: match, attributeId: confirmedId, status: "mapped" }
      : { color, giniValue: "", attributeId: "", status: "missing" });
  }
  return rows;
}

export function readRemoteParent(response, expectedSku = "") {
  if (!response || response.error) return { state: "uncertain", status: Number(response?.status) || 0, variants: null };
  if (response.status === 404) return { state: "absent", status: 404, variants: null };
  if (response.status !== 200) return { state: "uncertain", status: Number(response.status) || 0, variants: null };
  const data = response.json?.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.sku) return { state: "uncertain", status: 200, variants: null };
  if (expectedSku && giniSkuKey(data.sku) !== giniSkuKey(expectedSku)) {
    return { state: "uncertain", status: 200, sku: String(data.sku), code: "parent_sku_mismatch", variants: null };
  }
  const quantity = Number(data.quantity);
  const price = Number(data.price);
  const categoryId = data.category_id ?? data.category?.id;
  const subcategoryId = data.subcategory_id ?? data.subcategory?.id;
  return {
    state: "present",
    status: 200,
    sku: String(data.sku),
    id: presentId(data.id),
    quantity: Number.isFinite(quantity) ? quantity : null,
    price: Number.isFinite(price) ? price : null,
    visibility: visibilityOf(data.is_visible ?? data.isVisible),
    categoryId: categoryId == null || categoryId === "" ? "" : String(categoryId),
    subcategoryId: subcategoryId == null || subcategoryId === "" ? "" : String(subcategoryId),
    categoryKnown: categoryId != null && categoryId !== "",
    subcategoryKnown: subcategoryId != null && subcategoryId !== "",
    variants: null,
  };
}

export function readRemoteVariantRows(response) {
  if (!response || response.error || response.status !== 200) return { state: "uncertain", rows: null };
  const body = response.json;
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.data?.variants)
        ? body.data.variants
        : null;
  if (!rows) return { state: "uncertain", rows: null };
  return { state: "present", rows };
}

function imageReport(row) {
  const keys = ["image", "image_url", "images"].filter((key) => Object.prototype.hasOwnProperty.call(row, key));
  if (!keys.length) return { state: "not_remotely_verifiable", urls: [] };
  const urls = [];
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) urls.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) urls.push(item.trim());
        else if (item?.url) urls.push(String(item.url).trim());
      }
    }
  }
  return { state: "present", urls };
}

export function presentRemoteVariant(row) {
  if (!row || typeof row !== "object") return { incomplete: true, sku: "", images: { state: "not_remotely_verifiable", urls: [] } };
  if (row.normalized === true) return row;
  const sku = String(row.sku || "").trim();
  const price = Number(row.price);
  const quantity = Number(row.quantity ?? row.stock);
  return {
    normalized: true,
    incomplete: !sku || !Number.isFinite(price) || !Number.isFinite(quantity),
    id: presentId(row.id ?? row.variant_id),
    sku,
    price: Number.isFinite(price) ? price : null,
    quantity: Number.isFinite(quantity) ? quantity : null,
    color: attributeValue(row),
    attributeId: explicitRemoteAttributeId(row),
    images: imageReport(row),
  };
}

function identityFor(identities, combo) {
  return (identities || []).find((row) => String(row.sourceVariantId) === String(combo.sourceVariantId) && String(row.sourceSizeId || "") === String(combo.sourceSizeId || ""));
}

function finish(disposition, details) {
  return {
    disposition,
    canSend: false,
    writes: [],
    noDeletion: true,
    recordTransfer: "not_copied",
    createAllowed: false,
    replacementPayload: null,
    workflow: "variant_dry_run",
    ...details,
  };
}

export function planVariantChange({
  productId = "",
  parentSku = "",
  vendorId = "",
  categoryId = "",
  subcategoryId = "",
  combinations = [],
  identities = [],
  remote = { state: "not_read" },
  colorLabels = null,
  colorAttributeId = "",
  catalogBlockers = [],
  multipleSizes = false,
  sizeContractVerified = false,
  operationStatus = "",
  environment = "local",
  identityOrigin = "local",
  variantSkuConflict = false,
  ownership = "",
  owner = null,
  variantOperations = [],
  pricePatchJournals = [],
} = {}) {
  const blockers = [];
  const changes = [];
  const manualReview = [];
  const differences = [];
  const imageNotes = [];
  const priceRows = [];
  const reviewNotes = ["Local identity rows are not copied to another database."];
  const known = isKnownVariantParent(parentSku);
  const colorPreview = colorMappingPreview(combinations, colorLabels, colorAttributeId);
  const honored = ["missing_mapping", "missing_image", "invalid_price", "not_multi_variant", "duplicate_parent_sku", "other_vendor_owns_parent", "variant_sku_conflict"];
  for (const code of honored) {
    if (catalogBlockers.includes(code)) blockers.push(code);
  }
  if (variantSkuConflict) blockers.push("variant_sku_conflict");
  if (multipleSizes && sizeContractVerified !== true) blockers.push("size_attribute_unverified");
  if (combinations.length < 2) blockers.push("not_multi_variant");
  const missingApproval = combinations.some((combo) => {
    const saved = identityFor(identities, combo);
    return !saved || !giniSkuKey(saved.approvedSku) || giniSkuKey(saved.approvedSku) !== giniSkuKey(combo.proposedSku);
  });
  if (missingApproval) blockers.push("missing_variant_sku_approval");
  if (colorPreview.some((row) => row.status === "missing")) blockers.push("missing_color_mapping");
  if (colorPreview.some((row) => row.status === "attribute_unread")) blockers.push("color_attribute_unread");
  if (OPERATION_UNCERTAIN.has(operationStatus)) blockers.push(operationStatus);
  if (ownership === "required") {
    const sameProduct = owner && String(owner.productId || "") === String(productId || "");
    const verified = owner?.status === "verified_remote";
    if (!sameProduct || !verified) blockers.push("ownership_unverified");
  }
  const localVerified = (identities || []).some((row) => row.status === "verified" || row.confirmedGiniVariantId);
  if (environment === "production" && identityOrigin === "local" && (localVerified || known)) {
    reviewNotes.push("Production must reconcile this parent by GET. Local rows are not production state.");
  }
  const remoteState = remote?.state || "not_read";
  if (remoteState === "not_read") blockers.push(known ? "known_parent_not_reconciled" : "remote_absence_unconfirmed");
  else if (remoteState === "uncertain") blockers.push(remote?.code || "incomplete_api_response");
  else if (remoteState === "absent") {
    if (known || localVerified) blockers.push("conflicting_identity");
  } else if (remoteState === "present") {
    const rows = Array.isArray(remote.variants) ? remote.variants.map(presentRemoteVariant) : null;
    if (!rows || rows.some((row) => row.incomplete)) blockers.push("incomplete_api_response");
    else comparePresent({ rows, combinations, identities, colorPreview, remote, categoryId, subcategoryId, blockers, changes, manualReview, differences, imageNotes, priceRows });
  }
  applyVariantOperationGuards({ variantOperations, priceRows, blockers, pricePatchJournals });
  const settledPricePatch = (variantIds, note) => {
    const settled = variantIds.every((variantId) => settledVerifiedPriceOperation(
      (variantOperations || []).find((op) => String(op?.variantId || "") === variantId),
      priceRows.find((row) => String(row.variantId) === variantId),
      pricePatchJournals
    ));
    if (settled) reviewNotes.push(note);
  };
  settledPricePatch(["164306", "164307"], "KE20's verified price PATCH journals match the fresh remote prices. The original 26500 approval baseline was kept.");
  settledPricePatch(["164312", "164313"], "EI-8888's verified price PATCH journals match the fresh remote prices. The original 119750 approval baseline was kept.");
  const unique = [...new Set(blockers)];
  let disposition = "UNCHANGED";
  if (unique.some((code) => UNCERTAIN_BLOCKS.has(code))) disposition = "UNCERTAIN";
  else if (unique.some((code) => HARD_BLOCKS.has(code))) disposition = "BLOCKED";
  else if (remoteState === "absent") disposition = "NEW";
  else if (remoteState !== "present") disposition = "BLOCKED";
  else if (changes.length) disposition = "CHANGED";
  if (disposition === "NEW") unique.push("bulk_variant_writes_disabled");
  return finish(disposition, {
    productId: String(productId || ""),
    parentSku: String(parentSku || ""),
    vendorId: String(vendorId || ""),
    knownParent: known,
    environment,
    identityOrigin,
    blockers: unique,
    changes,
    manualReview,
    differences,
    imageNotes,
    reviewNotes,
    colorPreview,
    priceRows,
    proposedPatches: priceRows.filter((row) => row.patch).map((row) => row.patch),
    baselineKey: variantBaselineKey(priceRows),
    local: combinations.map((combo) => ({
      sku: combo.proposedSku,
      color: combo.color,
      price: combo.price,
      stock: combo.stock,
      sourceVariantId: combo.sourceVariantId,
    })),
  });
}

function quotedPrice(combo) {
  const quote = combo?.pricing;
  if (quote && (quote.giniPrice != null || quote.priceReview === true)) {
    return Number.isInteger(Number(quote.giniPrice)) ? Number(quote.giniPrice) : null;
  }
  return Number.isInteger(Number(combo?.price)) ? Number(combo.price) : null;
}

function publishPatch(patch) {
  if (!patch?.ok) return null;
  return {
    method: patch.method,
    path: patch.path,
    rawBody: patch.rawBody,
    body: patch.body,
    liveSend: false,
    sendsOtherVariants: false,
    replacesVariantSet: false,
  };
}

const SETTLED_PRICE_PATCHES = Object.freeze({
  ke20: Object.freeze({
    baselinePrice: 26500,
    targetPrice: 28000,
    quantity: 10,
    bodies: Object.freeze({
      "164306": "{\"variant_id\":164306,\"price\":28000}",
      "164307": "{\"variant_id\":164307,\"price\":28000}",
    }),
  }),
  "ei-8888": Object.freeze({
    baselinePrice: 119750,
    targetPrice: 126500,
    quantity: 10,
    bodies: Object.freeze({
      "164312": "{\"variant_id\":164312,\"price\":126500}",
      "164313": "{\"variant_id\":164313,\"price\":126500}",
    }),
  }),
});

function settledVerifiedPriceOperation(op, row, journals) {
  const contract = SETTLED_PRICE_PATCHES[giniSkuKey(op?.parentSku)];
  const variantId = String(op?.variantId || "");
  const rawBody = contract?.bodies[variantId];
  if (!rawBody || op?.status !== "approved" || !row) return false;
  const journal = (journals || []).find((item) => String(item?.variantId || "") === variantId && giniSkuKey(item?.parentSku) === giniSkuKey(op?.parentSku));
  return Boolean(journal)
    && journal.status === "verified"
    && String(journal.rawBody || "") === rawBody
    && String(op.rawBody || "") === rawBody
    && Number(op.baselinePrice) === contract.baselinePrice
    && Number(op.baselineQuantity) === contract.quantity
    && Number(op.proposedPrice) === contract.targetPrice
    && row.changed !== true
    && !row.patch
    && Number(row.oldPrice) === contract.targetPrice
    && Number(row.newPrice) === contract.targetPrice
    && Number(row.oldStock) === contract.quantity
    && Number(row.newStock) === contract.quantity;
}

function applyVariantOperationGuards({ variantOperations, priceRows, blockers, pricePatchJournals }) {
  for (const op of variantOperations || []) {
    const status = String(op?.status || "");
    if (status === "in_progress") blockers.push("variant_patch_in_progress");
    if (status === "uncertain") blockers.push("variant_patch_uncertain");
    if (status === "conflict") blockers.push("variant_baseline_conflict");
    const row = (priceRows || []).find((item) => String(item.variantId) === String(op?.variantId || ""));
    if (!row || !["approved", "pending_approval", "verified"].includes(status)) continue;
    if (settledVerifiedPriceOperation(op, row, pricePatchJournals)) continue;
    const same = Number(op.baselinePrice) === Number(row.oldPrice)
      && Number(op.baselineQuantity) === Number(row.oldStock)
      && String(op.rawBody || "") === String(row.patch?.rawBody || "");
    if (!same) blockers.push("variant_baseline_conflict");
  }
}

export function variantBaselineKey(rows) {
  return (rows || []).map((row) => `${row.variantId}:${row.oldPrice}:${row.oldStock}`).join("|");
}

function comparePresent({ rows, combinations, identities, colorPreview, remote, categoryId, subcategoryId, blockers, changes, manualReview, differences, imageNotes, priceRows }) {
  const remoteBySku = new Map();
  for (const row of rows) {
    const key = giniSkuKey(row.sku);
    if (!key) continue;
    if (remoteBySku.has(key)) blockers.push("duplicate_remote_variant_sku");
    remoteBySku.set(key, row);
  }
  for (const [key, row] of remoteBySku) {
    const combo = combinations.find((item) => giniSkuKey(item.proposedSku) === key);
    const saved = (identities || []).find((item) => giniSkuKey(item.approvedSku) === key);
    if (!combo && !saved) {
      blockers.push("unknown_remote_variant");
      manualReview.push({ sku: row.sku, action: "keep", reason: "unknown_remote_variant" });
      differences.push({ code: "unknown_remote_variant", sku: row.sku, detail: "This remote variant is not an approved BrownStore color. It was kept." });
      continue;
    }
    if (!combo && saved) {
      blockers.push("removed_color_needs_review");
      manualReview.push({ sku: row.sku, action: "keep", reason: "removed_color" });
      changes.push({ kind: "removed_color", sku: row.sku, field: "color", from: row.color, to: "", action: "manual_review" });
      differences.push({ code: "removed_color", sku: row.sku, detail: "This color is on GINI and is missing locally. It was not deleted." });
      continue;
    }
    const savedId = String(saved?.confirmedGiniVariantId || "");
    const remoteId = String(row.id || "");
    const identityConflict = Boolean(savedId && remoteId && savedId !== remoteId);
    if (identityConflict) {
      blockers.push("conflicting_identity");
      differences.push({ code: "conflicting_identity", sku: row.sku, detail: `Local variant id ${savedId} does not match remote id ${remoteId}.` });
    }
    const mapped = colorPreview.find((item) => item.color.toLowerCase() === String(combo.color || "").toLowerCase());
    const expectedAttributeId = mapped?.attributeId || "";
    if (row.attributeId && expectedAttributeId && row.attributeId !== expectedAttributeId) blockers.push("attribute_id_mismatch");
    if (!row.attributeId) blockers.push("attribute_id_unverified");
    if (row.color && mapped?.giniValue && row.color.toLowerCase() !== mapped.giniValue.toLowerCase()) {
      blockers.push("color_mismatch");
      differences.push({ code: "color_mismatch", sku: row.sku, detail: `Remote color ${row.color} does not match ${mapped.giniValue}.` });
    }
    const nextPrice = quotedPrice(combo);
    const nextStock = Number.isInteger(Number(combo.stock)) ? Number(combo.stock) : null;
    const priceChanged = nextPrice != null && row.price !== nextPrice;
    const stockChanged = nextStock != null && row.quantity !== nextStock;
    const zero = stockChanged && nextStock === 0;
    if (priceChanged) {
      changes.push({
        kind: "price",
        sku: row.sku,
        field: "price",
        from: row.price,
        to: nextPrice,
        variantId: savedId,
        action: savedId ? "documented_not_sent" : "blocked_missing_variant_id",
        commission: combo.pricing?.commission || null,
      });
      const rule = combo.pricing?.commission;
      const ruleText = rule ? ` Saved ${rule.percentage}% ${rule.scope} commission was applied to base ${combo.pricing?.basePrice}.` : "";
      differences.push({ code: "price_change", sku: row.sku, detail: `Price ${row.price} would become ${nextPrice}.${ruleText} The documented call is one PATCH by remote variant id, and it has not been sent.` });
    }
    if (row.images?.state === "present" && Number.isInteger(Number(combo.images)) && row.images.urls.length !== Number(combo.images)) {
      imageNotes.push({ sku: row.sku, remoteImages: row.images.urls.length, localImages: Number(combo.images) });
    }
    if (stockChanged) {
      changes.push({
        kind: zero ? "quantity_zero" : "quantity",
        sku: row.sku,
        field: "quantity",
        from: row.quantity,
        to: nextStock,
        variantId: savedId,
        action: zero ? "quantity_zero_not_stated" : savedId ? "documented_not_sent" : "blocked_missing_variant_id",
      });
      differences.push({
        code: zero ? "quantity_zero" : "quantity_change",
        sku: row.sku,
        detail: zero
          ? `Quantity ${row.quantity} would become 0. Update Variant Stock does not state that 0 is accepted, so it was not sent.`
          : `Quantity ${row.quantity} would become ${nextStock}. The documented call is one PATCH by remote variant id, and it has not been sent.`,
      });
    }
    let withheldReason = "";
    let patch = null;
    if (priceChanged || stockChanged) {
      if (zero) withheldReason = "quantity_zero_not_stated";
      else if (!identityConflict && savedId && remoteId && savedId === remoteId) {
        const built = buildSingleVariantStockPatch({
          parentSku: remote.sku,
          variantId: savedId,
          price: priceChanged ? nextPrice : undefined,
          quantity: stockChanged ? nextStock : undefined,
        });
        patch = publishPatch(built);
        if (!patch) withheldReason = built.code || "patch_not_ready";
      } else if (identityConflict) withheldReason = "conflicting_identity";
      else withheldReason = "missing_remote_variant_id";
    }
    priceRows.push({
      sku: row.sku,
      variantId: savedId || remoteId,
      color: combo.color || row.color || "",
      oldPrice: row.price,
      newPrice: nextPrice,
      oldStock: row.quantity,
      newStock: nextStock,
      basePrice: combo.pricing?.basePrice ?? null,
      usedOwnPrice: combo.pricing?.usedOwnPrice === true,
      commission: combo.pricing?.commission || null,
      changed: priceChanged || stockChanged,
      preserved: !priceChanged && !stockChanged,
      patch,
      withheldReason,
    });
  }
  for (const combo of combinations) {
    const key = giniSkuKey(combo.proposedSku);
    if (!key || remoteBySku.has(key)) continue;
    const mapped = colorPreview.find((item) => item.color.toLowerCase() === String(combo.color || "").toLowerCase());
    changes.push({
      kind: "new_color",
      sku: combo.proposedSku,
      field: "color",
      from: "",
      to: mapped?.giniValue || combo.color,
      action: "blocked_unsupported",
      attributeId: mapped?.attributeId || "",
    });
    differences.push({ code: "new_color", sku: combo.proposedSku, detail: `Color ${combo.color} is not on this GINI parent. Adding it by replacing the variant set is unsupported.` });
  }
  if (remote.visibility === "visible") blockers.push("parent_visible_unexpected");
  else if (remote.visibility !== "hidden") blockers.push("parent_visibility_unverified");
  if (remote.categoryKnown && categoryId && String(remote.categoryId) !== String(categoryId)) {
    changes.push({ kind: "category", sku: "", field: "category_id", from: remote.categoryId, to: String(categoryId), action: "blocked_unsupported" });
    differences.push({ code: "category_mismatch", sku: "", detail: `Remote category ${remote.categoryId} does not match local category ${categoryId}.` });
  }
  if (remote.subcategoryKnown && subcategoryId && String(remote.subcategoryId) !== String(subcategoryId)) {
    changes.push({ kind: "subcategory", sku: "", field: "subcategory_id", from: remote.subcategoryId, to: String(subcategoryId), action: "blocked_unsupported" });
    differences.push({ code: "subcategory_mismatch", sku: "", detail: `Remote subcategory ${remote.subcategoryId} does not match local subcategory ${subcategoryId}.` });
  }
  const expectedParentQty = combinations.reduce((sum, row) => sum + (Number.isFinite(Number(row.stock)) ? Number(row.stock) : 0), 0);
  if (remote.quantity != null && remote.quantity !== expectedParentQty) {
    changes.push({ kind: "parent_quantity", sku: "", field: "quantity", from: remote.quantity, to: expectedParentQty, action: "blocked_unsupported" });
    differences.push({ code: "parent_quantity_mismatch", sku: "", detail: `Parent quantity ${remote.quantity} does not equal the current variant stock ${expectedParentQty}.` });
  }
}

const PRIMARY_BLOCKER_GATES = Object.freeze([
  Object.freeze({ id: "duplicate_parent_sku", test: (codes) => codes.has("duplicate_parent_sku") }),
  Object.freeze({ id: "missing_vendor_ownership", test: (codes) => codes.has("other_vendor_owns_parent") }),
  Object.freeze({ id: "missing_size_attribute", test: (codes) => codes.has("size_attribute_unverified") }),
  Object.freeze({ id: "unmapped_colors", test: (codes) => codes.has("missing_color_mapping") }),
  Object.freeze({ id: "missing_approved_variant_skus", test: (codes) => codes.has("missing_variant_sku_approval") }),
  Object.freeze({ id: "missing_vendor_ownership", test: (codes) => codes.has("ownership_unverified") }),
]);

const NAMED_BLOCKER_CODES = new Set([
  "duplicate_parent_sku",
  "other_vendor_owns_parent",
  "ownership_unverified",
  "missing_variant_sku_approval",
  "missing_color_mapping",
  "size_attribute_unverified",
]);

const STRUCTURAL_CHANGE_KINDS = new Set([
  "new_color",
  "removed_color",
  "quantity_zero",
  "category",
  "subcategory",
  "parent_quantity",
]);

function emptyBlockerBuckets() {
  return {
    duplicate_parent_sku: 0,
    missing_vendor_ownership: 0,
    missing_approved_variant_skus: 0,
    unmapped_colors: 0,
    missing_size_attribute: 0,
    other: 0,
  };
}

export function primaryBlockerCategory(blockers = []) {
  const codes = new Set(blockers || []);
  for (const gate of PRIMARY_BLOCKER_GATES) {
    if (gate.test(codes)) return gate.id;
  }
  return "other";
}

export function auditBlockedProducts(plans = []) {
  const blocked = (plans || []).filter((plan) => plan.disposition === "BLOCKED");
  const primary = emptyBlockerBuckets();
  const overlapping = emptyBlockerBuckets();
  const otherCodes = {};
  const samples = emptyBlockerBuckets();
  for (const key of Object.keys(samples)) samples[key] = [];
  for (const plan of blocked) {
    const codes = new Set(plan.blockers || []);
    const category = primaryBlockerCategory(plan.blockers);
    primary[category] += 1;
    if (samples[category].length < 8 && plan.parentSku) samples[category].push(plan.parentSku);
    if (codes.has("duplicate_parent_sku")) overlapping.duplicate_parent_sku += 1;
    if (codes.has("other_vendor_owns_parent") || codes.has("ownership_unverified")) overlapping.missing_vendor_ownership += 1;
    if (codes.has("missing_variant_sku_approval")) overlapping.missing_approved_variant_skus += 1;
    if (codes.has("missing_color_mapping")) overlapping.unmapped_colors += 1;
    if (codes.has("size_attribute_unverified")) overlapping.missing_size_attribute += 1;
    const extras = [...codes].filter((code) => !NAMED_BLOCKER_CODES.has(code));
    if (extras.length) overlapping.other += 1;
    for (const code of extras) otherCodes[code] = (otherCodes[code] || 0) + 1;
  }
  return {
    blocked: blocked.length,
    exclusive: true,
    primary,
    primaryTotal: Object.values(primary).reduce((sum, count) => sum + count, 0),
    overlapping,
    otherCodes,
    samples,
    precedence: [
      "duplicate_parent_sku",
      "other_vendor_owns_parent",
      "size_attribute_unverified",
      "missing_color_mapping",
      "missing_variant_sku_approval",
      "ownership_unverified",
      "other",
    ],
  };
}

function sharedParentKeySet(products = []) {
  const counts = new Map();
  for (const product of products || []) {
    const key = giniSkuKey(product?.parentSku);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([key]) => key));
}

export function variantReadCandidates({ products = [], identitiesByProduct = new Map(), owners = [], colorLabels = null, colorAttributeId = "" } = {}) {
  if (!Array.isArray(colorLabels) || colorAttributeId !== "3696") return [];
  const shared = sharedParentKeySet(products);
  const skus = [];
  for (const product of products || []) {
    const parentSku = String(product?.parentSku || "");
    const key = giniSkuKey(parentSku);
    if (!key || isKnownVariantParent(parentSku) || shared.has(key)) continue;
    if (product?.multipleSizes === true) continue;
    const catalogBlockers = product?.blockers || [];
    if (["duplicate_parent_sku", "other_vendor_owns_parent", "variant_sku_conflict", "not_multi_variant"].some((code) => catalogBlockers.includes(code))) continue;
    const combinations = product?.combinations || [];
    if (combinations.length < 2) continue;
    const owner = (owners || []).find((row) => giniSkuKey(row.parentSku || row.skuKey) === key && String(row.productId || "") === String(product.productId || ""));
    if (!owner || owner.status !== "verified_remote" || !String(owner.giniProductId || "")) continue;
    const identities = identitiesByProduct.get(String(product.productId || "")) || [];
    const colors = colorMappingPreview(combinations, colorLabels, colorAttributeId);
    if (colors.some((row) => row.status !== "mapped")) continue;
    const verified = combinations.every((combo) => {
      const saved = identityFor(identities, combo);
      return Boolean(saved)
        && saved.status === "verified"
        && String(saved.confirmedGiniVariantId || "")
        && giniSkuKey(saved.approvedSku) === giniSkuKey(combo.proposedSku);
    });
    if (verified) skus.push(parentSku);
  }
  return skus;
}

function structuralChanges(plan) {
  return (plan?.changes || []).filter((change) => STRUCTURAL_CHANGE_KINDS.has(change.kind)
    || change.action === "blocked_unsupported"
    || change.action === "manual_review"
    || change.action === "quantity_zero_not_stated");
}

function requestFromRow(plan, row) {
  const priceChanged = Number(row.oldPrice) !== Number(row.newPrice);
  const stockChanged = Number(row.oldStock) !== Number(row.newStock);
  return {
    method: row.patch.method,
    path: row.patch.path,
    rawBody: row.patch.rawBody,
    body: row.patch.body,
    parentSku: plan.parentSku,
    productId: plan.productId,
    variantId: String(row.variantId || ""),
    variantSku: row.sku || "",
    priceChanged,
    stockChanged,
    oldPrice: row.oldPrice,
    newPrice: row.newPrice,
    oldStock: row.oldStock,
    newStock: row.newStock,
    liveSend: false,
    sendsOtherVariants: false,
    replacesVariantSet: false,
    journalKey: `${giniSkuKey(plan.parentSku)}:${row.variantId}`,
    journalAction: "not_written",
  };
}

export function genericVariantRequests(plan, { sharedParent = false } = {}) {
  const structural = structuralChanges(plan);
  const skippedUnchanged = (plan?.priceRows || []).filter((row) => row.preserved === true).length;
  const clean = (plan?.priceRows || []).filter((row) => {
    if (!row?.changed || !row.patch || row.withheldReason) return false;
    const priceChanged = Number(row.oldPrice) !== Number(row.newPrice);
    const stockChanged = Number(row.oldStock) !== Number(row.newStock);
    if (!priceChanged && !stockChanged) return false;
    if (priceChanged && !row.commission) return false;
    if (stockChanged && !(Number.isInteger(Number(row.newStock)) && Number(row.newStock) > 0)) return false;
    return row.patch.liveSend === false && row.patch.replacesVariantSet === false && row.patch.sendsOtherVariants === false;
  });
  const eligible = sharedParent !== true
    && plan?.disposition === "CHANGED"
    && (plan?.blockers || []).length === 0
    && structural.length === 0
    && clean.length > 0
    && plan?.canSend === false
    && plan?.createAllowed === false;
  return {
    parentSku: plan?.parentSku || "",
    productId: plan?.productId || "",
    eligible,
    sharedParent: sharedParent === true,
    requests: eligible ? clean.map((row) => requestFromRow(plan, row)) : [],
    structural: structural.map((change) => ({ kind: change.kind, sku: change.sku || "", action: change.action || "" })),
    skippedUnchanged,
  };
}

const PILOT_JOURNAL_VARIANTS = Object.freeze([
  Object.freeze({ parentSku: "KE20", variantIds: Object.freeze(["164306", "164307"]) }),
  Object.freeze({ parentSku: "EI-8888", variantIds: Object.freeze(["164312", "164313"]) }),
]);

export function preservedPilotJournals(journals = []) {
  return PILOT_JOURNAL_VARIANTS.map((spec) => ({
    parentSku: spec.parentSku,
    variantIds: [...spec.variantIds],
    preserved: spec.variantIds.every((variantId) => (journals || []).some((row) => String(row?.variantId || "") === variantId
      && giniSkuKey(row?.parentSku) === giniSkuKey(spec.parentSku)
      && row?.status === "verified")),
    rewritten: false,
  }));
}

export function selectNextVariantTest(rows = []) {
  const singles = (rows || []).filter((row) => row.eligible && row.requests.length === 1).map((row) => row.requests[0]);
  const chosen = singles.find((row) => row.priceChanged && !row.stockChanged)
    || singles.find((row) => row.stockChanged && !row.priceChanged)
    || singles.find((row) => row.priceChanged && row.stockChanged)
    || null;
  return {
    ready: Boolean(chosen),
    liveSend: false,
    writesEnabled: false,
    kind: !chosen ? "" : chosen.priceChanged && chosen.stockChanged ? "price_and_positive_stock" : chosen.priceChanged ? "price" : "positive_stock",
    request: chosen,
    reason: chosen ? "one_verified_variant_difference" : "no_eligible_single_variant",
  };
}

export function countSkippedUnchangedVariants(plans = []) {
  const seen = new Set();
  const reconciledSeen = new Set();
  let duplicateCopyRowsExcluded = 0;
  for (const plan of plans || []) {
    const copy = (plan?.blockers || []).includes("duplicate_parent_sku") || (plan?.blockers || []).includes("other_vendor_owns_parent");
    const ownerOfKnownParent = isKnownVariantParent(plan?.parentSku) && !copy;
    for (const row of plan?.priceRows || []) {
      const key = `${giniSkuKey(plan?.parentSku)}:${row.variantId || row.sku || ""}`;
      if (ownerOfKnownParent && !reconciledSeen.has(key)) reconciledSeen.add(key);
      if (row.preserved !== true) continue;
      if (copy) {
        duplicateCopyRowsExcluded += 1;
        continue;
      }
      seen.add(key);
    }
  }
  return {
    skippedUnchangedVariants: seen.size,
    skippedUnchangedScope: "selected_owner_remote_variants",
    reconciledParentVariantsCompared: reconciledSeen.size,
    duplicateCopyRowsExcluded,
  };
}

export function buildGenericChangedPreview(plans = [], pricePatchJournals = [], { sharedParentKeys = new Set() } = {}) {
  const rows = (plans || []).map((plan) => genericVariantRequests(plan, { sharedParent: sharedParentKeys.has(giniSkuKey(plan.parentSku)) && !isKnownVariantParent(plan.parentSku) }));
  const preparedRequests = rows.flatMap((row) => row.requests);
  const skipped = countSkippedUnchangedVariants(plans);
  return {
    workflow: "gini_variant_changed_sync",
    sending: "off",
    writesEnabled: false,
    liveSend: false,
    bulkExecution: false,
    journalsWritten: false,
    createAllowed: false,
    deletionAllowed: false,
    preservedPilotJournals: preservedPilotJournals(pricePatchJournals),
    eligibleCount: rows.filter((row) => row.eligible).length,
    preparedRequestCount: preparedRequests.length,
    ...skipped,
    preparedRequests: preparedRequests.slice(0, 30),
    nextTest: selectNextVariantTest(rows),
  };
}

export function collectMissingColors(plans) {
  const missingSeen = new Map();
  for (const plan of plans || []) {
    for (const row of plan.colorPreview || []) {
      if (row.status !== "missing") continue;
      const key = String(row.color || "").toLowerCase();
      if (!key) continue;
      if (!missingSeen.has(key)) missingSeen.set(key, { color: row.color, spellings: new Set(), productCount: 0, attributeId: "" });
      const entry = missingSeen.get(key);
      entry.spellings.add(row.color);
      entry.productCount += 1;
    }
  }
  return [...missingSeen.values()].map((entry) => ({
    color: [...entry.spellings].sort((left, right) => left.localeCompare(right)).join(" / "),
    productCount: entry.productCount,
    attributeId: "",
  }));
}

export function summarizeVariantPlans(plans) {
  const summary = {
    total: plans.length,
    new: 0,
    changed: 0,
    unchanged: 0,
    blocked: 0,
    uncertain: 0,
    duplicateParent: 0,
    missingColorOrSize: 0,
    missingCategory: 0,
    missingOwnership: 0,
    missingSkuApproval: 0,
    sendable: 0,
  };
  const blockerCounts = {};
  for (const plan of plans || []) {
    if (plan.disposition === "NEW") summary.new += 1;
    else if (plan.disposition === "CHANGED") summary.changed += 1;
    else if (plan.disposition === "UNCHANGED") summary.unchanged += 1;
    else if (plan.disposition === "UNCERTAIN") summary.uncertain += 1;
    else summary.blocked += 1;
    const codes = new Set(plan.blockers || []);
    for (const code of codes) blockerCounts[code] = (blockerCounts[code] || 0) + 1;
    if (codes.has("duplicate_parent_sku") || codes.has("variant_sku_conflict")) summary.duplicateParent += 1;
    if (codes.has("missing_color_mapping") || codes.has("size_attribute_unverified") || codes.has("color_attribute_unread")) summary.missingColorOrSize += 1;
    if (codes.has("missing_mapping")) summary.missingCategory += 1;
    if (codes.has("duplicate_parent_sku") || codes.has("other_vendor_owns_parent")) summary.missingOwnership += 1;
    if (codes.has("missing_variant_sku_approval")) summary.missingSkuApproval += 1;
  }
  return { summary, blockerCounts };
}

export function futureBulkPreview(summary) {
  return {
    enabled: false,
    wouldSend: 0,
    newParentsAwaitingSeparateCreate: summary?.new || 0,
    changedParentsBlocked: summary?.changed || 0,
    unchangedParents: summary?.unchanged || 0,
    blockedParents: summary?.blocked || 0,
    uncertainParents: summary?.uncertain || 0,
    knownParentsSkippedAsCreate: KNOWN_GINI_VARIANT_PARENTS.length,
    note: "Bulk variant writes stay disabled. One saved-rule price or positive-stock difference can be prepared as its own PATCH, and that PATCH is not sent. Quantity 0, new colors, deleted colors, and unverified sizes stay blocked. A removed color stays for manual review. Duplicate vendor products are not combined, and an existing parent is not created again.",
  };
}

function priceOnlyPatch(row) {
  const body = row?.patch?.body;
  return Boolean(row?.patch?.rawBody)
    && body
    && Object.prototype.hasOwnProperty.call(body, "price")
    && !Object.prototype.hasOwnProperty.call(body, "quantity")
    && row.patch.liveSend === false
    && row.patch.replacesVariantSet === false
    && row.patch.sendsOtherVariants === false;
}

export function pricePilotBlockReason(pilot) {
  if (!pilot?.productId) return "product_not_in_catalog";
  if (pilot.disposition !== "CHANGED") return "not_changed";
  if ((pilot.blockers || []).length) return "blocked";
  const changes = pilot.changes || [];
  if (!changes.length || changes.some((change) => change.kind !== "price" || change.action !== "documented_not_sent")) return "not_price_only";
  const rows = pilot.priceRows || [];
  const changed = rows.filter((row) => row.changed);
  if (!changed.length || changed.some((row) => row.oldStock !== row.newStock || row.withheldReason || !priceOnlyPatch(row))) return "price_patch_not_ready";
  if (changed.some((row) => !row.commission)) return "missing_commission_rule";
  if (rows.some((row) => row.patch && !row.changed)) return "unchanged_variant_in_patch";
  return "";
}

function pilotApproved(pilot, operations) {
  const changed = (pilot?.priceRows || []).filter((row) => row.changed);
  if (!changed.length) return false;
  return changed.every((row) => (operations || []).some((op) => String(op.variantId) === String(row.variantId)
    && giniSkuKey(op.parentSku) === giniSkuKey(pilot.parentSku)
    && op.status === "approved"
    && Number(op.baselinePrice) === Number(row.oldPrice)
    && Number(op.baselineQuantity) === Number(row.oldStock)
    && String(op.rawBody || "") === String(row.patch?.rawBody || "")));
}

export function selectPricePilot(pilots, operations = []) {
  const withheld = [];
  let selected = null;
  for (const pilot of pilots || []) {
    const reason = pricePilotBlockReason(pilot);
    if (!reason) {
      if (!selected) selected = pilot;
      else withheld.push({ parentSku: pilot.parentSku, reason: "waiting_behind_one_product_pilot" });
      continue;
    }
    withheld.push({ parentSku: pilot.parentSku, reason });
  }
  const changed = (selected?.priceRows || []).filter((row) => row.changed);
  return {
    ready: Boolean(selected),
    canSend: false,
    batchEnabled: false,
    liveSend: false,
    writesEnabled: false,
    mode: "one_product_price_only",
    parentSku: selected?.parentSku || "",
    label: selected?.label || "",
    productId: selected?.productId || "",
    approvalRequired: true,
    approved: selected ? pilotApproved(selected, operations) : false,
    variants: changed,
    preserved: (selected?.priceRows || []).filter((row) => !row.changed),
    withheld,
  };
}

export function routeGiniOverview({ variantSummary, simpleJob }) {
  return {
    simple: simpleJob
      ? {
          workflow: "existing_simple_sync",
          available: true,
          status: simpleJob.status || "",
          readyCreate: Number(simpleJob.readyCreate) || 0,
          alreadyExists: Number(simpleJob.alreadyExists) || 0,
          changed: Number(simpleJob.changed) || 0,
          unchanged: Number(simpleJob.unchanged) || 0,
          blocked: Number(simpleJob.blocked) || 0,
          inactive: Number(simpleJob.inactive) || 0,
        }
      : { workflow: "existing_simple_sync", available: false },
    variant: { workflow: "variant_dry_run", ...(variantSummary || {}) },
    routing: "Simple products stay on the existing sync. Multi-variant products stay on this dry run.",
    bulkVariantWritesEnabled: false,
  };
}

export function publishRemote(remote) {
  if (!remote) return { state: "not_read", variants: null, variantCount: null };
  const variants = Array.isArray(remote.variants) ? remote.variants.map(presentRemoteVariant) : null;
  return {
    state: remote.state || "not_read",
    status: remote.status || 0,
    id: remote.id || "",
    sku: remote.sku || "",
    visibility: remote.visibility || "",
    quantity: remote.quantity ?? null,
    categoryId: remote.categoryId || "",
    subcategoryId: remote.subcategoryId || "",
    variantCount: variants ? variants.filter((row) => row?.sku).length : null,
    variants: variants
      ? variants.filter((row) => row?.sku).map((row) => ({
          id: row.id || "",
          sku: row.sku,
          color: row.color || "",
          price: row.price,
          quantity: row.quantity,
          attributeId: row.attributeId || "",
          images: row.images || { state: "not_remotely_verifiable", urls: [] },
        }))
      : null,
  };
}
