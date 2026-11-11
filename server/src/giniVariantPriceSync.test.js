import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { applyCommissionRate, resolveCommissionRate } from "./utils/commission.js";
import { planVariantChange } from "./utils/giniVariantChangedPlan.js";
import { quoteVariantGiniPrice } from "./utils/giniVariantPricing.js";
import { previewVariantChangedSync } from "./services/giniVariantChangedSync.js";
import { approveVariantPricePilot, sendVariantPricePilot, variantPricePatchClient, variantPriceWritesEnabled } from "./services/giniVariantPricePilot.js";
import { performGiniJsonRequest } from "./services/giniConnection.js";

const LABELS = ["Blue", "Black", "Purple"];
const VENDOR_A = "6a9ea85375e4e5319a4b9931";
const VENDOR_B = "6a9ea85375e4e5319a4b9932";
const CATEGORY = "6a5f3484a0cba783e62cd24c";

function filterRule(vendorId, percentage) {
  return {
    scope: "filter",
    percentage,
    isActive: true,
    targetId: `${vendorId}|brand|${CATEGORY}|_ALL_|_ALL_`,
    targetName: { en: "Saved vendor filter" },
    vendorId,
    brandId: "",
    categoryId: CATEGORY,
    subCategoryId: "",
    collectionId: "",
  };
}

function productScope(vendorId) {
  return {
    createdBy: { _id: vendorId },
    brand: { _id: "brand-1" },
    category: { _id: CATEGORY },
    subCategory: { _id: "sub-1" },
    collectionName: { _id: "col-1" },
  };
}

function combo(sku, color, stock, price, sourceVariantId, sourceSizeId, ownPrice = price) {
  return { sourceVariantId, sourceSizeId, color, stock, price, ownPrice, proposedSku: sku, images: 1 };
}

function approved(sku, sourceVariantId, sourceSizeId, confirmedGiniVariantId) {
  return { sourceVariantId, sourceSizeId, approvedSku: sku, status: "verified", confirmedGiniVariantId };
}

function remoteRow(sku, color, quantity, price, id) {
  return { id, sku, quantity, price, attributes: [{ id: 3696, value: color }] };
}

function matchedRemote(sku, rows, quantity) {
  return {
    state: "present",
    id: "613402",
    sku,
    visibility: "hidden",
    quantity,
    categoryId: "2",
    subcategoryId: "18",
    categoryKnown: true,
    subcategoryKnown: true,
    variants: rows,
  };
}

function base(overrides = {}) {
  const combinations = overrides.combinations || [
    combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"),
    combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
  ];
  return {
    productId: "product-1",
    parentSku: "KE20",
    vendorId: "vendor-1",
    categoryId: "2",
    subcategoryId: "18",
    combinations,
    identities: overrides.identities || [
      approved("KE20-BLUE", "a", "b", "11"),
      approved("KE20-BLACK", "c", "d", "12"),
    ],
    remote: overrides.remote || matchedRemote("KE20", [
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
    ], 14),
    colorLabels: LABELS,
    colorAttributeId: "3696",
    ...overrides,
    combinations,
  };
}

test("variant prices use saved rule precedence and the existing rounding builder", () => {
  const rules = [filterRule(VENDOR_A, 5.5), filterRule(VENDOR_B, 5.5), { scope: "all", percentage: 10, isActive: true, targetId: "all", targetName: { en: "All products" } }];
  const ke20 = quoteVariantGiniPrice({ product: productScope(VENDOR_A), rules, ownPrice: 26500, parentStorePrice: 26500 });
  const iron = quoteVariantGiniPrice({ product: productScope(VENDOR_B), rules, ownPrice: 119750, parentStorePrice: 119750 });
  assert.equal(ke20.rate, resolveCommissionRate(productScope(VENDOR_A), rules));
  assert.equal(ke20.giniPrice, applyCommissionRate(26500, ke20.rate));
  assert.equal(ke20.giniPrice, 28000);
  assert.equal(iron.giniPrice, applyCommissionRate(119750, iron.rate));
  assert.equal(iron.giniPrice, 126500);
  assert.equal(ke20.commission.scope, "filter");
  assert.notEqual(ke20.giniPrice, applyCommissionRate(26500, 10));
  const own = quoteVariantGiniPrice({ product: productScope(VENDOR_A), rules, ownPrice: 30000, parentStorePrice: 26500 });
  assert.equal(own.usedOwnPrice, true);
  assert.equal(own.basePrice, 30000);
  assert.equal(own.giniPrice, applyCommissionRate(30000, own.rate));
  assert.notEqual(own.giniPrice, ke20.giniPrice);
  const fallback = quoteVariantGiniPrice({ product: productScope(VENDOR_A), rules, ownPrice: 26500.5, parentStorePrice: 26500 });
  assert.equal(fallback.usedOwnPrice, false);
  assert.equal(fallback.basePrice, 26500);
  const source = fs.readFileSync(new URL("./utils/giniVariantPricing.js", import.meta.url), "utf8");
  assert.equal(source.includes("5.5"), false);
  assert.equal(source.includes("28000"), false);
  assert.equal(source.includes("126500"), false);
  assert.equal(source.includes("winningCommission"), true);
  assert.equal(source.includes("applyCommissionRate"), true);
});

test("a price-only variant patch leaves the other color out of the body", () => {
  const rules = [filterRule(VENDOR_A, 5.5)];
  const quote = quoteVariantGiniPrice({ product: productScope(VENDOR_A), rules, ownPrice: 26500, parentStorePrice: 26500 });
  const plan = planVariantChange(base({
    combinations: [
      { ...combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"), pricing: quote },
      { ...combo("KE20-BLACK", "Black", 4, 26500, "c", "d"), pricing: quote },
    ],
  }));
  assert.equal(plan.disposition, "CHANGED");
  assert.equal(plan.canSend, false);
  assert.deepEqual(plan.writes, []);
  assert.equal(plan.proposedPatches.length, 2);
  assert.equal(plan.proposedPatches.every((patch) => patch.liveSend === false && patch.sendsOtherVariants === false && patch.replacesVariantSet === false), true);
  assert.equal(plan.proposedPatches[0].rawBody, "{\"variant_id\":11,\"price\":28000}");
  assert.equal(plan.proposedPatches[1].rawBody, "{\"variant_id\":12,\"price\":28000}");
  assert.equal(plan.priceRows.every((row) => row.oldPrice === 26500 && row.newPrice === 28000 && row.oldStock === row.newStock), true);
  assert.equal(plan.priceRows[0].commission.percentage, quote.rate);
});

test("stock, combined, zero, missing identity, and uncertain rows do not send", () => {
  const stock = planVariantChange(base({
    remote: matchedRemote("KE20", [
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 1, 26500, "12"),
    ], 11),
  }));
  const stockPatch = stock.priceRows.find((row) => row.sku === "KE20-BLACK").patch;
  assert.equal(stockPatch.rawBody, "{\"variant_id\":12,\"quantity\":4}");
  assert.equal(stock.priceRows.find((row) => row.sku === "KE20-BLUE").preserved, true);
  assert.equal(stock.canSend, false);

  const combined = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 9, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
    remote: matchedRemote("KE20", [
      remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
      remoteRow("KE20-BLACK", "Black", 4, 26500, "12"),
    ], 14),
  }));
  assert.equal(combined.priceRows.find((row) => row.sku === "KE20-BLUE").patch.rawBody, "{\"variant_id\":11,\"price\":27000,\"quantity\":9}");
  assert.equal(combined.priceRows.find((row) => row.sku === "KE20-BLACK").preserved, true);
  assert.equal(combined.proposedPatches.length, 1);

  const zero = planVariantChange(base({
    combinations: [
      combo("KE20-BLUE", "Blue", 0, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  }));
  assert.equal(zero.priceRows.find((row) => row.sku === "KE20-BLUE").patch, null);
  assert.equal(zero.priceRows.find((row) => row.sku === "KE20-BLUE").withheldReason, "quantity_zero_not_stated");

  const missing = planVariantChange(base({
    identities: [approved("KE20-BLUE", "a", "b", ""), approved("KE20-BLACK", "c", "d", "12")],
    combinations: [
      combo("KE20-BLUE", "Blue", 10, 27000, "a", "b"),
      combo("KE20-BLACK", "Black", 4, 26500, "c", "d"),
    ],
  }));
  assert.equal(missing.priceRows.find((row) => row.sku === "KE20-BLUE").patch, null);
  assert.equal(missing.priceRows.find((row) => row.sku === "KE20-BLUE").withheldReason, "missing_remote_variant_id");

  const duplicate = planVariantChange(base({ catalogBlockers: ["other_vendor_owns_parent"] }));
  assert.equal(duplicate.disposition, "BLOCKED");
  assert.equal(duplicate.blockers.includes("other_vendor_owns_parent"), true);
  assert.equal(duplicate.canSend, false);

  const uncertain = planVariantChange(base({ variantOperations: [{ variantId: "12", status: "uncertain", baselinePrice: 26500, baselineQuantity: 4, rawBody: "" }] }));
  assert.equal(uncertain.disposition, "UNCERTAIN");
  assert.equal(uncertain.blockers.includes("variant_patch_uncertain"), true);
  assert.equal(uncertain.canSend, false);
});

function catalogProduct({ productId, parentSku, vendorId, combinations, blockers = [] }) {
  return {
    productId,
    parentSku,
    vendorId,
    categoryId: "2",
    subcategoryId: "18",
    multipleSizes: false,
    blockers,
    priceScope: {
      storePrice: combinations[0].ownPrice,
      priceReview: false,
      vendorId,
      brandId: "brand-1",
      categoryId: CATEGORY,
      subCategoryId: "sub-1",
      collectionId: "col-1",
    },
    combinations,
  };
}

test("the dry run prepares one price pilot and does not call the signed PATCH client", async () => {
  const rules = [filterRule(VENDOR_A, 5.5), filterRule(VENDOR_B, 5.5), { scope: "all", percentage: 10, isActive: true, targetId: "all" }];
  const calls = [];
  const result = await previewVariantChangedSync({
    skipDatabase: true,
    skipRemote: true,
    commissionRules: rules,
    identities: [
      { productId: "ke20", ...approved("KE20-BLUE", "a", "b", "11") },
      { productId: "ke20", ...approved("KE20-BLACK", "c", "d", "12") },
      { productId: "iron", ...approved("EI-8888-BLUE", "e", "f", "21") },
      { productId: "iron", ...approved("EI-8888-PURPLE", "g", "h", "22") },
    ],
    operations: [],
    owners: [
      { parentSku: "KE20", productId: "ke20", status: "verified_remote", giniProductId: "1" },
      { parentSku: "EI-8888", productId: "iron", status: "verified_remote", giniProductId: "2" },
    ],
    changedOperations: [],
    simpleJob: null,
    attributeResponse: { status: 200, json: { data: { id: 3696, name: "Color", values: LABELS } } },
    remoteBySku: {
      KE20: matchedRemote("KE20", [
        remoteRow("KE20-BLUE", "Blue", 10, 26500, "11"),
        remoteRow("KE20-BLACK", "Black", 10, 26500, "12"),
      ], 20),
      "EI-8888": matchedRemote("EI-8888", [
        remoteRow("EI-8888-BLUE", "Blue", 3, 119750, "21"),
        remoteRow("EI-8888-PURPLE", "Purple", 4, 119750, "22"),
      ], 7),
    },
    loadCatalog: async () => ({
      products: [
        catalogProduct({
          productId: "ke20",
          parentSku: "KE20",
          vendorId: VENDOR_A,
          combinations: [
            combo("KE20-BLUE", "Blue", 10, 26500, "a", "b"),
            combo("KE20-BLACK", "Black", 10, 26500, "c", "d"),
          ],
        }),
        catalogProduct({
          productId: "ke20-copy",
          parentSku: "KE20",
          vendorId: "other-vendor",
          blockers: ["other_vendor_owns_parent"],
          combinations: [
            combo("KE20-BLUE", "Blue", 10, 26500, "x", "y"),
            combo("KE20-BLACK", "Black", 10, 26500, "m", "n"),
          ],
        }),
        catalogProduct({
          productId: "iron",
          parentSku: "EI-8888",
          vendorId: VENDOR_B,
          combinations: [
            combo("EI-8888-BLUE", "Blue", 3, 119750, "e", "f"),
            combo("EI-8888-PURPLE", "Purple", 4, 119750, "g", "h"),
          ],
        }),
      ],
    }),
    perform: async (request) => {
      calls.push(request.method);
      throw new Error("remote_not_used");
    },
  });
  assert.deepEqual(calls, []);
  assert.equal(result.canSend, false);
  assert.equal(result.writesEnabled, false);
  assert.equal(result.bulkSyncEnabled, false);
  assert.equal(result.futureBulk.enabled, false);
  assert.equal(result.futureBulk.wouldSend, 0);
  assert.equal(result.pricePilot.ready, true);
  assert.equal(result.pricePilot.parentSku, "KE20");
  assert.equal(result.pricePilot.canSend, false);
  assert.equal(result.pricePilot.batchEnabled, false);
  assert.equal(result.pricePilot.approved, false);
  assert.equal(result.pricePilot.variants.every((row) => row.oldPrice === 26500 && row.newPrice === 28000 && row.oldStock === row.newStock), true);
  assert.equal(result.pricePilot.variants.every((row) => row.patch.rawBody.includes("\"price\":28000") && !row.patch.rawBody.includes("quantity")), true);
  const iron = result.pilots.find((pilot) => pilot.parentSku === "EI-8888");
  assert.equal(iron.priceRows.every((row) => row.oldPrice === 119750 && row.newPrice === 126500), true);
  assert.equal(result.pricePilot.withheld.some((row) => row.parentSku === "EI-8888" && row.reason === "waiting_behind_one_product_pilot"), true);
  assert.equal(result.pilots.find((pilot) => pilot.parentSku === "KE20").candidates.some((row) => row.productId === "ke20-copy" && row.blockers.includes("other_vendor_owns_parent")), true);
  const saved = [];
  const approval = await approveVariantPricePilot({
    parentSku: "KE20",
    confirm: true,
    preview: result,
    store: {
      async read() { return saved; },
      async save(doc) { saved.push(doc); return doc; },
    },
  });
  assert.equal(approval.code, "approved_not_sent");
  assert.equal(approval.sentToGini, 0);
  assert.equal(saved.length, 2);
  const conflicted = await approveVariantPricePilot({
    parentSku: "KE20",
    confirm: true,
    preview: {
      ...result,
      pilots: result.pilots.map((pilot) => pilot.parentSku === "KE20"
        ? { ...pilot, priceRows: pilot.priceRows.map((row) => ({ ...row, oldPrice: row.oldPrice + 1 })) }
        : pilot),
    },
    store: {
      async read() { return saved; },
      async save(doc) { saved.push(doc); return doc; },
    },
  });
  assert.equal(conflicted.code, "baseline_conflict");
  assert.equal(conflicted.sentToGini, 0);
  assert.equal(saved.at(-1).status, "conflict");
  const uncertainApproval = await approveVariantPricePilot({
    parentSku: "KE20",
    confirm: true,
    preview: result,
    store: {
      async read() { return [{ productId: "ke20", parentSku: "KE20", variantId: "11", status: "uncertain", operationKey: "ke20:11" }]; },
      async save() { throw new Error("uncertain_was_saved"); },
    },
  });
  assert.equal(uncertainApproval.code, "uncertain_no_retry");
  assert.equal(uncertainApproval.sentToGini, 0);
  let sent = 0;
  const refused = await sendVariantPricePilot({ confirm: true, performJson: async () => { sent += 1; return { status: 200 }; } });
  assert.equal(refused.code, "variant_price_patch_disabled");
  assert.equal(refused.sentToGini, 0);
  assert.equal(sent, 0);
  assert.equal(variantPriceWritesEnabled(), false);
  assert.equal(variantPricePatchClient, performGiniJsonRequest);
  const routes = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
  const pilotSource = fs.readFileSync(new URL("./services/giniVariantPricePilot.js", import.meta.url), "utf8");
  assert.equal(routes.includes("variant-sync/price-pilot/send"), false);
  assert.equal(routes.includes("variant-sync/bulk"), false);
  assert.equal(pilotSource.includes("miswag"), false);
  assert.equal(pilotSource.includes("elryan"), false);
  assert.equal(pilotSource.includes("ibsher"), false);
});
