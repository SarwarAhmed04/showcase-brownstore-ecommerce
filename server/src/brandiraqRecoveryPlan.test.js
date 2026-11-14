import assert from "node:assert/strict";
import test from "node:test";
import { planSelectiveRecovery, verifySelectiveRecovery } from "./utils/brandiraqRecoveryPlan.js";

const ORIGINAL = "6aec328a4043934db6e59e0e";
const SOURCE = "6a86d351c9c53aab4127ea2e";

function backup(extra = {}) {
  return {
    _id: ORIGINAL,
    ibsherId: SOURCE,
    price: 45000,
    sourceUpdatedAt: "2026-11-13T18:03:02.000Z",
    overrides: { price: 47000, sku: "LOCAL-SKU" },
    ...extra,
  };
}

test("an absent original document is restored with its MongoDB id and overrides", () => {
  const plan = planSelectiveRecovery({
    backupProducts: [backup()],
    currentProducts: [],
  });
  assert.equal(plan.writes, false);
  assert.equal(plan.restoreCount, 1);
  assert.equal(plan.conflictCount, 0);
  assert.equal(plan.actions[0].action, "restore_original");
  assert.equal(plan.actions[0].backupId, ORIGINAL);
  assert.equal(plan.actions[0].preserveOverrides, true);
  assert.match(plan.actions[0].note, /original _id/);
});

test("a replacement document with a new id is a conflict and is not inserted", () => {
  const plan = planSelectiveRecovery({
    backupProducts: [backup()],
    currentProducts: [{
      _id: "new-mongo-id",
      ibsherId: SOURCE,
      price: 52000,
      sourceUpdatedAt: "2026-11-14T07:30:25.302Z",
    }],
  });
  assert.equal(plan.restoreCount, 0);
  assert.equal(plan.conflictCount, 1);
  assert.deepEqual(plan.actions[0].currentIds, ["new-mongo-id"]);
  assert.equal(plan.actions[0].newerCurrentId, "new-mongo-id");
  assert.match(plan.actions[0].note, /Do not insert/);
});

test("duplicate current source ids are reported and not treated as a clean restore", () => {
  const plan = planSelectiveRecovery({
    backupProducts: [backup()],
    currentProducts: [
      { _id: "one", ibsherId: SOURCE, sourceUpdatedAt: "2026-11-14T07:00:00.000Z", price: 100 },
      { _id: "two", ibsherId: SOURCE, sourceUpdatedAt: "2026-11-14T07:30:00.000Z", price: 200 },
    ],
  });
  assert.deepEqual(plan.duplicateSourceIds, [SOURCE]);
  assert.equal(plan.actions[0].action, "reinserted_conflict");
  assert.equal(plan.actions[0].newerCurrentId, "two");
  assert.equal(plan.restoreCount, 0);
});

test("post-recovery verification accepts only the original id", () => {
  const expected = [backup()];
  const verified = verifySelectiveRecovery({ expected, currentProducts: [backup({ price: 100 })] });
  assert.equal(verified.writes, false);
  assert.equal(verified.verified, 1);
  assert.deepEqual(verified.failed, []);
  const conflict = verifySelectiveRecovery({
    expected,
    currentProducts: [{ _id: "new-mongo-id", ibsherId: SOURCE }],
  });
  assert.equal(conflict.verified, 0);
  assert.equal(conflict.failed[0].reason, "conflicting_id");
  const duplicate = verifySelectiveRecovery({
    expected,
    currentProducts: [
      backup(),
      { _id: "new-mongo-id", ibsherId: SOURCE },
    ],
  });
  assert.equal(duplicate.failed[0].reason, "duplicate_source");
});

test("the same original document is left unchanged", () => {
  const plan = planSelectiveRecovery({
    backupProducts: [backup()],
    currentProducts: [backup({ price: 99999 })],
  });
  assert.equal(plan.actions[0].action, "already_present");
  assert.equal(plan.restoreCount, 0);
});
