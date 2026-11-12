import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import test from "node:test";
import { GiniVariantOwnershipOperation } from "./models/GiniVariantOwnershipOperation.js";
import {
  backupDirectoryAllowed,
  dumpBrownstoreDatabase,
  exactOwnershipIndexes,
  OWNERSHIP_INDEX_MIGRATION_ONE_SHOT,
  runOneShotOwnershipIndexMigration,
  runProductionOwnershipIndexMigration,
} from "./utils/giniOwnershipIndexMigrationRun.js";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./utils/giniVariantOwnershipAudit.js";
import {
  applyOwnershipIndexMigration,
  assessOwnershipIndexes,
  decideOwnershipIndexMigration,
  decideSkuKeyIndexMigration,
  executeOwnershipIndexMigration,
  OWNERSHIP_MIGRATION_COMMANDS,
  OWNERSHIP_OPERATION_COLLECTION,
  OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED,
  ownershipIndexMigrationPlan,
  readSkuKeyIndexState,
  runOwnershipIndexMigration,
  runSkuKeyIndexMigration,
  SKUKEY_INDEX_COMMAND,
} from "./utils/giniOwnershipIndexPlan.js";

const READY_INDEXES = [
  { key: { operationKey: 1 }, unique: true, name: "operationKey_1" },
  { key: { skuKey: 1 }, unique: true, name: "skuKey_1" },
];
const PARENT_INDEXES = [{ key: { skuKey: 1 }, unique: true, name: "skuKey_1" }];

test("ownership index migration is idempotent and does not run", () => {
  assert.equal(mongoose.connection.readyState, 0);
  assert.equal(GiniVariantOwnershipOperation.schema.options.autoIndex, false);
  assert.equal(GiniVariantOwnershipOperation.schema.options.autoCreate, false);
  assert.equal(GiniVariantOwnershipOperation.collection.collectionName, OWNERSHIP_OPERATION_COLLECTION);
  const missing = ownershipIndexMigrationPlan({ parentOwnerIndexes: PARENT_INDEXES });
  assert.equal(missing.executed, false);
  assert.equal(missing.runFromThisScript, false);
  assert.equal(missing.mutatesParentOwners, false);
  assert.deepEqual(missing.commands, [
    `db.createCollection("${OWNERSHIP_OPERATION_COLLECTION}")`,
    `db.${OWNERSHIP_OPERATION_COLLECTION}.createIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" })`,
    `db.${OWNERSHIP_OPERATION_COLLECTION}.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" })`,
  ]);
  const ready = assessOwnershipIndexes({
    collectionName: OWNERSHIP_OPERATION_COLLECTION,
    indexes: READY_INDEXES,
    parentOwnerIndexes: PARENT_INDEXES,
  });
  assert.equal(ready.readyForOwnershipSave, true);
  assert.deepEqual(ready.commands, []);
  assert.deepEqual(ownershipIndexMigrationPlan({
    collectionName: OWNERSHIP_OPERATION_COLLECTION,
    indexes: READY_INDEXES,
    parentOwnerIndexes: PARENT_INDEXES,
  }).commands, []);
  const sparse = assessOwnershipIndexes({
    collectionName: OWNERSHIP_OPERATION_COLLECTION,
    indexes: [{ key: { operationKey: 1 }, unique: true, sparse: true }, READY_INDEXES[1]],
    parentOwnerIndexes: PARENT_INDEXES,
  });
  assert.equal(sparse.operationKeyEnforced, false);
  assert.equal(sparse.commands.length, 1);
  assert.match(sparse.commands[0], /operationKey/);
  const duplicates = assessOwnershipIndexes({
    collectionName: OWNERSHIP_OPERATION_COLLECTION,
    duplicateSkuKeys: 1,
    parentOwnerIndexes: PARENT_INDEXES,
  });
  assert.equal(duplicates.duplicatesWouldPreventIndexCreation, true);
  assert.deepEqual(duplicates.commands, []);
  const brokenParent = assessOwnershipIndexes({ parentOwnerIndexes: [] });
  assert.equal(brokenParent.parentOwnerIndexIntact, false);
  assert.deepEqual(brokenParent.commands, []);
  const execution = executeOwnershipIndexMigration();
  assert.equal(execution.executed, false);
  assert.equal(execution.code, "ownership_index_migration_not_run");
  assert.deepEqual(execution.writes, []);
  assert.equal(execution.sentToGini, 0);
  const script = fs.readFileSync(new URL("./scripts/giniOwnershipIndexMigration.js", import.meta.url), "utf8");
  assert.equal(script.includes("mongoose"), false);
  assert.equal(script.includes("createIndex("), false);
  assert.equal(script.includes("createCollection("), false);
  assert.equal(mongoose.connection.readyState, 0);
});

const PARENT_UNIQUE = [{ key: { skuKey: 1 }, unique: true, name: "skuKey_1" }];
const OPERATION_KEY = [{ key: { operationKey: 1 }, unique: true, name: "operationKey_1" }];
const VERIFIED_IDENTITY = {
  databaseName: "brownstore",
  loopback: true,
  merchantHostMatches: true,
  clientMaskMatches: true,
  previewFingerprintMatches: true,
};

function observed(extra = {}) {
  return {
    identity: VERIFIED_IDENTITY,
    databaseName: "brownstore",
    parentCollectionExists: true,
    collectionExists: true,
    operationIndexes: OPERATION_KEY,
    parentOwnerIndexes: PARENT_UNIQUE,
    documentCount: 0,
    parentDocumentCount: 6,
    ...extra,
  };
}

test("the ownership index migration refuses duplicates, conflicts, and the wrong database", () => {
  assert.equal(OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  assert.equal(OWNERSHIP_SAVE_PILOT.parentSku, "38104");
  assert.equal(OWNERSHIP_SAVE_PILOT.productId, "6adf9ca49dedbaa3dd573cce");
  const missingCollection = decideOwnershipIndexMigration(observed({
    collectionExists: false,
    operationIndexes: [],
    documentCount: 0,
  }));
  assert.equal(missingCollection.code, "ready_to_create");
  assert.deepEqual(missingCollection.commands, [...OWNERSHIP_MIGRATION_COMMANDS]);
  assert.deepEqual(missingCollection.actions, { createCollection: true, operationKey: true, skuKey: true });
  assert.equal(missingCollection.executed, false);
  const wrongDatabase = decideOwnershipIndexMigration(observed({
    collectionExists: false,
    operationIndexes: [],
    identity: { ...VERIFIED_IDENTITY, previewFingerprintMatches: false },
  }));
  assert.equal(wrongDatabase.code, "database_identity_unverified");
  assert.deepEqual(wrongDatabase.commands, []);
  const readyToCreate = decideSkuKeyIndexMigration(observed());
  assert.equal(readyToCreate.code, "ready_to_create");
  assert.deepEqual(readyToCreate.commands, [SKUKEY_INDEX_COMMAND]);
  assert.equal(readyToCreate.actions.createCollection, false);
  assert.deepEqual(readyToCreate.writes, []);
  const duplicates = decideSkuKeyIndexMigration(observed({ duplicateSkuKeyCount: 1 }));
  assert.equal(duplicates.code, "duplicate_sku_key");
  assert.equal(duplicates.executed, false);
  const blank = decideSkuKeyIndexMigration(observed({ blankSkuKeyCount: 2 }));
  assert.equal(blank.code, "duplicate_sku_key");
  const duplicateOperation = decideOwnershipIndexMigration(observed({ duplicateOperationKeyCount: 1 }));
  assert.equal(duplicateOperation.code, "duplicate_operation_key");
  const incompatible = decideSkuKeyIndexMigration(observed({
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: false, name: "skuKey_1" }],
  }));
  assert.equal(incompatible.code, "incompatible_sku_key_index");
  const sparse = decideSkuKeyIndexMigration(observed({
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, sparse: true, name: "skuKey_1" }],
  }));
  assert.equal(sparse.code, "incompatible_sku_key_index");
  const compound = decideSkuKeyIndexMigration(observed({
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1, productId: 1 }, unique: true, name: "skuKey_1" }],
  }));
  assert.equal(compound.code, "unexpected_operation_index");
  const badOperationKey = decideOwnershipIndexMigration(observed({
    operationIndexes: [{ key: { operationKey: 1 }, unique: false, name: "operationKey_1" }],
  }));
  assert.equal(badOperationKey.code, "incompatible_operation_key_index");
  const missingParent = decideSkuKeyIndexMigration(observed({ parentOwnerIndexes: [] }));
  assert.equal(missingParent.code, "parent_owner_index_not_unique");
  const missingParentCollection = decideOwnershipIndexMigration(observed({
    parentCollectionExists: false,
    collectionExists: false,
    operationIndexes: [],
  }));
  assert.equal(missingParentCollection.code, "parent_owner_collection_missing");
  assert.deepEqual(missingParentCollection.commands, []);
  const already = decideSkuKeyIndexMigration(observed({
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, name: "skuKey_1" }],
  }));
  assert.equal(already.code, "already_ready");
  assert.deepEqual(already.commands, []);
  assert.deepEqual(already.writes, []);
  const renamed = decideSkuKeyIndexMigration(observed({
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, name: "sku_key_unique" }],
  }));
  assert.equal(renamed.code, "already_ready");
});

test("the ownership index migration stays disabled and the mock migration is idempotent", async () => {
  let created = 0;
  let reads = 0;
  const result = await runSkuKeyIndexMigration({
    dryRun: false,
    confirm: true,
    readState: async () => {
      reads += 1;
      return observed({ collectionExists: false, operationIndexes: [] });
    },
    createCollection: async () => {
      created += 1;
    },
    createOperationKeyIndex: async () => {
      created += 1;
    },
    createSkuKeyIndex: async () => {
      created += 1;
    },
  });
  assert.equal(result.code, "ownership_index_migration_disabled");
  assert.equal(result.executed, false);
  assert.equal(result.authorizesOwnershipSave, false);
  assert.deepEqual(result.commands, [...OWNERSHIP_MIGRATION_COMMANDS]);
  assert.deepEqual(result.writes, []);
  assert.equal(created, 0);
  assert.equal(reads, 0);
  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  try {
    const db = client.db("brownstore");
    const parent = db.collection("ginivariantparentowners");
    await parent.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    await parent.insertMany(["ke20", "efr-575d-1adf", "ei-8888", "71868", "69392", "75244"].map((skuKey) => ({ skuKey, status: "verified_remote" })));
    const variants = db.collection("sentinelvariants");
    await variants.insertOne({ sku: "38104" });
    const readState = async () => ({ ...(await readSkuKeyIndexState(db)), identity: VERIFIED_IDENTITY });
    const operations = () => db.collection(OWNERSHIP_OPERATION_COLLECTION);
    const migration = {
      readState,
      createCollection: (name) => db.createCollection(name),
      createOperationKeyIndex: (keys, options) => operations().createIndex(keys, options),
      createSkuKeyIndex: (keys, options) => operations().createIndex(keys, options),
    };
    const dryRun = await applyOwnershipIndexMigration({ ...migration, dryRun: true, confirm: true });
    assert.equal(dryRun.code, "ready_to_create");
    assert.equal(dryRun.executed, false);
    assert.deepEqual(dryRun.writes, []);
    assert.equal((await db.listCollections({ name: OWNERSHIP_OPERATION_COLLECTION }).toArray()).length, 0);
    const createdMigration = await applyOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(createdMigration.code, "ownership_indexes_created");
    assert.equal(createdMigration.authorizesOwnershipSave, false);
    assert.deepEqual(createdMigration.writes, [
      `${OWNERSHIP_OPERATION_COLLECTION}.createCollection`,
      `${OWNERSHIP_OPERATION_COLLECTION}.createIndex(operationKey_1)`,
      `${OWNERSHIP_OPERATION_COLLECTION}.createIndex(skuKey_1)`,
    ]);
    const indexes = await operations().listIndexes().toArray();
    assert.equal(indexes.find((index) => index.name === "operationKey_1")?.unique, true);
    assert.equal(indexes.find((index) => index.name === "skuKey_1")?.unique, true);
    assert.equal(await operations().countDocuments(), 0);
    assert.equal(await parent.countDocuments(), 6);
    assert.equal(await variants.countDocuments(), 1);
    const repeated = await applyOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(repeated.code, "already_ready");
    assert.equal(repeated.executed, false);
    assert.deepEqual(repeated.writes, []);
    await operations().dropIndex("skuKey_1");
    await operations().insertMany([
      { operationKey: "a", skuKey: "38104", productId: "p1" },
      { operationKey: "b", skuKey: "38104", productId: "p2" },
    ]);
    const duplicate = await applyOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(duplicate.code, "duplicate_sku_key");
    assert.equal(duplicate.executed, false);
    assert.equal(await operations().countDocuments(), 2);
    assert.equal((await operations().listIndexes().toArray()).some((index) => index.name === "skuKey_1"), false);
    await operations().deleteMany({});
    await operations().createIndex({ skuKey: 1 }, { unique: false, name: "skuKey_1" });
    const conflict = await applyOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(conflict.code, "incompatible_sku_key_index");
    assert.equal(conflict.executed, false);
    assert.notEqual((await operations().listIndexes().toArray()).find((index) => index.name === "skuKey_1")?.unique, true);
    const disabled = await runOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(disabled.code, "ownership_index_migration_disabled");
    assert.equal(await parent.countDocuments(), 6);
    assert.equal(await variants.countDocuments(), 1);
  } finally {
    await client.close();
    await memory.stop();
  }
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "scripts", "giniOwnershipIndexMigration.js");
  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  const code = await new Promise((resolve) => child.on("close", resolve));
  const printed = JSON.parse(Buffer.concat(output).toString());
  assert.equal(code, 0);
  assert.equal(printed.released, false);
  assert.equal(printed.dryRun, true);
  assert.equal(printed.executes, false);
  assert.deepEqual(printed.commands, [...OWNERSHIP_MIGRATION_COMMANDS]);
  assert.equal(printed.result.code, "ownership_index_migration_disabled");
  assert.equal(printed.result.executed, false);
  assert.equal(mongoose.connection.readyState, 0);
});

test("the one-shot production migration refuses this desktop and preserves documents", async () => {
  let connected = 0;
  const desktop = await runProductionOwnershipIndexMigration({
    argv: ["--execute", "--confirm-production", "--allow-verified-production-loopback", "--confirm-ownership-index-migration", "--backup-dir", "/var/backups/ownership"],
    env: { OWNERSHIP_INDEX_MIGRATION_ONE_SHOT },
    platform: "win32",
    connect: async () => {
      connected += 1;
    },
  });
  assert.equal(desktop.code, "desktop_execution_refused");
  assert.equal(desktop.connected, false);
  assert.equal(desktop.releasedAfter, false);
  assert.equal(desktop.gates.released, false);
  assert.equal(desktop.gates.indexesReady, false);
  assert.equal(desktop.gates.pilotParentSku, "38104");
  assert.equal(desktop.gates.pilotProductId, "6adf9ca49dedbaa3dd573cce");
  assert.equal(connected, 0);
  const missingToken = await runProductionOwnershipIndexMigration({
    argv: ["--execute", "--confirm-production", "--allow-verified-production-loopback", "--confirm-ownership-index-migration", "--backup-dir", "/var/backups/ownership"],
    env: {},
    platform: "linux",
    connect: async () => {
      connected += 1;
    },
  });
  assert.equal(missingToken.code, "ownership_index_migration_disabled");
  assert.equal(connected, 0);
  assert.equal(backupDirectoryAllowed(path.join(os.tmpdir(), "ownership-index"), path.resolve(".")), true);
  assert.equal(backupDirectoryAllowed(path.resolve("backups"), path.resolve(".")), false);
  assert.equal(backupDirectoryAllowed("backups", path.resolve(".")), false);

  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-backup-"));
  try {
    const db = client.db("brownstore");
    const parent = db.collection("ginivariantparentowners");
    await parent.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    await parent.insertMany(["ke20", "efr-575d-1adf", "ei-8888", "71868", "69392", "75244"].map((skuKey) => ({ skuKey, status: "verified_remote" })));
    await db.collection("products").insertOne({ itemCode: "38104" });
    await db.collection("ginivariantidentities").insertOne({ sku: "keep" });
    const readState = async () => ({ ...(await readSkuKeyIndexState(db)), identity: VERIFIED_IDENTITY });
    const operations = () => db.collection(OWNERSHIP_OPERATION_COLLECTION);
    let backups = 0;
    const migration = {
      oneShotRelease: true,
      readState,
      readCounts: async () => {
        const counts = {};
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => item.name);
        for (const name of names) {
          if (name === OWNERSHIP_OPERATION_COLLECTION) continue;
          counts[name] = await db.collection(name).countDocuments();
        }
        return counts;
      },
      backup: async () => {
        backups += 1;
        return { ok: true, directory: temp };
      },
      createCollection: (name) => db.createCollection(name),
      createOperationKeyIndex: (keys, options) => operations().createIndex(keys, options),
      createSkuKeyIndex: (keys, options) => operations().createIndex(keys, options),
      listOperationIndexes: () => operations().listIndexes().toArray(),
    };
    const preview = await runOneShotOwnershipIndexMigration({ ...migration, dryRun: true, confirm: true });
    assert.equal(preview.code, "ready_to_create");
    assert.equal(preview.executed, false);
    assert.equal(backups, 0);
    assert.equal((await db.listCollections({ name: OWNERSHIP_OPERATION_COLLECTION }).toArray()).length, 0);
    const failedBackup = await runOneShotOwnershipIndexMigration({
      ...migration,
      dryRun: false,
      confirm: true,
      backup: async () => ({ ok: false, code: "backup_failed" }),
    });
    assert.equal(failedBackup.code, "backup_failed");
    assert.equal(failedBackup.executed, false);
    assert.equal((await db.listCollections({ name: OWNERSHIP_OPERATION_COLLECTION }).toArray()).length, 0);
    const created = await runOneShotOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(created.code, "ownership_indexes_created");
    assert.equal(created.releasedAfter, false);
    assert.equal(created.authorizesOwnershipSave, false);
    assert.equal(created.indexesReady, true);
    assert.equal(created.countsUnchanged, true);
    assert.equal(exactOwnershipIndexes(await operations().listIndexes().toArray()), true);
    assert.equal(await operations().countDocuments(), 0);
    assert.equal(await parent.countDocuments(), 6);
    assert.equal(await db.collection("products").countDocuments(), 1);
    assert.equal(backups, 1);
    const repeated = await runOneShotOwnershipIndexMigration({ ...migration, dryRun: false, confirm: true });
    assert.equal(repeated.code, "already_ready");
    assert.equal(repeated.executed, false);
    assert.equal(backups, 1);
    const dumpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownership-dump-"));
    const dumped = await dumpBrownstoreDatabase({
      uri: "mongodb://127.0.0.1:1/brownstore",
      directory: dumpDir,
      databaseName: "brownstore",
      spawnImpl: async () => {
        fs.mkdirSync(path.join(dumpDir, "brownstore"), { recursive: true });
        fs.writeFileSync(path.join(dumpDir, "brownstore", "ginivariantparentowners.metadata.json"), "{}");
        fs.writeFileSync(path.join(dumpDir, "brownstore", "ginivariantparentowners.bson"), "parent-owners");
        return { code: 0 };
      },
    });
    assert.equal(dumped.ok, true);
    const incomplete = await dumpBrownstoreDatabase({
      uri: "mongodb://127.0.0.1:1/brownstore",
      directory: temp,
      databaseName: "brownstore",
      spawnImpl: async () => ({ code: 0 }),
    });
    assert.equal(incomplete.code, "backup_incomplete");
    fs.rmSync(dumpDir, { recursive: true, force: true });
  } finally {
    await client.close();
    await memory.stop();
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
