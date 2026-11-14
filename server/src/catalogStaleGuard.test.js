import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Product } from "./models/Product.js";
import { CatalogSyncAudit } from "./models/CatalogSyncAudit.js";
import { CatalogSyncHold } from "./models/CatalogSyncHold.js";
import { applyCatalogAbsence, approveCatalogDeletions, CATALOG_DELETION_APPROVAL, planCatalogAbsence } from "./utils/catalogStaleGuard.js";

const KEPT = "kept-source";
const MISSING = "missing-source";
const DUPLICATE = "duplicate-source";

async function seed(ids) {
  await Product.deleteMany({});
  await CatalogSyncHold.deleteMany({});
  await CatalogSyncAudit.deleteMany({});
  await Product.insertMany(ids.map((ibsherId) => ({
    ibsherId,
    itemCode: ibsherId,
    name: { en: ibsherId },
    status: "published",
    isActive: true,
    lastSyncedAt: new Date("2026-11-14T06:00:00.000Z"),
  })));
}

before(async () => {
  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  globalThis.__guardMemory = memory;
});

after(async () => {
  await mongoose.disconnect();
  await globalThis.__guardMemory.stop();
});

test("the 27-product feed drop is quarantined instead of deleted", () => {
  const missing = Array.from({ length: 27 }, (_, index) => `brandiraq-${index}`);
  const plan = planCatalogAbsence({
    missingIds: missing,
    priorHolds: [],
    remoteTotal: 43430,
    localTotal: 43457,
  });
  assert.equal(plan.mode, "confirm");
  assert.equal(plan.deleteIds.length, 0);
  assert.equal(plan.quarantine.length, 27);
  assert.equal(plan.quarantine[0].missingSyncs, 1);
});

test("one percent of a full catalog is held without advancing deletion", () => {
  const plan = planCatalogAbsence({
    missingIds: Array.from({ length: 435 }, (_, index) => `pct-${index}`),
    priorHolds: [],
    remoteTotal: 43022,
    localTotal: 43457,
  });
  assert.equal(plan.mode, "shrink_hold");
  assert.equal(plan.deleteIds.length, 0);
});

test("a large feed shrink and an outage do not advance deletion", () => {
  const shrink = planCatalogAbsence({
    missingIds: Array.from({ length: 500 }, (_, index) => `drop-${index}`),
    priorHolds: [{ ibsherId: "drop-0", missingSyncs: 2 }],
    remoteTotal: 42957,
    localTotal: 43457,
  });
  assert.equal(shrink.mode, "shrink_hold");
  assert.deepEqual(shrink.deleteIds, []);
  assert.deepEqual(shrink.quarantine, []);

  const outage = planCatalogAbsence({
    missingIds: ["drop-0"],
    priorHolds: [{ ibsherId: "drop-0", missingSyncs: 2 }],
    remoteTotal: 1000,
    localTotal: 43457,
  });
  assert.equal(outage.mode, "outage");
  assert.deepEqual(outage.deleteIds, []);
});

test("duplicate feed ids and a later reappearance clear the hold", () => {
  const plan = planCatalogAbsence({
    missingIds: [],
    priorHolds: [{ ibsherId: DUPLICATE, missingSyncs: 2 }],
    remoteTotal: 2,
    localTotal: 2,
  });
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.clearIds, [DUPLICATE]);
});

test("one smaller complete feed quarantines a product and keeps its document", async () => {
  await seed([KEPT, MISSING]);
  const first = await applyCatalogAbsence({
    seenIds: [KEPT, KEPT],
    remoteTotal: 1,
    syncedAt: new Date("2026-11-14T06:59:19.000Z"),
  });
  assert.equal(first.mode, "confirm");
  assert.equal(first.removed, 0);
  assert.equal(first.quarantined, 1);
  assert.equal(await Product.countDocuments({ ibsherId: MISSING }), 1);
  const hold = await CatalogSyncHold.findOne({ ibsherId: MISSING }).lean();
  assert.equal(hold.missingSyncs, 1);
  const audit = await CatalogSyncAudit.findOne({ mode: "confirm" }).lean();
  assert.deepEqual(audit.quarantineIds, [MISSING]);
  assert.deepEqual(audit.deleteIds, []);
});

test("the same absence must be confirmed by two later syncs before deletion", async () => {
  await seed([KEPT, MISSING]);
  const times = [
    "2026-11-14T06:59:19.000Z",
    "2026-11-14T07:59:19.000Z",
    "2026-11-14T08:59:19.000Z",
  ];
  const results = [];
  for (const time of times) {
    results.push(await applyCatalogAbsence({
      seenIds: [KEPT],
      remoteTotal: 1,
      syncedAt: new Date(time),
    }));
  }
  assert.deepEqual(results.map((result) => result.removed), [0, 0, 0]);
  assert.equal(results[2].awaitingApproval, 1);
  const again = await applyCatalogAbsence({
    seenIds: [KEPT],
    remoteTotal: 1,
    syncedAt: new Date("2026-11-14T09:59:19.000Z"),
  });
  assert.equal(again.removed, 0);
  assert.equal(again.awaitingApproval, 1);
  const hold = await CatalogSyncHold.findOne({ ibsherId: MISSING }).lean();
  assert.equal(hold.missingSyncs, 3);
  assert.equal(hold.approvalState, "awaiting_approval");
  assert.equal(await Product.countDocuments({ ibsherId: MISSING }), 1);

  const refused = await approveCatalogDeletions({ ibsherIds: [MISSING], approval: "no" });
  assert.equal(refused.removed, 0);
  assert.equal(refused.refused, "approval_required");
  const approved = await approveCatalogDeletions({
    ibsherIds: [MISSING, KEPT],
    approval: CATALOG_DELETION_APPROVAL,
  });
  assert.deepEqual(approved.deleteIds, [MISSING]);
  assert.equal(approved.removed, 1);
  assert.equal(await Product.countDocuments({ ibsherId: MISSING }), 0);
  assert.equal(await Product.countDocuments({ ibsherId: KEPT }), 1);
  const deleted = await CatalogSyncAudit.findOne({ mode: "approved_deletion" }).lean();
  assert.deepEqual(deleted.deleteIds, [MISSING]);
});

test("a product that returns on the next sync is not deleted", async () => {
  await seed([KEPT, MISSING]);
  await applyCatalogAbsence({
    seenIds: [KEPT],
    remoteTotal: 1,
    syncedAt: new Date("2026-11-14T06:59:19.000Z"),
  });
  const back = await applyCatalogAbsence({
    seenIds: [KEPT, MISSING],
    remoteTotal: 2,
    syncedAt: new Date("2026-11-14T07:30:00.000Z"),
  });
  assert.equal(back.removed, 0);
  assert.equal(back.cleared, 1);
  assert.equal(await Product.countDocuments({ ibsherId: MISSING }), 1);
  assert.equal(await CatalogSyncHold.countDocuments({ ibsherId: MISSING }), 0);
  const third = await applyCatalogAbsence({
    seenIds: [KEPT],
    remoteTotal: 1,
    syncedAt: new Date("2026-11-14T08:59:19.000Z"),
  });
  assert.equal(third.removed, 0);
  assert.equal(third.quarantined, 1);
  assert.equal(await Product.countDocuments({ ibsherId: MISSING }), 1);
});

test("an outage does not turn an existing hold into a deletion", async () => {
  await seed([KEPT, MISSING]);
  await applyCatalogAbsence({
    seenIds: [KEPT],
    remoteTotal: 1,
    syncedAt: new Date("2026-11-14T06:59:19.000Z"),
  });
  const outage = await applyCatalogAbsence({
    seenIds: [],
    remoteTotal: 0,
    syncedAt: new Date("2026-11-14T07:59:19.000Z"),
  });
  assert.equal(outage.mode, "outage");
  assert.equal(outage.removed, 0);
  const hold = await CatalogSyncHold.findOne({ ibsherId: MISSING }).lean();
  assert.equal(hold.missingSyncs, 1);
  assert.equal(await Product.countDocuments(), 2);
});
