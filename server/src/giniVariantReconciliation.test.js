import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  RECONCILIATION_AUTHORIZATION,
  REQUIRED_RECONCILIATION_INDEXES,
  VERIFIED_VARIANT_PARENTS,
  applyVariantReconciliation,
  explainMultiVariantCount,
  planVariantReconciliation,
} from "./utils/giniVariantReconciliation.js";

const COLOR = { state: "read", id: "3696", name: "Color", labels: ["Blue", "Black", "Purple"] };

const PRODUCTION = [
  ["KE20", "6aae476f023c0be610d48093", "Kozano", "6a9ea85375e4e5319a4b9931", 26500, [
    ["Blue", "6aa11a6175e4e5319a4f2454", "6abb9a42b4a52fad34d8f0b9", 10],
    ["Black", "6aa11a6175e4e5319a4f2457", "6abb9a42b4a52fad34d8f0bc", 10],
  ]],
  ["EFR-575D-1ADF", "6ad23acf9361aa64a9bffa2c", "Versace", "6a92c5f0c9c53aab412d8177", 264000, [
    ["Black", "6a990dd4e14acec2074142ce", "6ad0db40669f3bf0af466450", 20],
    ["Blue", "6a990dd4e14acec2074142d2", "6ad0db40669f3bf0af466453", 10],
  ]],
  ["EI-8888", "6aae4770023c0be610d48876", "Sokany", "6a9517bec9c53aab412f7610", 119750, [
    ["blue", "6a9824fb4781f97bddcfa775", "6aba29cc75e4e5319a743fa7", 10],
    ["purple", "6a9824fb4781f97bddcfa778", "6aba29cc75e4e5319a743faa", 10],
  ]],
  ["71868", "6adf9ca49dedbaa3dd573c99", "IT Lobby", "6abcfd26d134be2c4f632a02", 1260000, [
    ["Blue", "6adf9873ef43bcf3ec7d25e9", "6adf9873ef43bcf3ec7d25ec", 3],
    ["Black", "6adf9873ef43bcf3ec7d25ed", "6adf9873ef43bcf3ec7d25ef", 3],
  ]],
  ["69392", "6adf9ca49dedbaa3dd573c9c", "IT Lobby", "6abcfd26d134be2c4f632a02", 330000, [
    ["Blue", "6adf9870ef43bcf3ec7d25bc", "6adf9870ef43bcf3ec7d25bf", 10],
    ["Purple", "6adf9870ef43bcf3ec7d25c0", "6adf9870ef43bcf3ec7d25c2", 10],
    ["Black", "6adf9870ef43bcf3ec7d25c3", "6adf9870ef43bcf3ec7d25c5", 10],
  ]],
  ["75244", "6ae08bbb9dedbaa3dd574097", "Jawal Flex", "6ad326b8669f3bf0af58f970", 1327000, [
    ["Blue", "6adf9d38ef43bcf3ec7db6f8", "6adf9d38ef43bcf3ec7db6fb", 10],
    ["Black", "6adf9d38ef43bcf3ec7db6fc", "6adf9d38ef43bcf3ec7db6fe", 10],
    ["Purple", "6adf9d38ef43bcf3ec7db6ff", "6adf9d38ef43bcf3ec7db701", 10],
  ]],
];

const NON_OWNERS = [
  ["71868", "6ae08bbb9dedbaa3dd5740a2", "Jawal Flex", "jawal"],
  ["69392", "6ae08bbb9dedbaa3dd5740a8", "Jawal Flex", "jawal"],
  ["75244", "6adf9ca49dedbaa3dd573c8e", "IT Lobby", "it-lobby"],
];

function product(sku, id, vendor, vendorId, price, rows) {
  return {
    _id: id,
    itemCode: sku,
    name: { en: sku },
    price,
    createdBy: { _id: vendorId, name: { en: vendor } },
    brand: { _id: `${vendorId}-brand`, name: { en: vendor } },
    category: { _id: "6a5f3484a0cba783e62cd24c", name: { en: "Home & Kitchen Appliances" } },
    variants: rows.map(([color, variantId, sizeId, stock]) => ({
      _id: variantId,
      color: { en: color },
      sizes: [{ _id: sizeId, size: { en: "One" }, stockQuantity: stock }],
    })),
  };
}

function owners() {
  return PRODUCTION.map((row) => product(...row));
}

function copies() {
  return NON_OWNERS.map(([sku, id, vendor, vendorId]) => product(sku, id, vendor, vendorId, 1, [["Blue", `${id}-v`, `${id}-s`, 1]]));
}

function remoteBySku() {
  const map = {};
  for (const parent of VERIFIED_VARIANT_PARENTS) {
    map[parent.parentSku] = {
      state: "present",
      id: parent.giniProductId,
      sku: parent.parentSku,
      visibility: "hidden",
      quantity: parent.variants.reduce((sum, row) => sum + (row.sku.endsWith("BLACK") && parent.parentSku === "EFR-575D-1ADF" ? 20 : 10), 0),
      variants: parent.variants.map((row) => ({
        id: row.giniVariantId,
        sku: row.sku,
        color: row.color,
        price: parent.parentSku === "KE20" ? 26500 : parent.parentSku === "EI-8888" ? 119750 : 1000,
        quantity: 10,
        attributeId: "3696",
      })),
    };
  }
  return map;
}

function indexes() {
  const grouped = {};
  for (const expected of REQUIRED_RECONCILIATION_INDEXES) {
    if (!grouped[expected.collection]) grouped[expected.collection] = [];
    const index = { key: expected.key, unique: true };
    if (expected.partialField) index.partialFilterExpression = { [expected.partialField]: { $gt: "" } };
    grouped[expected.collection].push(index);
  }
  return grouped;
}

function readyPlan(extra = {}) {
  return planVariantReconciliation({
    products: [...owners(), ...copies()],
    identities: [],
    owners: [],
    contracts: [],
    indexesByCollection: indexes(),
    remoteBySku: remoteBySku(),
    colorAttribute: COLOR,
    commissionRules: [],
    ...extra,
  });
}

test("proposes one contract, six owners, and fourteen identities for the production matches", () => {
  const plan = readyPlan();
  assert.equal(plan.canApply, true);
  assert.deepEqual(plan.giniWrites, []);
  assert.equal(plan.writesEnabled, false);
  assert.equal(plan.records.filter((record) => record.action === "insert").length, 21);
  assert.equal(plan.records.filter((record) => record.collection === "ginivariantattributecontracts").length, 1);
  assert.equal(plan.records.filter((record) => record.collection === "ginivariantparentowners").length, 6);
  assert.equal(plan.records.filter((record) => record.collection === "ginivariantidentities").length, 14);
  assert.deepEqual(plan.excluded.map((row) => row.productId).sort(), NON_OWNERS.map((row) => row[1]).sort());
  const ke20 = plan.matches.find((row) => row.parentSku === "KE20");
  assert.equal(ke20.productId, "6aae476f023c0be610d48093");
  assert.equal(ke20.vendorId, "6a9ea85375e4e5319a4b9931");
  assert.equal(ke20.variants[0].sourceVariantId, "6aa11a6175e4e5319a4f2454");
  assert.equal(ke20.variants[0].giniVariantId, "164306");
  const identity = plan.records.find((record) => record.after.approvedSku === "KE20-BLUE");
  assert.equal(identity.after.lastVerifiedPrice, 26500);
  assert.equal(identity.after.confirmedGiniVariantId, "164306");
  assert.equal(plan.records.some((record) => String(record.after.productId || "") === "6ae08bbb9dedbaa3dd5740a2"), false);
});

test("keeps the verified remote price when a 5.5 percent commission would propose a higher price", () => {
  const plan = readyPlan({
    commissionRules: [{
      _id: "6ae5c4394043934db6e4eab9",
      scope: "filter",
      percentage: 5.5,
      isActive: true,
      targetId: "6a9ea85375e4e5319a4b9931|brand|6a5f3484a0cba783e62cd24c|_ALL_|_ALL_",
      targetName: { en: "Kozano → Kozano → Home & Kitchen Appliances → All Sub-categories → All Collections" },
      vendorId: "6a9ea85375e4e5319a4b9931",
      brandId: "",
      categoryId: "6a5f3484a0cba783e62cd24c",
      subCategoryId: "",
      collectionId: "",
    }],
  });
  const note = plan.priceNotes.find((row) => row.itemCode === "KE20");
  assert.equal(note.rate, 5.5);
  assert.equal(note.platformPrice, 28000);
  assert.equal(plan.records.find((record) => record.after.approvedSku === "KE20-BLUE").after.lastVerifiedPrice, 26500);
  assert.equal(plan.protectedCollections.includes("commissions"), true);
});

test("does not overwrite a conflicting owner or approved remote id", async () => {
  const blocked = readyPlan({
    owners: [{ skuKey: "ke20", parentSku: "KE20", productId: "other-product", giniProductId: "1", visibility: "hidden", status: "verified_remote" }],
    identities: [{ productId: "other-product", approvedSku: "KE20-BLUE", approvedSkuKey: "ke20-blue", confirmedGiniVariantId: "164306", sourceVariantId: "x", sourceSizeId: "y" }],
  });
  assert.equal(blocked.canApply, false);
  assert.equal(blocked.conflicts.some((row) => row.code === "owner_conflict"), true);
  assert.equal(blocked.conflicts.some((row) => row.code === "identity_conflict"), true);
  const writes = [];
  const result = await applyVariantReconciliation(blocked, {
    authorization: RECONCILIATION_AUTHORIZATION,
    confirm: true,
    write: (record) => writes.push(record),
  });
  assert.equal(result.writes, 0);
  assert.deepEqual(writes, []);
});

test("is idempotent when the same verified records already exist", async () => {
  const first = readyPlan();
  const existingOwners = first.records.filter((record) => record.collection === "ginivariantparentowners").map((record) => record.after);
  const existingIdentities = first.records.filter((record) => record.collection === "ginivariantidentities").map((record) => record.after);
  const second = readyPlan({
    owners: existingOwners,
    identities: existingIdentities,
    contracts: [first.records.find((record) => record.collection === "ginivariantattributecontracts").after],
  });
  assert.equal(second.canApply, true);
  assert.equal(second.records.every((record) => record.action === "unchanged"), true);
  const result = await applyVariantReconciliation(second, {
    authorization: RECONCILIATION_AUTHORIZATION,
    confirm: true,
    write: () => { throw new Error("should not write"); },
  });
  assert.equal(result.code, "already_registered");
  assert.equal(result.writes, 0);
});

test("refuses apply without the explicit authorization", async () => {
  const writes = [];
  const result = await applyVariantReconciliation(readyPlan(), { write: (record) => writes.push(record) });
  assert.equal(result.code, "authorization_required");
  assert.equal(result.writes, 0);
  assert.deepEqual(writes, []);
});

test("closes apply when a unique index is missing", () => {
  const present = indexes();
  delete present.ginivariantidentities;
  const plan = readyPlan({ indexesByCollection: present });
  assert.equal(plan.canApply, false);
  assert.equal(plan.conflicts.some((row) => row.code === "unique_index_missing"), true);
});

test("names the blank-SKU document that makes 162 multi-variant products a 161-row catalog", () => {
  const rows = [{ _id: "extra", itemCode: "", name: { en: "Untitled" }, createdBy: { name: { en: "Modex" } }, variantCount: 2 }];
  for (let index = 0; index < 161; index += 1) rows.push({ _id: `p${index}`, itemCode: `SKU-${index}`, variantCount: 2 });
  const report = explainMultiVariantCount(rows);
  assert.equal(report.multiVariantDocuments, 162);
  assert.equal(report.catalogRows, 161);
  assert.equal(report.omittedBlankSku[0].productId, "extra");
  assert.equal(report.omittedBlankSku[0].vendor, "Modex");
});

test("the dry-run script stays read-only unless apply is explicitly authorized", () => {
  const source = fs.readFileSync(new URL("./scripts/giniVariantReconciliationDryRun.js", import.meta.url), "utf8");
  assert.equal(source.includes("mongoose.set(\"autoIndex\", false)"), true);
  assert.equal(source.includes("mongoose.set(\"autoCreate\", false)"), true);
  assert.equal(source.includes("variant_reconciliation_write_blocked"), true);
  assert.equal(source.includes("$setOnInsert"), true);
  assert.equal(source.includes("performGiniJsonRequest"), false);
  assert.equal(source.includes("--confirm-production"), true);
  assert.equal(source.includes(RECONCILIATION_AUTHORIZATION), true);
});

test("refuses to connect without --confirm-production", async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "scripts/giniVariantReconciliationDryRun.js");
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: path.resolve(path.dirname(script), "..") });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 4);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--confirm-production/);
});
