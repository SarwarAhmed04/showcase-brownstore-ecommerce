import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import test from "node:test";
import { evaluateOwnershipSave, previewOwnershipSaveDocuments, OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./utils/giniVariantOwnershipAudit.js";
import { acceptFreshProductionSnapshot, OWNERSHIP_PRODUCTION_PREVIEW } from "./utils/giniOwnershipProductionContext.js";
import {
  ownershipDuplicatePipelines,
  readOwnershipReadiness,
  stoppedOwnershipReport,
  summarizeOwnershipReadiness,
} from "./utils/giniOwnershipReadiness.js";

const DESKTOP_IT = "6adfa1c9b3764a909f69456a";
const DESKTOP_JAWAL = "6ae0906bb3764a909f69498c";
const PRODUCTION_IT = "6adf9ca49dedbaa3dd573cce";
const PRODUCTION_JAWAL = "6ae08bbd9dedbaa3dd5740d9";

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
    assert.equal(report.code, "production_context_unverified");
    assert.equal(report.stopped, true);
    assert.equal(report.pilot, null);
    assert.equal(report.indexes, null);
    assert.equal(report.productionSnapshot, null);
    assert.equal(report.readyForOwnershipSave, false);
    assert.equal(report.gates.anyOpen, false);
    assert.equal(report.migration.executedByThisAudit, false);
    assert.equal(report.sentToGini, 0);
    assert.equal(JSON.stringify(report).includes(String(productA)), false);
    assert.equal(JSON.stringify(report).includes("38104"), false);
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
  const source = fs.readFileSync(script, "utf8");
  assert.equal(source.includes("production_context_unverified"), true);
  assert.equal(source.includes("stoppedOwnershipReport"), true);
  assert.equal(mongoose.connection.readyState, 0);
});

test("an unverified desktop database cannot be reported as the production pilot", async () => {
  const untouched = {
    databaseName: "brownstore",
    collection() {
      throw new Error("desktop catalog was read without production verification");
    },
    listCollections() {
      throw new Error("desktop catalog was listed without production verification");
    },
  };
  const refused = await readOwnershipReadiness(untouched);
  assert.deepEqual(refused, stoppedOwnershipReport());
  assert.equal(refused.code, "production_context_unverified");
  assert.equal(refused.stopped, true);
  assert.equal(refused.indexes, null);
  assert.equal(refused.pilot, null);
  assert.equal(refused.gates.released, false);
  assert.equal(refused.gates.indexesReady, false);
  assert.equal(refused.gates.anyOpen, false);
  assert.equal(JSON.stringify(refused).includes(DESKTOP_IT), false);
  assert.equal(JSON.stringify(refused).includes(DESKTOP_JAWAL), false);

  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  try {
    const desktop = client.db("brownstore");
    const operations = desktop.collection("ginivariantownershipoperations");
    await operations.createIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" });
    await desktop.collection("giniconnections").insertOne({ baseUrl: "https://merchant.gini.iq", clientId: "142300002bee" });
    await desktop.collection("ginisyncjobs").insertOne({ mode: "preview", total: 39495, readyCreate: 0, alreadyExists: 0, blocked: 39302, inactive: 137, createdAt: new Date() });
    await desktop.collection("products").insertMany([
      { _id: new ObjectId(DESKTOP_IT), itemCode: "38104", ibsherId: "6adf9824ef43bcf3ec7d1ee4", createdBy: { _id: "it", name: "IT Lobby" }, name: { en: "Desktop case" }, variants: [] },
      { _id: new ObjectId(DESKTOP_JAWAL), itemCode: "38104", ibsherId: "6adf9cf4ef43bcf3ec7daac1", createdBy: { _id: "jf", name: "Jawal Flex" }, name: { en: "Desktop copy" }, variants: [] },
    ]);
    const trapped = new Proxy(desktop, {
      get(target, prop, receiver) {
        if (prop === "collection") {
          return (name, options) => {
            const key = String(name).toLowerCase();
            if (key === "products" || key === "ginivariantparentowners" || key === "ginivariantownershipoperations") {
              throw new Error(`reported ${name} from an unverified database`);
            }
            return target.collection(name, options);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const desktopReport = await readOwnershipReadiness(trapped, { confirmProduction: true, allowLoopback: true, loopback: true });
    assert.equal(desktopReport.code, "production_context_unverified");
    assert.equal(desktopReport.stopped, true);
    assert.equal(desktopReport.indexes, null);
    assert.equal(desktopReport.productionSnapshot, null);
    const desktopJson = JSON.stringify(desktopReport);
    assert.equal(desktopJson.includes(DESKTOP_IT), false);
    assert.equal(desktopJson.includes(DESKTOP_JAWAL), false);
    assert.equal(desktopJson.includes("operationKey_1"), false);
    const desktopPlan = previewOwnershipSaveDocuments({
      group: { parentSku: "38104", candidates: [{ productId: DESKTOP_IT }, { productId: DESKTOP_JAWAL }] },
      parentSku: "38104",
      productId: DESKTOP_IT,
      vendorId: "it",
      sourceItemId: "6adf9824ef43bcf3ec7d1ee4",
      confirm: true,
      confirmOwnershipSave: true,
    });
    assert.equal(desktopPlan.code, "production_context_unverified");
    assert.equal(desktopPlan.documents, null);
    assert.equal(desktopPlan.wouldWrite, false);
    assert.equal(desktopPlan.sentToGini, 0);
    assert.equal(JSON.stringify(desktopPlan).includes(DESKTOP_IT), false);
    assert.equal(evaluateOwnershipSave({
      group: { parentSku: "38104", candidates: [{ productId: DESKTOP_IT, vendorId: "it", sourceItemId: "6adf9824ef43bcf3ec7d1ee4", parentSku: "38104" }] },
      parentSku: "38104",
      productId: DESKTOP_IT,
      vendorId: "it",
      sourceItemId: "6adf9824ef43bcf3ec7d1ee4",
      confirm: true,
      confirmOwnershipSave: true,
    }).code, "production_context_unverified");

    await desktop.collection("products").deleteMany({});
    await desktop.collection("ginisyncjobs").deleteMany({});
    await desktop.collection("ginisyncjobs").insertOne({ mode: "preview", ...OWNERSHIP_PRODUCTION_PREVIEW, createdAt: new Date() });
    await desktop.collection("ginivariantparentowners").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    await operations.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    await desktop.collection("products").insertMany([
      { _id: new ObjectId(PRODUCTION_IT), itemCode: "38104", ibsherId: "6adf9824ef43bcf3ec7d1ee4", createdBy: { _id: "it", name: "IT Lobby" }, name: { en: "Production case" }, variants: [] },
      { _id: new ObjectId(PRODUCTION_JAWAL), itemCode: "38104", ibsherId: "6adf9cf4ef43bcf3ec7daac1", createdBy: { _id: "jf", name: "Jawal Flex" }, name: { en: "Production copy" }, variants: [] },
    ]);
    const verified = await readOwnershipReadiness(desktop, { confirmProduction: true, allowLoopback: true, loopback: true });
    assert.equal(verified.code, "verified_production_loopback");
    assert.equal(verified.stopped, false);
    assert.equal(verified.indexes.skuKeyEnforced, true);
    assert.equal(verified.indexes.operationKeyEnforced, true);
    assert.equal(verified.indexes.parentOwnerIndexIntact, true);
    assert.deepEqual(verified.pilot.products.map((row) => row.productId).sort(), [PRODUCTION_IT, PRODUCTION_JAWAL].sort());
    assert.equal(JSON.stringify(verified.pilot).includes(DESKTOP_IT), false);
    assert.equal(acceptFreshProductionSnapshot(verified.productionSnapshot, {
      productIds: [PRODUCTION_IT, PRODUCTION_JAWAL],
      productId: PRODUCTION_IT,
    }), true);
    assert.equal(acceptFreshProductionSnapshot(verified.productionSnapshot, {
      productIds: [DESKTOP_IT, DESKTOP_JAWAL],
      productId: DESKTOP_IT,
    }), false);
    const forged = {
      ...verified.productionSnapshot,
      id: "forged-desktop-snapshot",
      productIds: [DESKTOP_IT, DESKTOP_JAWAL],
    };
    assert.equal(acceptFreshProductionSnapshot(forged, { productIds: [DESKTOP_IT, DESKTOP_JAWAL], productId: DESKTOP_IT }), false);
    const authorized = evaluateOwnershipSave({
      group: {
        parentSku: "38104",
        candidates: [
          { productId: PRODUCTION_IT, vendorId: "it", sourceItemId: "6adf9824ef43bcf3ec7d1ee4", parentSku: "38104" },
          { productId: PRODUCTION_JAWAL, vendorId: "jf", sourceItemId: "6adf9cf4ef43bcf3ec7daac1", parentSku: "38104" },
        ],
      },
      parentSku: "38104",
      productId: PRODUCTION_IT,
      vendorId: "it",
      sourceItemId: "6adf9824ef43bcf3ec7d1ee4",
      confirm: true,
      confirmOwnershipSave: true,
      productionSnapshot: verified.productionSnapshot,
    });
    assert.equal(authorized.code, "ownership_save_ready");
    assert.equal(authorized.saved, false);
    assert.equal(authorized.sentToGini, 0);
    assert.deepEqual(authorized.writes, []);
    assert.equal(OWNERSHIP_SAVE_RELEASED, false);
    assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
    assert.equal(OWNERSHIP_SAVE_PILOT.parentSku, "");
    assert.equal(OWNERSHIP_SAVE_PILOT.productId, "");
  } finally {
    await client.close();
    await memory.stop();
  }
  assert.equal(mongoose.connection.readyState, 0);
});
