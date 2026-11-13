import assert from "node:assert/strict";
import fs from "node:fs";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import test from "node:test";
import { giniConnectionRouter } from "./routes/giniConnection.js";
import { commitOwnershipSave, OWNERSHIP_COMMIT_TEST } from "./services/giniVariantOwnershipSelection.js";
import { OWNERSHIP_PRODUCTION_PREVIEW, clearOwnershipAuthorizations } from "./utils/giniOwnershipProductionContext.js";
import {
  describeFirstLiveOwnershipSaveAuthorization,
  firstLiveInsertAllowed,
  firstLivePairDecision,
} from "./utils/giniOwnershipFirstSaveProcedure.js";
import {
  OWNERSHIP_SAVE_EXCLUDED,
  OWNERSHIP_SAVE_INDEXES_READY,
  OWNERSHIP_SAVE_PILOT,
  OWNERSHIP_SAVE_RELEASED,
  ownershipSaveAuthorization,
} from "./utils/giniVariantOwnershipAudit.js";

const IT = "6adf9ca49dedbaa3dd573cce";
const JAWAL = "6ae08bbd9dedbaa3dd5740d9";
const IT_SOURCE = "6adf9824ef43bcf3ec7d1ee4";
const JAWAL_SOURCE = "6adf9cf4ef43bcf3ec7daac1";
const ENABLED = { GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true", GINI_ALLOW_OWNERSHIP_SAVE: "true" };

function pair(extraOwner = {}, extraExcluded = {}) {
  return [
    {
      productId: IT,
      parentSku: "38104",
      vendor: "IT Lobby",
      vendorId: "it-lobby",
      sourceItemId: IT_SOURCE,
      ...extraOwner,
    },
    {
      productId: JAWAL,
      parentSku: "38104",
      vendor: "Jawal Flex",
      vendorId: "jawal-flex",
      sourceItemId: JAWAL_SOURCE,
      ...extraExcluded,
    },
  ];
}

test("the first live ownership save procedure stays closed and reversible", () => {
  const before = {
    enabled: process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED,
    allow: process.env.GINI_ALLOW_OWNERSHIP_SAVE,
  };
  const procedure = describeFirstLiveOwnershipSaveAuthorization();
  assert.equal(process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED, before.enabled);
  assert.equal(process.env.GINI_ALLOW_OWNERSHIP_SAVE, before.allow);
  assert.equal(procedure.phase, "prepared_not_authorized");
  assert.equal(procedure.execute, false);
  assert.equal(procedure.authorized, false);
  assert.equal(procedure.writesPermitted, false);
  assert.equal(procedure.enabled, false);
  assert.equal(procedure.open.executed, false);
  assert.equal(procedure.close.executed, false);
  assert.equal(procedure.snapshotTtlMs, 15 * 60 * 1000);
  assert.deepEqual(procedure.gates.map((gate) => gate.name), [
    "OWNERSHIP_SAVE_RELEASED",
    "OWNERSHIP_SAVE_INDEXES_READY",
    "GINI_VARIANT_OWNERSHIP_SAVE_ENABLED",
    "GINI_ALLOW_OWNERSHIP_SAVE",
  ]);
  assert.equal(procedure.gates[0].location.includes("giniVariantOwnershipAudit.js"), true);
  assert.equal(procedure.gates[1].location.includes("giniVariantOwnershipAudit.js"), true);
  assert.equal(procedure.gates[2].kind, "environment");
  assert.equal(procedure.gates[3].kind, "environment");
  assert.equal(procedure.gates[0].open, false);
  assert.equal(procedure.gates[1].open, false);
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  assert.equal(procedure.binding.parentSku, "38104");
  assert.equal(procedure.binding.productId, IT);
  assert.equal(procedure.binding.vendorName, "IT Lobby");
  assert.equal(procedure.binding.sourceItemId, IT_SOURCE);
  assert.equal(procedure.binding.excluded.productId, JAWAL);
  assert.equal(procedure.binding.excluded.vendorName, "Jawal Flex");
  assert.equal(procedure.binding.excluded.sourceItemId, JAWAL_SOURCE);
  assert.equal(procedure.binding.excluded.deletedFromBrownStore, false);
  assert.deepEqual(procedure.allowedWrites.map((row) => row.collection), [
    "ginivariantparentowners",
    "ginivariantownershipoperations",
  ]);
  assert.equal(procedure.forbidden.includes("price_update"), true);
  assert.equal(procedure.forbidden.includes("gini_send"), true);
  assert.equal(procedure.forbidden.includes("variant_sku_approval"), true);
  assert.equal(procedure.forbidden.includes("stock_merge"), true);
  const partial = describeFirstLiveOwnershipSaveAuthorization(ENABLED);
  assert.equal(partial.enabled, false);
  assert.equal(partial.writesPermitted, false);
  assert.equal(partial.execute, false);
  assert.equal(ownershipSaveAuthorization(ENABLED).enabled, false);
  assert.equal(ownershipSaveAuthorization(ENABLED).released, false);
  assert.equal(ownershipSaveAuthorization(ENABLED).indexesReady, false);
});

test("the first live pair accepts only IT Lobby 38104 and keeps Jawal Flex", () => {
  assert.equal(firstLivePairDecision(pair()), "");
  assert.equal(firstLivePairDecision(pair({ vendor: "Other Shop" })), "pilot_not_authorized");
  assert.equal(firstLivePairDecision(pair({}, { vendor: "IT Lobby" })), "pilot_not_authorized");
  assert.equal(firstLivePairDecision(pair({ parentSku: "75244" })), "pilot_not_authorized");
  assert.equal(firstLivePairDecision(pair().slice(0, 1)), "pilot_not_authorized");
  assert.equal(firstLivePairDecision([
    ...pair(),
    { productId: "6adf9ca49dedbaa3dd573ccc", parentSku: "38104", vendor: "Third", vendorId: "third", sourceItemId: "src-3" },
  ]), "pilot_not_authorized");
  assert.equal(firstLivePairDecision(pair({ sourceItemId: "other-source" })), "pilot_not_authorized");
  const documents = {
    owner: {
      skuKey: "38104",
      parentSku: "38104",
      productId: IT,
      vendorId: "it-lobby",
      status: "approved",
      giniProductId: "",
    },
    operation: {
      productId: IT,
      sourceItemId: IT_SOURCE,
      status: "recorded",
      excludedProductIds: [JAWAL],
    },
  };
  assert.equal(firstLiveInsertAllowed(documents), true);
  assert.equal(firstLiveInsertAllowed({
    ...documents,
    operation: { ...documents.operation, excludedProductIds: [JAWAL, IT] },
  }), false);
  assert.equal(firstLiveInsertAllowed({
    ...documents,
    owner: { ...documents.owner, productId: JAWAL },
  }), false);
  assert.equal(firstLiveInsertAllowed({
    ...documents,
    owner: { ...documents.owner, status: "verified_remote" },
  }), false);
  assert.equal(OWNERSHIP_SAVE_PILOT.vendorName, "IT Lobby");
  assert.equal(OWNERSHIP_SAVE_EXCLUDED.vendorName, "Jawal Flex");
});

test("a gated commit still refuses every SKU other than the IT Lobby pilot", async () => {
  let touched = 0;
  const deps = {
    unitCommit: OWNERSHIP_COMMIT_TEST,
    env: ENABLED,
    host: "127.0.0.1",
    db: { get databaseName() { touched += 1; return "brownstore"; } },
  };
  const otherSku = await commitOwnershipSave({
    parentSku: "75244",
    productId: IT,
    vendorId: "it-lobby",
    sourceItemId: IT_SOURCE,
    confirm: true,
    confirmOwnershipSave: true,
    administratorId: "admin-1",
    snapshotId: "unused",
  }, deps);
  assert.equal(otherSku.code, "pilot_not_authorized");
  assert.equal(otherSku.saved, false);
  assert.equal(otherSku.sentToGini, 0);
  assert.equal(touched, 0);
  const unconfirmed = await commitOwnershipSave({
    parentSku: "38104",
    productId: IT,
    vendorId: "it-lobby",
    sourceItemId: IT_SOURCE,
    confirm: true,
    confirmOwnershipSave: false,
    administratorId: "admin-1",
    snapshotId: "unused",
  }, deps);
  assert.equal(unconfirmed.code, "approval_required");
  assert.equal(unconfirmed.saved, false);
  assert.equal(touched, 0);
  const service = fs.readFileSync(new URL("./services/giniVariantOwnershipSelection.js", import.meta.url), "utf8");
  const commit = service.slice(service.indexOf("export async function commitOwnershipSave"), service.indexOf("export async function saveOwnershipSelection"));
  assert.ok(commit.indexOf("firstLivePairDecision") < commit.indexOf("insertOnce"));
  assert.ok(commit.indexOf("firstLiveInsertAllowed") < commit.indexOf("insertOnce"));
  for (const token of ["approveVariantSkus", "performGiniRequest", "price", "Product.update", "deleteOne", "deleteMany"]) {
    assert.equal(commit.includes(token), false, token);
  }
});

async function seed(db, products) {
  await db.dropDatabase();
  clearOwnershipAuthorizations();
  await db.collection("giniconnections").insertOne({ baseUrl: "https://merchant.gini.iq/api", clientId: "142300002bee" });
  await db.collection("ginisyncjobs").insertOne({ mode: "preview", ...OWNERSHIP_PRODUCTION_PREVIEW, createdAt: new Date() });
  await db.collection("products").insertMany(products);
  await db.collection("ginivariantparentowners").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
  await db.collection("ginivariantownershipoperations").createIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" });
  await db.collection("ginivariantownershipoperations").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
}

function product(id, source, vendorId, vendor) {
  return {
    _id: new ObjectId(id),
    itemCode: "38104",
    ibsherId: source,
    createdBy: { _id: vendorId, name: vendor },
    name: { en: vendor },
    variants: [{}, {}],
  };
}

test("production review refuses a renamed vendor or a third SKU 38104 product and writes nothing", async () => {
  const memory = await MongoMemoryServer.create();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { _id: "admin-1" };
    next();
  });
  app.use(giniConnectionRouter);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    await mongoose.connect(memory.getUri(), { dbName: "brownstore" });
    const db = mongoose.connection.db;
    await seed(db, [
      product(IT, IT_SOURCE, "it-lobby", "Other Shop"),
      product(JAWAL, JAWAL_SOURCE, "jawal-flex", "Jawal Flex"),
    ]);
    const renamed = await fetch(`http://127.0.0.1:${server.address().port}/platforms/gini/variant-sync/ownership/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSku: "38104", productId: IT, confirm: true }),
    });
    const renamedBody = await renamed.json();
    assert.equal(renamedBody.code, "pilot_not_authorized");
    assert.equal(renamedBody.authorizationSnapshot, null);
    assert.equal(renamedBody.saved, false);
    assert.equal(renamedBody.sentToGini, 0);
    assert.equal(renamedBody.deletedFromBrownStore, false);
    assert.equal(renamedBody.firstLiveSave.execute, false);
    assert.equal(renamedBody.firstLiveSave.writesPermitted, false);

    await seed(db, [
      product(IT, IT_SOURCE, "it-lobby", "IT Lobby"),
      product(JAWAL, JAWAL_SOURCE, "jawal-flex", "Jawal Flex"),
      product("6adf9ca49dedbaa3dd573ccd", "6adf9ca49dedbaa3dd573cc1", "third", "Third Vendor"),
    ]);
    const third = await fetch(`http://127.0.0.1:${server.address().port}/platforms/gini/variant-sync/ownership/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentSku: "38104", productId: IT, confirm: true }),
    });
    const thirdBody = await third.json();
    assert.equal(thirdBody.code, "pilot_not_authorized");
    assert.equal(thirdBody.authorizationSnapshot, null);
    assert.equal(thirdBody.saved, false);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 0);
    assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 0);
    const jawal = await db.collection("products").findOne({ _id: new ObjectId(JAWAL) });
    assert.equal(jawal.createdBy.name, "Jawal Flex");
    assert.equal(jawal.ibsherId, JAWAL_SOURCE);
    assert.equal(OWNERSHIP_SAVE_RELEASED, false);
    assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  }
});
