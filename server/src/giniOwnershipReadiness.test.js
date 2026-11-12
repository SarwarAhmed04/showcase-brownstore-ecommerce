import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import test from "node:test";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./utils/giniVariantOwnershipAudit.js";
import {
  ownershipDuplicatePipelines,
  readOwnershipReadiness,
  summarizeOwnershipReadiness,
} from "./utils/giniOwnershipReadiness.js";

function guarded(db) {
  const blocked = ["createCollection", "dropDatabase", "dropCollection", "renameCollection"];
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (blocked.includes(prop)) throw new Error(`blocked ${String(prop)}`);
      if (prop === "collection") {
        return (name, options) => guardCollection(target.collection(name, options));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function guardCollection(collection) {
  const blocked = ["createIndex", "createIndexes", "dropIndex", "dropIndexes", "insertOne", "insertMany", "updateOne", "updateMany", "deleteOne", "deleteMany", "bulkWrite", "replaceOne", "findOneAndUpdate", "findOneAndReplace", "findOneAndDelete"];
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (blocked.includes(prop)) throw new Error(`blocked ${String(prop)}`);
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("ownership readiness pipelines and gates cannot write or authorize a save", () => {
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  assert.equal(OWNERSHIP_SAVE_PILOT.parentSku, "");
  assert.equal(OWNERSHIP_SAVE_PILOT.productId, "");
  const pipelines = JSON.stringify(ownershipDuplicatePipelines());
  assert.equal(pipelines.includes('"$out"'), false);
  assert.equal(pipelines.includes('"$merge"'), false);
  const script = fs.readFileSync(new URL("./scripts/giniOwnershipReadinessAudit.js", import.meta.url), "utf8");
  for (const token of ["createIndex(", "createCollection(", "syncIndexes(", "updateOne(", "deleteOne(", "insertOne(", "bulkWrite(", "performGiniRequest"]) {
    assert.equal(script.includes(token), false, token);
  }
  assert.equal(mongoose.connection.readyState, 0);
  const summary = summarizeOwnershipReadiness({
    parentCollection: "ginivariantparentowners",
    parentIndexes: [{ key: { skuKey: 1 }, unique: true, name: "skuKey_1" }],
    pilotProducts: [
      { _id: "p1", itemCode: "38104", ibsherId: "src-a", createdBy: { _id: "v1", name: "IT Lobby" }, name: { en: "Case" }, variants: [{ images: [{ url: "/a.webp" }] }] },
      { _id: "p2", itemCode: "38104", ibsherId: "src-b", createdBy: { _id: "v2", name: "Jawal Flex" }, name: { en: "Case copy" }, variants: [] },
    ],
  });
  assert.equal(summary.readyForOwnershipSave, false);
  assert.equal(summary.gates.anyOpen, false);
  assert.equal(summary.pilot.comparedWithLastReview.productCountMatches, true);
  assert.equal(summary.pilot.comparedWithLastReview.stillUnowned, true);
  assert.equal(summary.migration.executedByThisAudit, false);
  assert.equal(summary.migration.safeToPrepare, true);
  assert.equal(summary.missing.includes("ginivariantownershipoperations collection"), true);
  assert.equal(summary.indexes.parentOwnerIndexIntact, true);
});

test("a memory database read does not create the ownership operation collection", async () => {
  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  try {
    const db = client.db("ownership-readiness");
    const owners = db.collection("ginivariantparentowners");
    await owners.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    const kept = new ObjectId();
    const productA = new ObjectId();
    const productB = new ObjectId();
    await owners.insertOne({ skuKey: "71868", parentSku: "71868", productId: String(kept), vendorId: "it", status: "verified_remote", giniProductId: "618623" });
    await db.collection("products").insertMany([
      { _id: kept, itemCode: "71868", ibsherId: "kept-src", createdBy: { _id: "it", name: "IT Lobby" }, name: { en: "F8" }, variants: [] },
      { _id: productA, itemCode: "38104", ibsherId: "src-a", createdBy: { _id: "it", name: "IT Lobby" }, name: { en: "Case" }, variants: [{ images: [{ url: "uploads/products/a.webp" }] }] },
      { _id: productB, itemCode: "38104", ibsherId: "src-b", createdBy: { _id: "jf", name: "Jawal Flex" }, name: { en: "Case copy" }, variants: [] },
    ]);
    const report = await readOwnershipReadiness(guarded(db));
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
    assert.equal(names.includes("ginivariantownershipoperations"), false);
    assert.equal(report.indexes.parentOwnerIndexIntact, true);
    assert.equal(report.indexes.collectionExists, false);
    assert.equal(report.indexes.operationKeyEnforced, false);
    assert.equal(report.indexes.skuKeyEnforced, false);
    assert.equal(report.readyForOwnershipSave, false);
    assert.equal(report.pilot.owners.length, 0);
    assert.equal(report.pilot.operations.length, 0);
    assert.equal(report.pilot.products.length, 2);
    assert.equal(report.pilot.comparedWithLastReview.stillUnowned, true);
    assert.equal(report.conflictCount, 0);
    assert.equal(report.migration.executedByThisAudit, false);
    assert.equal(report.sentToGini, 0);
    const conflicted = summarizeOwnershipReadiness({
      parentCollection: "ginivariantparentowners",
      parentIndexes: [{ key: { skuKey: 1 }, unique: true }],
      duplicateSkuKeys: [{ _id: "38104", count: 2, productIds: ["p1", "p2"], statuses: ["approved"] }],
      duplicateOperationKeys: [{ _id: "ownership-save:38104:p1", count: 2, productIds: ["p1", "p2"] }],
    });
    assert.deepEqual(conflicted.migration.commands, []);
    assert.equal(conflicted.migration.safeToPrepare, false);
    assert.equal(conflicted.conflictCount > 0, true);
  } finally {
    await client.close();
    await memory.stop();
  }
  assert.equal(mongoose.connection.readyState, 0);
});

test("the audit refuses to connect without confirmation", async () => {
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "scripts", "giniOwnershipReadinessAudit.js");
  const child = spawn(process.execPath, [script], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 4);
  assert.match(Buffer.concat(chunks).toString(), /Refusing to connect/);
  assert.equal(mongoose.connection.readyState, 0);
});
