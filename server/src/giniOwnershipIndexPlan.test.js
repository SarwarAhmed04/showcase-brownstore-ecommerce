import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import test from "node:test";
import { GiniVariantOwnershipOperation } from "./models/GiniVariantOwnershipOperation.js";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./utils/giniVariantOwnershipAudit.js";
import {
  assessOwnershipIndexes,
  decideSkuKeyIndexMigration,
  executeOwnershipIndexMigration,
  OWNERSHIP_OPERATION_COLLECTION,
  OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED,
  ownershipIndexMigrationPlan,
  readSkuKeyIndexState,
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

test("the skuKey index migration refuses duplicates and incompatible indexes", () => {
  assert.equal(OWNERSHIP_SKUKEY_INDEX_MIGRATION_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  assert.equal(OWNERSHIP_SAVE_PILOT.parentSku, "");
  assert.equal(OWNERSHIP_SAVE_PILOT.productId, "");
  const readyToCreate = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: OPERATION_KEY,
    parentOwnerIndexes: PARENT_UNIQUE,
    documentCount: 0,
  });
  assert.equal(readyToCreate.code, "ready_to_create");
  assert.equal(readyToCreate.command, SKUKEY_INDEX_COMMAND);
  assert.deepEqual(readyToCreate.writes, []);
  const duplicates = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: OPERATION_KEY,
    parentOwnerIndexes: PARENT_UNIQUE,
    duplicateSkuKeyCount: 1,
  });
  assert.equal(duplicates.code, "duplicate_sku_key");
  assert.equal(duplicates.executed, false);
  const blank = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: OPERATION_KEY,
    parentOwnerIndexes: PARENT_UNIQUE,
    blankSkuKeyCount: 2,
  });
  assert.equal(blank.code, "duplicate_sku_key");
  const incompatible = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: false, name: "skuKey_1" }],
    parentOwnerIndexes: PARENT_UNIQUE,
  });
  assert.equal(incompatible.code, "incompatible_sku_key_index");
  const sparse = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, sparse: true, name: "skuKey_1" }],
    parentOwnerIndexes: PARENT_UNIQUE,
  });
  assert.equal(sparse.code, "incompatible_sku_key_index");
  const compound = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1, productId: 1 }, unique: true, name: "skuKey_1" }],
    parentOwnerIndexes: PARENT_UNIQUE,
  });
  assert.equal(compound.code, "incompatible_sku_key_index");
  const missingParent = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: OPERATION_KEY,
    parentOwnerIndexes: [],
  });
  assert.equal(missingParent.code, "parent_owner_index_not_unique");
  const already = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, name: "skuKey_1" }],
    parentOwnerIndexes: PARENT_UNIQUE,
    documentCount: 0,
  });
  assert.equal(already.code, "already_ready");
  assert.equal(already.command, null);
  assert.deepEqual(already.writes, []);
  const renamed = decideSkuKeyIndexMigration({
    collectionExists: true,
    operationIndexes: [...OPERATION_KEY, { key: { skuKey: 1 }, unique: true, name: "sku_key_unique" }],
    parentOwnerIndexes: PARENT_UNIQUE,
  });
  assert.equal(renamed.code, "already_ready");
});

test("the skuKey index migration stays disabled and performs no writes", async () => {
  let created = 0;
  let reads = 0;
  const result = await runSkuKeyIndexMigration({
    dryRun: false,
    confirm: true,
    readState: async () => {
      reads += 1;
      return {
        collectionExists: true,
        operationIndexes: OPERATION_KEY,
        parentOwnerIndexes: PARENT_UNIQUE,
        documentCount: 0,
      };
    },
    createSkuKeyIndex: async () => {
      created += 1;
    },
  });
  assert.equal(result.code, "sku_key_index_migration_disabled");
  assert.equal(result.executed, false);
  assert.equal(result.authorizesOwnershipSave, false);
  assert.deepEqual(result.writes, []);
  assert.equal(created, 0);
  assert.equal(reads, 0);
  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  try {
    const db = client.db("sku-key-migration");
    const operations = db.collection(OWNERSHIP_OPERATION_COLLECTION);
    await operations.createIndex({ operationKey: 1 }, { unique: true, name: "operationKey_1" });
    await operations.insertMany([
      { operationKey: "a", skuKey: "38104", productId: "p1" },
      { operationKey: "b", skuKey: "38104", productId: "p2" },
    ]);
    await db.collection("ginivariantparentowners").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    const duplicate = decideSkuKeyIndexMigration(await readSkuKeyIndexState(db));
    assert.equal(duplicate.code, "duplicate_sku_key");
    await operations.deleteMany({});
    await operations.createIndex({ skuKey: 1 }, { unique: false, name: "skuKey_1" });
    const conflict = decideSkuKeyIndexMigration(await readSkuKeyIndexState(db));
    assert.equal(conflict.code, "incompatible_sku_key_index");
    await operations.dropIndex("skuKey_1");
    const pending = decideSkuKeyIndexMigration(await readSkuKeyIndexState(db));
    assert.equal(pending.code, "ready_to_create");
    const namesBefore = (await operations.listIndexes().toArray()).map((index) => index.name).sort();
    const disabled = await runSkuKeyIndexMigration({
      dryRun: false,
      confirm: true,
      readState: () => readSkuKeyIndexState(db),
      createSkuKeyIndex: (...args) => operations.createIndex(...args),
    });
    const namesAfter = (await operations.listIndexes().toArray()).map((index) => index.name).sort();
    assert.equal(disabled.code, "sku_key_index_migration_disabled");
    assert.deepEqual(namesAfter, namesBefore);
    await operations.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
    const idempotent = decideSkuKeyIndexMigration(await readSkuKeyIndexState(db));
    assert.equal(idempotent.code, "already_ready");
    assert.equal(await operations.countDocuments(), 0);
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
  assert.equal(printed.command, SKUKEY_INDEX_COMMAND);
  assert.equal(printed.result.code, "sku_key_index_migration_disabled");
  assert.equal(printed.result.executed, false);
  assert.equal(mongoose.connection.readyState, 0);
});
