import assert from "node:assert/strict";
import fs from "node:fs";
import mongoose from "mongoose";
import test from "node:test";
import { GiniVariantOwnershipOperation } from "./models/GiniVariantOwnershipOperation.js";
import {
  assessOwnershipIndexes,
  executeOwnershipIndexMigration,
  OWNERSHIP_OPERATION_COLLECTION,
  ownershipIndexMigrationPlan,
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
