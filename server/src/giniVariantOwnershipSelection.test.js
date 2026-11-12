import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import mongoose from "mongoose";
import test from "node:test";
import { GiniVariantIdentity } from "./models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "./models/GiniVariantParentOwner.js";
import { giniConnectionRouter } from "./routes/giniConnection.js";
import { approveParentOwner } from "./services/giniVariantSync.js";
import { classifyVariantProduct } from "./utils/giniVariantCatalog.js";
import {
  attemptFutureOwnershipSave,
  auditDuplicateOwnership,
  pageOwnershipGroups,
  planOwnershipSelection,
} from "./utils/giniVariantOwnershipAudit.js";
import { listOwnershipGroups, prepareOwnershipSelection } from "./services/giniVariantOwnershipSelection.js";

const COLOR = { attributeId: "3696", name: "Color", values: ["Blue", "Black", "Green"] };

function member(parentSku, { productId, vendor, vendorId, name, sourceItemId, stock, blockers, imageUrls }) {
  return {
    productId,
    name: name || `${vendor} ${parentSku}`,
    parentSku,
    vendor,
    vendorId,
    sourceItemId,
    imageUrls: imageUrls || [],
    blockers: blockers || ["duplicate_parent_sku", "missing_variant_sku_approval"],
    combinations: [
      { color: "Blue", proposedSku: `${parentSku}-BLUE`, stock },
      { color: "Black", proposedSku: `${parentSku}-BLACK`, stock: 1 },
    ],
  };
}

function manyGroups(count, { verifiedAt = [] } = {}) {
  const products = [];
  for (let index = 1; index <= count; index += 1) {
    const sku = `OWN-${String(index).padStart(3, "0")}`;
    const highStockVendor = index % 2 === 0 ? "IT Lobby" : "Jawal Flex";
    const lowStockVendor = highStockVendor === "IT Lobby" ? "Jawal Flex" : "IT Lobby";
    products.push(
      member(sku, {
        productId: `high-${index}`,
        vendor: highStockVendor,
        vendorId: highStockVendor === "IT Lobby" ? "it-lobby" : "jawal",
        name: `Case ${sku}`,
        sourceItemId: `src-high-${index}`,
        stock: 50 + index,
        imageUrls: [`/${sku}-high.webp`],
      }),
      member(sku, {
        productId: `low-${index}`,
        vendor: lowStockVendor,
        vendorId: lowStockVendor === "IT Lobby" ? "it-lobby" : "jawal",
        name: `Case ${sku} copy`,
        sourceItemId: `src-low-${index}`,
        stock: 1,
        imageUrls: [`/${sku}-low.webp`],
      })
    );
  }
  const owners = verifiedAt.map((index) => ({
    parentSku: `OWN-${String(index).padStart(3, "0")}`,
    productId: `low-${index}`,
    status: "verified_remote",
    giniProductId: `remote-${index}`,
    visibility: "hidden",
  }));
  return { products, owners };
}

test("pagination reaches every duplicate group past the first page", () => {
  const { products, owners } = manyGroups(23, { verifiedAt: [1, 2, 3] });
  const audit = auditDuplicateOwnership({ products, owners, plans: products });
  assert.equal(audit.uniqueDuplicateSkuGroups, 23);
  assert.equal(audit.groupsWithVerifiedOwner, 3);
  assert.equal(audit.groupsAwaitingSelection, 20);
  assert.equal(audit.automaticSelection, false);
  assert.equal(audit.groups.every((group) => group.selectedProductId == null && group.preferredCandidate == null), true);
  const pageSize = 8;
  const seen = new Set();
  const unresolved = new Set();
  let pages = 0;
  for (let page = 1; page <= 10; page += 1) {
    const result = pageOwnershipGroups(audit, { page, pageSize });
    pages = result.pages;
    assert.equal(result.saved, false);
    assert.equal(result.canSend, false);
    assert.equal(result.pageGroupCount <= pageSize, true);
    if (page === 1) assert.equal(result.pageGroupCount, pageSize);
    for (const group of result.groups) {
      seen.add(group.parentSku);
      if (group.selectionOpen) unresolved.add(group.parentSku);
    }
    if (page === result.pages) break;
  }
  assert.equal(pages, 3);
  assert.equal(seen.size, 23);
  assert.equal(unresolved.size, 20);
  const byName = pageOwnershipGroups(audit, { query: "Case OWN-010", pageSize: 8 });
  assert.deepEqual(byName.groups.map((group) => group.parentSku), ["OWN-010"]);
  const byVendor = pageOwnershipGroups(audit, { query: "Jawal Flex", pageSize: 20 });
  assert.equal(byVendor.total, 23);
  assert.equal(byVendor.groups.every((group) => group.vendors.includes("Jawal Flex")), true);
  const bySku = pageOwnershipGroups(audit, { query: "own-023" });
  assert.equal(bySku.groups.length, 1);
  assert.equal(bySku.groups[0].parentSku, "OWN-023");
});

test("grouping keeps both vendor products and records their identity", () => {
  const lobby = classifyVariantProduct({
    doc: {
      _id: "6adf9ca49dedbaa3dd573c99",
      itemCode: "SHARE-9",
      ibsherId: "71868-it",
      name: { en: "F8 Cover" },
      createdBy: { _id: "6abcfd26d134be2c4f632a02", name: "IT Lobby" },
      variants: [
        { _id: "v1", color: { en: "Blue" }, images: [{ url: "/lobby-blue.webp" }], sizes: [{ _id: "s1", size: "large", stockQuantity: 2 }] },
        { _id: "v2", color: { en: "Black" }, images: [{ url: "/lobby-black.webp" }], sizes: [{ _id: "s2", size: "large", stockQuantity: 9 }] },
      ],
    },
    giniPrice: 1000,
    mappingOk: true,
    ownerIds: ["6adf9ca49dedbaa3dd573c99", "6ae08bbb9dedbaa3dd5740a2"],
    colorContract: COLOR,
  });
  const jawal = classifyVariantProduct({
    doc: {
      _id: "6ae08bbb9dedbaa3dd5740a2",
      itemCode: "SHARE-9",
      ibsherId: "71868-jawal",
      name: { en: "F8 Cover Flex" },
      createdBy: { _id: "6ad326b8669f3bf0af58f970", name: "Jawal Flex" },
      variants: [
        { _id: "v3", color: { en: "Blue" }, images: [{ url: "/jawal-blue.webp" }], sizes: [{ _id: "s3", size: "large", stockQuantity: 40 }] },
        { _id: "v4", color: { en: "Green" }, images: [{ url: "/jawal-green.webp" }], sizes: [{ _id: "s4", size: "large", stockQuantity: 1 }] },
      ],
    },
    giniPrice: 1000,
    mappingOk: true,
    ownerIds: ["6adf9ca49dedbaa3dd573c99", "6ae08bbb9dedbaa3dd5740a2"],
    colorContract: COLOR,
  });
  const alone = member("ONLY-1", { productId: "solo", vendor: "IT Lobby", vendorId: "it-lobby", sourceItemId: "solo-src", stock: 4 });
  const audit = auditDuplicateOwnership({ products: [jawal, lobby, alone], plans: [jawal, lobby, alone] });
  assert.equal(audit.uniqueDuplicateSkuGroups, 1);
  const group = audit.groups[0];
  assert.equal(group.preferredCandidate, null);
  assert.equal(group.selectedProductId, null);
  assert.deepEqual(group.candidates.map((row) => row.productId), ["6adf9ca49dedbaa3dd573c99", "6ae08bbb9dedbaa3dd5740a2"]);
  const it = group.candidates[0];
  const flex = group.candidates[1];
  assert.equal(it.vendor, "IT Lobby");
  assert.equal(it.name, "F8 Cover");
  assert.equal(it.sourceItemId, "71868-it");
  assert.deepEqual(it.imageUrls, ["/lobby-blue.webp", "/lobby-black.webp"]);
  assert.deepEqual(it.colors, ["Blue", "Black"]);
  assert.deepEqual(it.variantSkus, ["SHARE-9-BLUE", "SHARE-9-BLACK"]);
  assert.equal(it.stock[0].stock, 2);
  assert.equal(flex.vendor, "Jawal Flex");
  assert.equal(flex.name, "F8 Cover Flex");
  assert.equal(flex.productId, "6ae08bbb9dedbaa3dd5740a2");
  assert.equal(flex.totalStock > it.totalStock, true);
  assert.equal(group.selectionOpen, true);
});

test("verified owners and reconciled parents stay locked", () => {
  const products = [
    member("OPEN-1", { productId: "a", vendor: "IT Lobby", vendorId: "it", sourceItemId: "ia", stock: 3 }),
    member("OPEN-1", { productId: "b", vendor: "Jawal Flex", vendorId: "jf", sourceItemId: "ib", stock: 8 }),
    member("KEPT-1", { productId: "owner", vendor: "IT Lobby", vendorId: "it", sourceItemId: "io", stock: 1 }),
    member("KEPT-1", { productId: "copy", vendor: "Jawal Flex", vendorId: "jf", sourceItemId: "ic", stock: 20 }),
    member("71868", { productId: "reconciled", vendor: "IT Lobby", vendorId: "it", sourceItemId: "ir", stock: 4 }),
    member("71868", { productId: "other", vendor: "Jawal Flex", vendorId: "jf", sourceItemId: "io2", stock: 4 }),
  ];
  const audit = auditDuplicateOwnership({
    products,
    plans: products,
    owners: [{ parentSku: "KEPT-1", productId: "owner", status: "verified_remote", giniProductId: "618623", visibility: "hidden" }],
    remoteBySku: { "KEPT-1": { state: "present", id: "618623", visibility: "hidden", variants: [] } },
  });
  const open = audit.groups.find((group) => group.parentSku === "OPEN-1");
  const kept = audit.groups.find((group) => group.parentSku === "KEPT-1");
  const reconciled = audit.groups.find((group) => group.parentSku === "71868");
  assert.equal(open.selectionOpen, true);
  assert.equal(kept.selectionOpen, false);
  assert.equal(kept.verifiedOwner.productId, "owner");
  assert.equal(kept.remote.id, "618623");
  assert.equal(kept.candidates.find((row) => row.productId === "copy").role, "non_owner");
  const replaceVerified = planOwnershipSelection({ group: kept, productId: "copy", confirm: true });
  assert.equal(replaceVerified.code, "owner_already_verified");
  assert.equal(replaceVerified.saved, false);
  assert.equal(replaceVerified.overwritesOwner, false);
  assert.equal(replaceVerified.sentToGini, 0);
  const restateVerified = planOwnershipSelection({ group: kept, productId: "owner", confirm: true });
  assert.equal(restateVerified.code, "owner_already_verified");
  assert.equal(restateVerified.saved, false);
  assert.equal(reconciled.knownReconciledParent, true);
  assert.equal(reconciled.selectionOpen, false);
  const touchReconciled = planOwnershipSelection({ group: reconciled, productId: "other", confirm: true });
  assert.equal(touchReconciled.code, "owner_already_verified");
  assert.equal(touchReconciled.saved, false);
});

test("conflicting ownership is refused for either candidate", () => {
  const products = [
    member("DUP-1", { productId: "p1", vendor: "IT Lobby", vendorId: "it", sourceItemId: "s1", stock: 5 }),
    member("DUP-1", { productId: "p2", vendor: "Jawal Flex", vendorId: "jf", sourceItemId: "s2", stock: 1 }),
  ];
  const duplicateRecords = auditDuplicateOwnership({
    products,
    plans: products,
    owners: [
      { parentSku: "DUP-1", productId: "p1", status: "approved" },
      { parentSku: "DUP-1", productId: "p2", status: "verified_remote", giniProductId: "9" },
    ],
  });
  const conflict = duplicateRecords.groups[0];
  assert.equal(conflict.conflictingOwners, true);
  assert.equal(conflict.selectionOpen, false);
  assert.equal(planOwnershipSelection({ group: conflict, productId: "p1", confirm: true }).code, "conflicting_owner");
  assert.equal(planOwnershipSelection({ group: conflict, productId: "p2", confirm: true }).overwritesOwner, false);
  const outside = auditDuplicateOwnership({
    products,
    plans: products,
    owners: [{ parentSku: "DUP-1", productId: "missing-product", status: "approved" }],
  });
  assert.equal(outside.groups[0].conflictingOwners, true);
  assert.equal(planOwnershipSelection({ group: outside.groups[0], productId: "p2", confirm: true }).code, "conflicting_owner");
  const differentApproved = auditDuplicateOwnership({
    products,
    plans: products,
    owners: [{ parentSku: "DUP-1", productId: "p1", status: "approved" }],
  });
  const refused = planOwnershipSelection({ group: differentApproved.groups[0], productId: "p2", confirm: true });
  assert.equal(refused.code, "owner_already_approved");
  assert.equal(refused.saved, false);
  assert.equal(refused.writes.length, 0);
});

test("selection preparation rechecks the database and does not save or send", async () => {
  const openProducts = [
    member("SHARE-9", {
      productId: "p1",
      vendor: "IT Lobby",
      vendorId: "it-lobby",
      name: "F8 Cover",
      sourceItemId: "item-a",
      stock: 2,
      blockers: ["duplicate_parent_sku", "missing_variant_sku_approval"],
      imageUrls: ["/a.webp"],
    }),
    member("SHARE-9", {
      productId: "p2",
      vendor: "Jawal Flex",
      vendorId: "jawal",
      name: "F8 Cover Flex",
      sourceItemId: "item-b",
      stock: 40,
      blockers: ["duplicate_parent_sku", "missing_color_mapping"],
    }),
  ];
  let owners = [];
  const deps = {
    loadCatalog: async () => ({ products: openProducts }),
    loadOwners: async () => owners,
  };
  const needsChoice = await prepareOwnershipSelection({ parentSku: "SHARE-9", productId: "p1", confirm: false, group: { candidates: [] } }, deps);
  assert.equal(needsChoice.code, "approval_required");
  assert.equal(needsChoice.saved, false);
  assert.equal(needsChoice.databaseRechecked, true);
  const prepared = await prepareOwnershipSelection({ parentSku: "SHARE-9", productId: "p1", confirm: true }, deps);
  assert.equal(prepared.code, "selection_prepared_not_saved");
  assert.equal(prepared.saved, false);
  assert.equal(prepared.sentToGini, 0);
  assert.equal(prepared.canSend, false);
  assert.deepEqual(prepared.writes, []);
  assert.equal(prepared.approvesVariantSkus, false);
  assert.equal(prepared.inventsAttributeMappings, false);
  assert.equal(prepared.mergesStock, false);
  assert.equal(prepared.proposal.productId, "p1");
  assert.equal(prepared.proposal.vendorId, "it-lobby");
  assert.equal(prepared.proposal.status, "pending_explicit_save");
  assert.deepEqual(prepared.nextBlockers, ["missing_variant_sku_approval"]);
  assert.equal(prepared.nextGate, "missing_approved_variant_skus");
  assert.equal(prepared.excluded.length, 1);
  assert.equal(prepared.excluded[0].productId, "p2");
  assert.equal(prepared.excluded[0].disposition, "excluded_from_gini_ownership");
  assert.equal(prepared.excluded[0].deletedFromBrownStore, false);
  assert.equal(prepared.futureSave.implemented, false);
  assert.equal(prepared.futureSave.authorization.enabledByDefault, false);
  assert.equal(prepared.save.code, "ownership_save_disabled");
  const outsider = await prepareOwnershipSelection({ parentSku: "SHARE-9", productId: "not-in-group", confirm: true }, deps);
  assert.equal(outsider.code, "candidate_not_in_group");
  assert.equal(outsider.saved, false);
  owners = [{ parentSku: "SHARE-9", productId: "p2", status: "verified_remote", giniProductId: "700" }];
  const stale = await prepareOwnershipSelection({ parentSku: "SHARE-9", productId: "p1", confirm: true }, deps);
  assert.equal(stale.code, "owner_already_verified");
  assert.equal(stale.saved, false);
  assert.equal(stale.overwritesOwner, false);
  const listed = await listOwnershipGroups({ query: "F8 Cover Flex", page: 1, pageSize: 10 }, deps);
  assert.equal(listed.total, 1);
  assert.equal(listed.groups[0].selectionOpen, false);
  assert.equal(listed.groups[0].verifiedOwner.productId, "p2");
  assert.equal(listed.futureSave.routeExposed, false);
  const disabled = attemptFutureOwnershipSave({ confirm: true }, {
    GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true",
    GINI_ALLOW_OWNERSHIP_SAVE: "true",
  });
  assert.equal(disabled.saved, false);
  assert.equal(disabled.authorizationEnabled, false);
  assert.deepEqual(disabled.writes, []);
  const service = fs.readFileSync(new URL("./services/giniVariantOwnershipSelection.js", import.meta.url), "utf8");
  assert.equal(service.includes("updateOne"), false);
  assert.equal(service.includes("performGiniRequest"), false);
  assert.equal(service.includes(".save("), false);
  const routes = fs.readFileSync(new URL("./routes/giniConnection.js", import.meta.url), "utf8");
  assert.equal(routes.includes("/platforms/gini/variant-sync/ownership/preview"), true);
  assert.equal(routes.includes("variant-sync/ownership/save"), false);
  const panel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniOwnershipSelectionPanel.jsx", import.meta.url), "utf8");
  const syncPanel = fs.readFileSync(new URL("../../client/src/components/admin/platform/GiniVariantSyncPanel.jsx", import.meta.url), "utf8");
  assert.equal(panel.includes("Review selection"), true);
  assert.equal(panel.includes("giniVariantApproveOwner"), false);
  assert.equal(panel.includes("Save owner"), false);
  assert.equal(syncPanel.includes("slice(0, 8)"), false);
  assert.equal(syncPanel.includes("GiniOwnershipSelectionPanel"), true);
  assert.equal(syncPanel.includes("giniVariantApproveOwner"), false);
});

test("the legacy approve-owner route returns 410 and performs no MongoDB writes", async () => {
  const writes = [];
  const originals = [];
  for (const model of [GiniVariantParentOwner, GiniVariantIdentity]) {
    for (const name of ["updateOne", "insertOne", "deleteOne", "deleteMany", "replaceOne", "findOneAndUpdate", "bulkWrite", "create"]) {
      originals.push([model, name, model[name]]);
      model[name] = (...args) => {
        writes.push(`${model.modelName}.${name}`);
        return originals.find((row) => row[0] === model && row[1] === name)[2].apply(model, args);
      };
    }
  }
  const app = express();
  app.use(express.json());
  app.use(giniConnectionRouter);
  const server = await new Promise((resolve) => {
    const running = app.listen(0, "127.0.0.1", () => resolve(running));
  });
  try {
    const port = server.address().port;
    for (const productId of ["verified-owner-product", "competing-vendor-product"]) {
      const response = await fetch(`http://127.0.0.1:${port}/platforms/gini/variant-sync/approve-owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productId, confirm: true }),
      });
      assert.equal(response.status, 410);
      const body = await response.json();
      assert.equal(body.code, "owner_approval_disabled");
      assert.equal(body.saved, false);
      assert.equal(body.overwritesOwner, false);
      assert.equal(body.sentToGini, 0);
      assert.deepEqual(body.writes, []);
    }
    const direct = await approveParentOwner({ productId: "verified-owner-product", confirm: true });
    assert.equal(direct.saved, false);
    assert.equal(direct.overwritesOwner, false);
    assert.deepEqual(writes, []);
    assert.equal(mongoose.connection.readyState, 0);
    const api = fs.readFileSync(new URL("../../client/src/api.js", import.meta.url), "utf8");
    const admin = fs.readFileSync(new URL("./routes/admin.js", import.meta.url), "utf8");
    const pilot = fs.readFileSync(new URL("./services/giniVariantPilot.js", import.meta.url), "utf8");
    const sync = fs.readFileSync(new URL("./services/giniVariantSync.js", import.meta.url), "utf8");
    const ownerFunction = sync.slice(sync.indexOf("export async function approveParentOwner"));
    assert.equal(api.includes("/variant-sync/approve-owner"), false);
    assert.equal(admin.indexOf("adminRouter.use(requireAdmin)") < admin.indexOf("adminRouter.use(giniConnectionRouter)"), true);
    assert.equal(ownerFunction.includes("updateOne"), false);
    assert.equal(ownerFunction.includes("GiniVariantParentOwner"), false);
    assert.equal(pilot.includes('slot.ownerRequired ? "duplicate_parent_sku"'), true);
  } finally {
    for (const [model, name, original] of originals) model[name] = original;
    await new Promise((resolve) => server.close(resolve));
  }
});
