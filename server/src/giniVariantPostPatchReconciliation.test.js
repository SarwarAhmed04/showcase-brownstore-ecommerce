import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { planVariantChange } from "./utils/giniVariantChangedPlan.js";

import {
  KE20_BLACK_PRICE_PATCH_RAW_BODY,
  KE20_BLUE_PRICE_PATCH_RAW_BODY,
  planKe20PostPatchReconciliation,
} from "./utils/giniVariantPricePatchPlan.js";
const PRODUCT_ID = "6aae476f023c0be610d48093";
const LABELS = ["Blue", "Black", "Purple"];

function pricing(giniPrice, basePrice) {
  return { giniPrice, basePrice, rate: 5.5, usedOwnPrice: true, priceReview: false, commission: { percentage: 5.5, scope: "filter" } };
}

function combo(sku, sourceVariantId, sourceSizeId) {
  return { sourceVariantId, sourceSizeId, color: sku.endsWith("BLUE") ? "Blue" : "Black", stock: 10, price: 26500, ownPrice: 26500, proposedSku: sku, images: 1, pricing: pricing(28000, 26500) };
}

function identity(sku, variantId, sourceVariantId, sourceSizeId, productId = PRODUCT_ID) {
  return {
    productId,
    parentSku: "KE20",
    parentSkuKey: "ke20",
    sourceVariantId,
    sourceSizeId,
    approvedSku: sku,
    approvedSkuKey: sku.toLowerCase(),
    confirmedGiniVariantId: variantId,
    status: "verified",
    lastVerifiedPrice: 26500,
    lastVerifiedQuantity: 10,
  };
}

function approval(variantId, rawBody, productId = PRODUCT_ID) {
  return {
    parentSku: "KE20",
    productId,
    variantId,
    status: "approved",
    baselinePrice: 26500,
    baselineQuantity: 10,
    proposedPrice: 28000,
    rawBody,
  };
}

function journal(stage, variantId, rawBody, status = "verified") {
  return { parentSku: "KE20", variantId, variantSku: stage === "blue" ? "KE20-BLUE" : "KE20-BLACK", stage, status, rawBody };
}

function parent(price = 28000) {
  return { state: "present", id: "618623", sku: "KE20", visibility: "hidden", quantity: 20, price };
}

function variants(bluePrice = 28000, blackPrice = 28000, blueQty = 10, blackQty = 10) {
  return [
    { normalized: true, id: "164306", sku: "KE20-BLUE", price: bluePrice, quantity: blueQty },
    { normalized: true, id: "164307", sku: "KE20-BLACK", price: blackPrice, quantity: blackQty },
  ];
}

function remoteRows(bluePrice = 28000, blackPrice = 28000) {
  return [
    { id: "164306", sku: "KE20-BLUE", quantity: 10, price: bluePrice, attributes: [{ id: 3696, value: "Blue" }] },
    { id: "164307", sku: "KE20-BLACK", quantity: 10, price: blackPrice, attributes: [{ id: 3696, value: "Black" }] },
  ];
}

function settledInput(overrides = {}) {
  return {
    productId: PRODUCT_ID,
    parentSku: "KE20",
    vendorId: "vendor-1",
    categoryId: "2",
    subcategoryId: "18",
    combinations: [
      combo("KE20-BLUE", "blue-source", "blue-size"),
      combo("KE20-BLACK", "black-source", "black-size"),
    ],
    identities: [
      identity("KE20-BLUE", "164306", "blue-source", "blue-size"),
      identity("KE20-BLACK", "164307", "black-source", "black-size"),
    ],
    remote: {
      ...parent(),
      categoryKnown: false,
      subcategoryKnown: false,
      variants: remoteRows(),
    },
    colorLabels: LABELS,
    colorAttributeId: "3696",
    ownership: "required",
    owner: { status: "verified_remote", productId: PRODUCT_ID, giniProductId: "618623", parentSku: "KE20", skuKey: "ke20" },
    variantOperations: [
      approval("164306", KE20_BLUE_PRICE_PATCH_RAW_BODY),
      approval("164307", KE20_BLACK_PRICE_PATCH_RAW_BODY),
    ],
    pricePatchJournals: [
      journal("blue", "164306", KE20_BLUE_PRICE_PATCH_RAW_BODY),
      journal("black", "164307", KE20_BLACK_PRICE_PATCH_RAW_BODY),
    ],
    ...overrides,
  };
}

function reconciliationInput(overrides = {}) {
  const input = settledInput(overrides);
  return {
    parent: parent(overrides.parentPrice),
    variants: overrides.presentedVariants || variants(),
    owner: input.owner,
    identities: input.identities,
    approvals: input.variantOperations,
    journals: input.pricePatchJournals,
  };
}

test("a verified KE20 price update is unchanged while the 26500 approval baseline stays stored", () => {
  const plan = planVariantChange(settledInput());
  assert.equal(plan.disposition, "UNCHANGED");
  assert.equal(plan.blockers.includes("variant_baseline_conflict"), false);
  assert.equal(plan.canSend, false);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.priceRows.every((row) => row.oldPrice === 28000 && row.newPrice === 28000 && row.preserved === true && row.patch == null), true);
  assert.equal(plan.variantOperations, undefined);
  const proposal = planKe20PostPatchReconciliation(reconciliationInput());
  assert.equal(proposal.ok, true);
  assert.equal(proposal.canApply, false);
  assert.equal(proposal.applied, false);
  assert.equal(proposal.writesEnabled, false);
  assert.equal(proposal.history.every((row) => row.baselinePrice === 26500 && row.status === "approved" && row.proposedPrice === 28000), true);
  assert.equal(proposal.updates.length, 2);
  assert.equal(proposal.updates.every((row) => row.set.lastVerifiedPrice === 28000 && row.preserve.includes("confirmedGiniVariantId")), true);
  assert.equal(JSON.stringify(proposal).includes("updateOne"), false);
});

test("the old baseline still blocks KE20 when the verified journals do not prove the remote price", () => {
  const missingJournal = planVariantChange(settledInput({ pricePatchJournals: [] }));
  assert.equal(missingJournal.disposition, "BLOCKED");
  assert.equal(missingJournal.blockers.includes("variant_baseline_conflict"), true);

  const drifted = planVariantChange(settledInput({
    remote: { ...parent(), categoryKnown: false, subcategoryKnown: false, variants: remoteRows(30000, 28000) },
  }));
  assert.equal(drifted.disposition, "BLOCKED");
  assert.equal(drifted.blockers.includes("variant_baseline_conflict"), true);
  assert.equal(planKe20PostPatchReconciliation(reconciliationInput({ presentedVariants: variants(30000, 28000) })).ok, false);

  const uncertain = planVariantChange(settledInput({
    pricePatchJournals: [
      journal("blue", "164306", KE20_BLUE_PRICE_PATCH_RAW_BODY, "uncertain"),
      journal("black", "164307", KE20_BLACK_PRICE_PATCH_RAW_BODY),
    ],
  }));
  assert.equal(uncertain.disposition, "BLOCKED");
  assert.equal(uncertain.blockers.includes("variant_baseline_conflict"), true);
});

test("another product keeps its baseline conflict even when a verified journal is present", () => {
  const plan = planVariantChange({
    productId: "iron",
    parentSku: "EI-8888",
    vendorId: "vendor-1",
    categoryId: "2",
    subcategoryId: "18",
    combinations: [
      { sourceVariantId: "e", sourceSizeId: "f", color: "Blue", stock: 3, price: 126500, ownPrice: 119750, proposedSku: "EI-8888-BLUE", images: 1, pricing: pricing(126500, 119750) },
      { sourceVariantId: "g", sourceSizeId: "h", color: "Purple", stock: 4, price: 126500, ownPrice: 119750, proposedSku: "EI-8888-PURPLE", images: 1, pricing: pricing(126500, 119750) },
    ],
    identities: [
      { sourceVariantId: "e", sourceSizeId: "f", approvedSku: "EI-8888-BLUE", status: "verified", confirmedGiniVariantId: "21" },
      { sourceVariantId: "g", sourceSizeId: "h", approvedSku: "EI-8888-PURPLE", status: "verified", confirmedGiniVariantId: "22" },
    ],
    remote: {
      state: "present",
      id: "2",
      sku: "EI-8888",
      visibility: "hidden",
      quantity: 7,
      categoryKnown: false,
      subcategoryKnown: false,
      variants: [
        { id: "21", sku: "EI-8888-BLUE", quantity: 3, price: 126500, attributes: [{ id: 3696, value: "Blue" }] },
        { id: "22", sku: "EI-8888-PURPLE", quantity: 4, price: 126500, attributes: [{ id: 3696, value: "Purple" }] },
      ],
    },
    colorLabels: LABELS,
    colorAttributeId: "3696",
    variantOperations: [
      { parentSku: "EI-8888", variantId: "21", status: "approved", baselinePrice: 119750, baselineQuantity: 3, proposedPrice: 126500, rawBody: "{\"variant_id\":21,\"price\":126500}" },
    ],
    pricePatchJournals: [
      journal("blue", "164306", KE20_BLUE_PRICE_PATCH_RAW_BODY),
      { parentSku: "EI-8888", variantId: "21", stage: "blue", status: "verified", rawBody: "{\"variant_id\":21,\"price\":126500}" },
    ],
  });
  assert.equal(plan.disposition, "BLOCKED");
  assert.equal(plan.blockers.includes("variant_baseline_conflict"), true);
  assert.equal(plan.canSend, false);
  const source = fs.readFileSync(new URL("./utils/giniVariantPricePatchPlan.js", import.meta.url), "utf8");
  const sync = fs.readFileSync(new URL("./services/giniVariantChangedSync.js", import.meta.url), "utf8");
  assert.equal(source.includes("updateOne"), false);
  assert.equal(source.includes("EI-8888"), false);
  assert.equal(sync.includes("GiniVariantPricePatch.find({ parentSku: \"KE20\" })"), true);
  assert.equal(sync.includes(".patch("), false);
});
