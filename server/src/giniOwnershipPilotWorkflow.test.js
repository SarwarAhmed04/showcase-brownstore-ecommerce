import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import test from "node:test";
import { giniConnectionRouter } from "./routes/giniConnection.js";
import { GiniVariantOwnershipOperation } from "./models/GiniVariantOwnershipOperation.js";
import { GiniVariantParentOwner } from "./models/GiniVariantParentOwner.js";
import { commitOwnershipSave, OWNERSHIP_COMMIT_TEST, prepareOwnershipSelection } from "./services/giniVariantOwnershipSelection.js";
import { OWNERSHIP_PRODUCTION_PREVIEW, clearOwnershipAuthorizations, rememberVerifiedSnapshot } from "./utils/giniOwnershipProductionContext.js";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_RELEASED } from "./utils/giniVariantOwnershipAudit.js";

const IT = "6adf9ca49dedbaa3dd573cce";
const JAWAL = "6ae08bbd9dedbaa3dd5740d9";
const IT_SOURCE = "6adf9824ef43bcf3ec7d1ee4";
const JAWAL_SOURCE = "6adf9cf4ef43bcf3ec7daac1";
const ADMIN = "admin-1";
const DESKTOP_PREVIEW = { total: 39495, readyCreate: 0, alreadyExists: 0, blocked: 39302, inactive: 137 };
const ENABLED = { GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true", GINI_ALLOW_OWNERSHIP_SAVE: "true" };

async function seed(db, { preview = OWNERSHIP_PRODUCTION_PREVIEW, operationSkuUnique = true } = {}) {
  await db.dropDatabase();
  clearOwnershipAuthorizations();
  await db.collection("giniconnections").insertOne({ baseUrl: "https://merchant.gini.iq/api", clientId: "142300002bee" });
  await db.collection("ginisyncjobs").insertOne({ mode: "preview", ...preview, createdAt: new Date() });
  await db.collection("products").insertMany([
    {
      _id: new ObjectId(IT),
      itemCode: "38104",
      ibsherId: IT_SOURCE,
      createdBy: { _id: "it-lobby", name: "IT Lobby" },
      name: { en: "Note 11 Pro" },
      variants: [{}, {}],
    },
    {
      _id: new ObjectId(JAWAL),
      itemCode: "38104",
      ibsherId: JAWAL_SOURCE,
      createdBy: { _id: "jawal-flex", name: "Jawal Flex" },
      name: { en: "Note 11 Pro copy" },
      variants: [{}, {}],
    },
  ]);
  await db.collection("ginivariantparentowners").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
  await db.collection("ginivariantownershipoperations").createIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" });
  await db.collection("ginivariantownershipoperations").createIndex(
    { skuKey: 1 },
    { unique: operationSkuUnique, sparse: operationSkuUnique !== true, name: "skuKey_1" }
  );
}

function listen(userId = ADMIN) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.user = { _id: userId };
    next();
  });
  app.use(giniConnectionRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function post(server, path, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function saveInput(snapshotId, extra = {}) {
  return {
    parentSku: "38104",
    productId: IT,
    vendorId: "it-lobby",
    sourceItemId: IT_SOURCE,
    confirm: true,
    confirmOwnershipSave: true,
    administratorId: ADMIN,
    snapshotId,
    ...extra,
  };
}

test("ownership preview registers a process-local snapshot and save stays gated off", async () => {
  const memory = await MongoMemoryServer.create();
  const server = await listen();
  try {
    await mongoose.connect(memory.getUri(), { dbName: "brownstore" });
    const db = mongoose.connection.db;
    await seed(db, { preview: DESKTOP_PREVIEW, operationSkuUnique: true });
    const desktop = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
      parentSku: "38104",
      productId: IT,
      confirm: true,
      productionSnapshot: { id: "browser-snapshot", productIds: [IT, JAWAL] },
    });
    assert.equal(desktop.status, 200);
    assert.equal(desktop.body.code, "production_context_unverified");
    assert.equal(desktop.body.authorizationSnapshot, null);
    assert.equal(desktop.body.saved, false);
    assert.equal(desktop.body.sentToGini, 0);
    assert.equal(JSON.stringify(desktop.body).includes(IT), false);
    assert.equal(JSON.stringify(desktop.body).includes(JAWAL), false);

    await seed(db, { operationSkuUnique: false });
    const badIndex = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
      parentSku: "38104",
      productId: IT,
      confirm: true,
    });
    assert.equal(badIndex.body.code, "ownership_indexes_not_ready");
    assert.equal(badIndex.body.productionReview.verified, true);
    assert.equal(badIndex.body.productionReview.liveIndexesReady, false);
    assert.equal(badIndex.body.authorizationSnapshot, null);
    assert.equal(badIndex.body.saved, false);

    await seed(db);
    const jawal = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
      parentSku: "38104",
      productId: JAWAL,
      confirm: true,
    });
    assert.equal(jawal.body.code, "pilot_not_authorized");
    assert.equal(jawal.body.authorizationSnapshot, null);
    assert.equal(jawal.body.deletedFromBrownStore, false);
    assert.equal(jawal.body.sentToGini, 0);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 0);

    const missingAdmin = await prepareOwnershipSelection({
      parentSku: "38104",
      productId: IT,
      confirm: true,
      administratorId: "",
      requireProductionReview: true,
    }, { host: "127.0.0.1", db });
    assert.equal(missingAdmin.code, "approval_required");
    assert.equal(missingAdmin.authorizationSnapshot, null);

    const before = await db.collection("ginivariantparentowners").countDocuments();
    const review = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
      parentSku: "38104",
      productId: IT,
      confirm: true,
      productionSnapshot: { id: "do-not-trust", productId: JAWAL },
    });
    assert.equal(review.body.code, "selection_prepared_not_saved");
    assert.equal(review.body.productionReview.verified, true);
    assert.equal(review.body.productionReview.liveIndexesReady, true);
    assert.equal(review.body.selected.vendor, "IT Lobby");
    assert.equal(review.body.selected.productId, IT);
    assert.equal(review.body.selected.sourceItemId, IT_SOURCE);
    assert.equal(review.body.excluded[0].productId, JAWAL);
    assert.equal(review.body.excluded[0].deletedFromBrownStore, false);
    assert.equal(review.body.saveAvailable, false);
    assert.equal(review.body.gates.released, false);
    assert.equal(review.body.gates.indexesReady, false);
    assert.equal(review.body.saved, false);
    assert.equal(review.body.sentToGini, 0);
    assert.equal(review.body.authorizationSnapshot.productId, IT);
    assert.equal(review.body.authorizationSnapshot.administratorId, ADMIN);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), before);
    assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 0);

    const disabled = await post(server, "/platforms/gini/variant-sync/ownership/save", {
      ...saveInput(review.body.authorizationSnapshot.id),
      productionSnapshot: review.body.authorizationSnapshot,
      administratorId: "forged-admin",
    });
    assert.equal(disabled.status, 409);
    assert.equal(disabled.body.code, "ownership_save_disabled");
    assert.equal(disabled.body.saved, false);
    assert.equal(disabled.body.sentToGini, 0);
    assert.equal(disabled.body.databaseRechecked, false);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 0);

    const deps = { host: "127.0.0.1", db, unitCommit: OWNERSHIP_COMMIT_TEST, env: ENABLED };
    const snapshotId = review.body.authorizationSnapshot.id;
    assert.equal((await commitOwnershipSave(saveInput(""), deps)).code, "production_context_unverified");
    assert.equal((await commitOwnershipSave(saveInput("forged-snapshot"), deps)).code, "production_context_unverified");
    const cli = rememberVerifiedSnapshot({ productIds: [IT, JAWAL], sourceItemIds: [IT_SOURCE, JAWAL_SOURCE] });
    assert.equal((await commitOwnershipSave(saveInput(cli.id), deps)).code, "production_context_unverified");
    assert.equal((await commitOwnershipSave(saveInput(snapshotId, { administratorId: "other-admin" }), deps)).code, "snapshot_admin_mismatch");
    assert.equal((await commitOwnershipSave(saveInput(snapshotId, { productId: JAWAL, vendorId: "jawal-flex", sourceItemId: JAWAL_SOURCE }), deps)).code, "pilot_not_authorized");
    assert.equal((await commitOwnershipSave(saveInput(snapshotId, { confirm: false }), deps)).code, "approval_required");
    const expired = await commitOwnershipSave(saveInput(snapshotId), {
      ...deps,
      now: Date.parse(review.body.authorizationSnapshot.expiresAt) + 1,
    });
    assert.equal(expired.code, "production_snapshot_expired");
    assert.equal(expired.saved, false);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 0);

    await db.collection("ginivariantownershipoperations").dropIndex("skuKey_1");
    const dropped = await commitOwnershipSave(saveInput(snapshotId), deps);
    assert.equal(dropped.code, "ownership_indexes_not_ready");
    assert.equal(dropped.saved, false);
    await db.collection("ginivariantownershipoperations").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });

    await db.collection("ginivariantparentowners").insertOne({
      skuKey: "38104",
      parentSku: "38104",
      productId: JAWAL,
      vendorId: "jawal-flex",
      status: "approved",
      giniProductId: "",
    });
    const conflict = await commitOwnershipSave(saveInput(snapshotId), deps);
    assert.equal(conflict.code, "owner_already_approved");
    assert.equal(conflict.saved, false);
    assert.equal(conflict.sentToGini, 0);
    await db.collection("ginivariantparentowners").deleteMany({});

    const partial = await commitOwnershipSave(saveInput(snapshotId), {
      ...deps,
      operationModel: {
        async create() {
          throw Object.assign(new Error("operation write failed"), { code: 50 });
        },
      },
    });
    assert.equal(partial.code, "ownership_operation_incomplete");
    assert.equal(partial.saved, false);
    assert.equal(partial.sentToGini, 0);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);
    assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 0);
    const partialOwner = await db.collection("ginivariantparentowners").findOne({});
    assert.equal(partialOwner.status, "approved");
    assert.equal(partialOwner.giniProductId, "");
    assert.notEqual(partialOwner.status, "verified_remote");

    const repaired = await commitOwnershipSave(saveInput(snapshotId), deps);
    assert.equal(repaired.saved, false);
    assert.equal(repaired.sentToGini, 0);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);
    assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 1);
    const operation = await db.collection("ginivariantownershipoperations").findOne({});
    assert.equal(operation.status, "recorded");
    assert.equal(operation.productId, IT);
    assert.deepEqual(operation.excludedProductIds, [JAWAL]);

    const retry = await commitOwnershipSave(saveInput(snapshotId), deps);
    assert.equal(retry.code, "ownership_already_recorded");
    assert.equal(retry.idempotent, true);
    assert.equal(retry.saved, false);
    assert.equal(retry.sentToGini, 0);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);

    clearOwnershipAuthorizations();
    const restarted = await commitOwnershipSave(saveInput(snapshotId), deps);
    assert.equal(restarted.code, "production_context_unverified");
    assert.equal(restarted.saved, false);

    await db.collection("ginivariantparentowners").deleteMany({});
    await db.collection("ginivariantownershipoperations").deleteMany({});
    const fresh = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
      parentSku: "38104",
      productId: IT,
      confirm: true,
    });
    const raced = await Promise.all([
      commitOwnershipSave(saveInput(fresh.body.authorizationSnapshot.id), deps),
      commitOwnershipSave(saveInput(fresh.body.authorizationSnapshot.id), deps),
    ]);
    assert.equal(raced.every((row) => row.sentToGini === 0 && row.canSend === false), true);
    assert.equal(raced.filter((row) => row.saved === true).length, 1);
    assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);
    assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 1);
    const recorded = await db.collection("ginivariantparentowners").findOne({});
    assert.equal(recorded.status, "approved");
    assert.equal(recorded.giniProductId, "");
    assert.equal(recorded.productId, IT);
    assert.equal(OWNERSHIP_SAVE_RELEASED, false);
    assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  }
});

test("an authorization snapshot from another process is rejected", async () => {
  const { registerOwnershipAuthorization } = await import("./utils/giniOwnershipProductionContext.js");
  const snapshot = registerOwnershipAuthorization({
    parentSku: "38104",
    productId: IT,
    sourceItemId: IT_SOURCE,
    vendorId: "it-lobby",
    administratorId: ADMIN,
    productIds: [IT, JAWAL],
    sourceItemIds: [IT_SOURCE, JAWAL_SOURCE],
  });
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { resolveOwnershipAuthorization } from "./src/utils/giniOwnershipProductionContext.js";
    const result = resolveOwnershipAuthorization(process.env.SNAPSHOT_ID, {
      parentSku: "38104",
      productId: process.env.PRODUCT_ID,
      sourceItemId: process.env.SOURCE_ITEM,
      vendorId: "it-lobby",
      administratorId: "admin-1",
    });
    process.stdout.write(result.code);
  `], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, SNAPSHOT_ID: snapshot.id, PRODUCT_ID: IT, SOURCE_ITEM: IT_SOURCE },
  });
  const output = await new Promise((resolve, reject) => {
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.on("error", reject);
    child.on("exit", () => resolve(text));
  });
  assert.equal(output, "production_context_unverified");
  clearOwnershipAuthorizations();
});
