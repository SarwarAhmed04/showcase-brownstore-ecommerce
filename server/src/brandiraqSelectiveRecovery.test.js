import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { BSON, MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server";
import { parseRecoveryArguments } from "./scripts/brandiraqSelectiveRecovery.js";
import {
  BRANDIRAQ_BACKUP_BSON,
  BRANDIRAQ_EXPECTED_DETAILS,
  BRANDIRAQ_EXPECTED_IDS,
  BRANDIRAQ_PRODUCTS_AFTER,
  BRANDIRAQ_PRODUCTS_BEFORE,
  BRANDIRAQ_RECOVERY_AUTHORIZATION,
  BRANDIRAQ_RECOVERY_COUNT,
  BRANDIRAQ_VENDOR_AFTER,
  BRANDIRAQ_VENDOR_BEFORE,
  productionInputsAllowed,
  reportPathAllowed,
  runBrandiraqSelectiveRecovery,
  sameProductDocument,
  selectBsonDocuments,
} from "./utils/brandiraqSelectiveRecovery.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function recoveryFixture() {
  const docs = Array.from({ length: BRANDIRAQ_RECOVERY_COUNT }, (_, index) => ({
    _id: new ObjectId(index.toString(16).padStart(24, "0")),
    ibsherId: (index + 1).toString(16).padStart(24, "0"),
    itemCode: `KHC-${index}`,
    name: { en: `Brandiraq ${index}` },
    createdBy: { _id: "brandiraq-vendor", name: "Brandiraq" },
    variants: [{ sku: `V-${index}`, stock: index }],
    images: [`https://cdn.example.test/${index}.jpg`],
    category: { _id: "cat-appliances", name: "Appliances" },
    categories: ["cat-appliances"],
    overrides: { price: 1000 + index, sku: `LOCAL-${index}` },
    price: 900 + index,
    status: "published",
    manualNote: `keep-${index}`,
  }));
  const documents = docs.map((doc) => {
    const raw = BSON.serialize(doc);
    return { doc, raw, sha256: crypto.createHash("sha256").update(raw).digest("hex") };
  });
  return {
    docs,
    documents,
    idText: docs.map((doc) => String(doc._id)).join("\n"),
    detailsText: docs.map((doc) => JSON.stringify({
      id: String(doc._id),
      sourceItemId: doc.ibsherId,
      vendor: "Brandiraq",
      itemCode: doc.itemCode,
      status: "published",
      name: doc.name.en,
    })).join("\n"),
  };
}

function productionStore(seed = []) {
  const inserted = new Map(seed.map((doc) => [String(doc._id), doc]));
  const calls = { reads: 0, inserts: 0 };
  return {
    calls,
    inserted,
    backup(documents) {
      return {
        ok: true,
        unchanged: true,
        documents: documents.map(({ doc, sha256 }) => ({ doc, sha256 })),
      };
    },
    async readCatalog() {
      calls.reads += 1;
      const docs = [...inserted.values()];
      const recovered = docs.filter((doc) => doc.createdBy?.name === "Brandiraq" && doc.manualNote);
      return {
        total: BRANDIRAQ_PRODUCTS_BEFORE + recovered.length,
        brandiraq: BRANDIRAQ_VENDOR_BEFORE + recovered.length,
        byId: docs,
        bySource: docs,
        collectionCounts: {
          products: BRANDIRAQ_PRODUCTS_BEFORE + recovered.length,
          ginisyncjobs: 4,
          miswagsyncjobs: 2,
        },
      };
    },
    async insertOriginal(doc) {
      calls.inserts += 1;
      const id = String(doc._id);
      if (inserted.has(id)) {
        const error = new Error("duplicate key");
        error.code = 11000;
        throw error;
      }
      inserted.set(id, doc);
    },
  };
}

function executeInput(fixture, store, extra = {}) {
  return {
    mode: "execute",
    platform: "linux",
    authorization: BRANDIRAQ_RECOVERY_AUTHORIZATION,
    pausePresent: true,
    databaseName: "brownstore",
    idText: fixture.idText,
    detailsText: fixture.detailsText,
    backupDocuments: store.backup(fixture.documents),
    readCatalog: () => store.readCatalog(),
    insertOriginal: (doc) => store.insertOriginal(doc),
    recheckPause: async () => true,
    ...extra,
  };
}

test("the expected production totals and paths stay fixed", () => {
  assert.equal(BRANDIRAQ_PRODUCTS_BEFORE + BRANDIRAQ_RECOVERY_COUNT, BRANDIRAQ_PRODUCTS_AFTER);
  assert.equal(BRANDIRAQ_VENDOR_BEFORE + BRANDIRAQ_RECOVERY_COUNT, BRANDIRAQ_VENDOR_AFTER);
  assert.equal(BRANDIRAQ_PRODUCTS_AFTER, 43457);
  assert.equal(productionInputsAllowed({
    bsonPath: BRANDIRAQ_BACKUP_BSON,
    expectedIdsPath: BRANDIRAQ_EXPECTED_IDS,
    expectedDetailsPath: BRANDIRAQ_EXPECTED_DETAILS,
  }), true);
  assert.equal(productionInputsAllowed({
    bsonPath: `${BRANDIRAQ_BACKUP_BSON}.copy`,
    expectedIdsPath: BRANDIRAQ_EXPECTED_IDS,
    expectedDetailsPath: BRANDIRAQ_EXPECTED_DETAILS,
  }), false);
  assert.equal(reportPathAllowed("/root/brownstore-backups/brandiraq-27-dry-run-report.json"), true);
  assert.equal(reportPathAllowed(`${BRANDIRAQ_BACKUP_BSON.replace(/products\.bson$/, "report.json")}`), false);
  assert.equal(reportPathAllowed("/root/brownstore-backups/ownership-first-save-20261113T180302Z/report.json"), false);
});

test("the command defaults to dry-run and refuses a short or duplicate expected set", async () => {
  const fixture = recoveryFixture();
  const parsed = parseRecoveryArguments(["--confirm-production"]);
  assert.equal(parsed.mode, "dry_run");
  assert.equal(parsed.execute, false);
  const store = productionStore();
  const short = await runBrandiraqSelectiveRecovery({
    mode: "dry_run",
    pausePresent: true,
    databaseName: "brownstore",
    idText: fixture.docs.slice(0, 26).map((doc) => String(doc._id)).join("\n"),
    detailsText: fixture.detailsText.split("\n").slice(0, 26).join("\n"),
    loadBackup: async () => {
      throw new Error("backup should not be read");
    },
    readCatalog: () => store.readCatalog(),
    insertOriginal: (doc) => store.insertOriginal(doc),
  });
  assert.equal(short.stopReason, "expected_count");
  assert.equal(store.calls.reads, 0);
  assert.equal(store.calls.inserts, 0);

  const ids = fixture.docs.map((doc) => String(doc._id));
  ids[26] = ids[0];
  const duplicate = await runBrandiraqSelectiveRecovery({
    mode: "execute",
    platform: "linux",
    authorization: BRANDIRAQ_RECOVERY_AUTHORIZATION,
    pausePresent: true,
    databaseName: "brownstore",
    idText: ids.join("\n"),
    detailsText: fixture.detailsText,
    readCatalog: () => store.readCatalog(),
    insertOriginal: (doc) => store.insertOriginal(doc),
  });
  assert.equal(duplicate.stopReason, "duplicate_expected_original_id");
  assert.equal(store.calls.inserts, 0);
});

test("dry-run plans all 27 original documents and does not insert", async () => {
  const fixture = recoveryFixture();
  const store = productionStore();
  const report = await runBrandiraqSelectiveRecovery({
    ...executeInput(fixture, store),
    mode: "dry_run",
    authorization: BRANDIRAQ_RECOVERY_AUTHORIZATION,
  });
  assert.equal(report.ok, true);
  assert.equal(report.readyForAuthorizedInsert, true);
  assert.equal(report.writes, 0);
  assert.equal(report.inserted, 0);
  assert.equal(report.actions.length, 27);
  assert.equal(report.actions.every((row) => row.action === "would_insert"), true);
  assert.equal(report.actions[0].variantCount, 1);
  assert.equal(report.actions[0].imageCount, 1);
  assert.deepEqual(report.actions[0].overrideKeys, ["price", "sku"]);
  assert.equal(report.sentToGini, 0);
  assert.equal(report.syncStarted, false);
  assert.equal(report.pauseMarkerRemoved, false);
  assert.equal(store.calls.inserts, 0);
  JSON.stringify(report);
});

test("an insert requires linux, the pause marker, and the one-time authorization", async () => {
  const fixture = recoveryFixture();
  const store = productionStore();
  const denied = await runBrandiraqSelectiveRecovery(executeInput(fixture, store, { authorization: "no" }));
  const paused = await runBrandiraqSelectiveRecovery(executeInput(fixture, store, { pausePresent: false }));
  const desktop = await runBrandiraqSelectiveRecovery(executeInput(fixture, store, { platform: "win32" }));
  assert.equal(denied.stopReason, "authorization_required");
  assert.equal(paused.stopReason, "pause_marker_missing");
  assert.equal(desktop.stopReason, "desktop_execution_refused");
  assert.equal(store.calls.reads, 0);
  assert.equal(store.calls.inserts, 0);
});

test("a conflicting original id or source id stops the run before any insert", async () => {
  const fixture = recoveryFixture();
  const sourceConflict = productionStore([{
    _id: new ObjectId(),
    ibsherId: fixture.docs[3].ibsherId,
    createdBy: { name: "Brandiraq" },
    price: 1,
  }]);
  const sourceReport = await runBrandiraqSelectiveRecovery(executeInput(fixture, sourceConflict));
  assert.equal(sourceReport.stopReason, "source_id_conflict");
  assert.equal(sourceConflict.calls.inserts, 0);

  const idConflict = productionStore([{
    ...fixture.docs[4],
    ibsherId: "eeeeeeeeeeeeeeeeeeeeeeee",
  }]);
  const idReport = await runBrandiraqSelectiveRecovery(executeInput(fixture, idConflict));
  assert.equal(idReport.stopReason, "original_id_conflict");
  assert.equal(idConflict.calls.inserts, 0);

  const changed = productionStore([{ ...fixture.docs[5], price: 1 }]);
  const diffReport = await runBrandiraqSelectiveRecovery(executeInput(fixture, changed));
  assert.equal(diffReport.stopReason, "already_present_document_diff");
  assert.equal(changed.calls.inserts, 0);
  assert.equal(changed.inserted.get(String(fixture.docs[5]._id)).price, 1);
});

test("a disappearing pause marker stops a partial run and a later run finishes it", async () => {
  const fixture = recoveryFixture();
  const store = productionStore();
  let checks = 0;
  const partial = await runBrandiraqSelectiveRecovery(executeInput(fixture, store, {
    recheckPause: async () => {
      checks += 1;
      return checks === 1;
    },
  }));
  assert.equal(partial.inserted, 1);
  assert.equal(partial.stopped, true);
  assert.equal(partial.stopReason, "pause_marker_missing");
  assert.equal(partial.verified, false);
  assert.equal(partial.actions.length, 27);
  assert.equal(store.inserted.size, 1);

  const resumed = await runBrandiraqSelectiveRecovery(executeInput(fixture, store));
  assert.equal(resumed.ok, true);
  assert.equal(resumed.inserted, 26);
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.verified, true);
  assert.equal(resumed.verification.verifiedCount, 27);
  assert.equal(resumed.catalog.after, BRANDIRAQ_PRODUCTS_AFTER);
  assert.equal(resumed.catalog.brandiraqAfter, BRANDIRAQ_VENDOR_AFTER);
  assert.equal(resumed.verification.collectionChanges.length, 0);
  assert.equal(store.inserted.size, 27);
});

test("the BSON backup is read without modification and only the expected documents are selected", async () => {
  const fixture = recoveryFixture();
  const decoy = BSON.serialize({
    _id: new ObjectId("ffffffffffffffffffffffff"),
    ibsherId: "dddddddddddddddddddddddd",
    createdBy: { name: "Other" },
    price: 1,
  });
  const file = path.join(os.tmpdir(), `brandiraq-recovery-${Date.now()}.bson`);
  await fs.promises.writeFile(file, Buffer.concat([...fixture.documents.map((item) => item.raw), decoy]));
  const before = await fs.promises.stat(file);
  const selected = await selectBsonDocuments(file, fixture.docs.map((doc) => String(doc._id)));
  const after = await fs.promises.stat(file);
  assert.equal(selected.ok, true);
  assert.equal(selected.scanned, 28);
  assert.equal(selected.documents.length, 27);
  assert.equal(selected.unchanged, true);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(selected.documents.some((item) => String(item.doc._id) === "ffffffffffffffffffffffff"), false);
  await fs.promises.unlink(file);
});

test("a memory database receives the original documents once and leaves every other record unchanged", async () => {
  const fixture = recoveryFixture();
  const memory = await MongoMemoryServer.create();
  const client = new MongoClient(memory.getUri());
  await client.connect();
  try {
    const db = client.db("brownstore");
    const products = db.collection("products");
    const neighbor = {
      _id: new ObjectId("111111111111111111111111"),
      ibsherId: "222222222222222222222222",
      itemCode: "NEIGHBOR",
      createdBy: { name: "IT Lobby" },
      price: 55,
      variants: [{ sku: "keep" }],
    };
    await products.insertOne({ ...neighbor });
    await db.collection("marketplacecheck").insertOne({ name: "leave-me" });
    const catalog = {
      productsBefore: 1,
      productsAfter: 28,
      brandiraqBefore: 0,
      brandiraqAfter: 27,
      recoveryCount: 27,
    };
    const readCatalog = async () => {
      const objectIds = fixture.docs.map((doc) => doc._id);
      const sourceIds = fixture.docs.map((doc) => doc.ibsherId);
      const [total, brandiraq, byId, bySource, listed] = await Promise.all([
        products.countDocuments(),
        products.countDocuments({ "createdBy.name": "Brandiraq" }),
        products.find({ _id: { $in: objectIds } }).toArray(),
        products.find({ ibsherId: { $in: sourceIds } }).toArray(),
        db.listCollections({}, { nameOnly: true }).toArray(),
      ]);
      const collectionCounts = {};
      for (const item of listed) collectionCounts[item.name] = await db.collection(item.name).countDocuments();
      return { total, brandiraq, byId, bySource, collectionCounts };
    };
    const run = (extra = {}) => runBrandiraqSelectiveRecovery({
      ...executeInput(fixture, productionStore(), extra),
      catalog,
      readCatalog,
      insertOriginal: (doc) => products.insertOne(doc, { writeConcern: { w: "majority" } }),
    });
    const first = await run();
    assert.equal(first.ok, true);
    assert.equal(first.inserted, 27);
    assert.equal(await products.countDocuments(), 28);
    assert.equal(await products.countDocuments({ "createdBy.name": "Brandiraq" }), 27);
    const stored = await products.findOne({ _id: fixture.docs[8]._id });
    assert.equal(sameProductDocument(stored, fixture.docs[8]), true);
    assert.equal(stored.manualNote, "keep-8");
    assert.equal(stored.images[0], "https://cdn.example.test/8.jpg");
    assert.equal(stored.overrides.sku, "LOCAL-8");
    assert.equal(stored.variants[0].sku, "V-8");
    assert.equal(stored.createdBy.name, "Brandiraq");
    const kept = await products.findOne({ _id: neighbor._id });
    assert.equal(sameProductDocument(kept, neighbor), true);
    assert.equal(await db.collection("marketplacecheck").countDocuments(), 1);

    const second = await run();
    assert.equal(second.ok, true);
    assert.equal(second.inserted, 0);
    assert.equal(second.skipped, 27);
    assert.equal(second.verification.verifiedCount, 27);
    assert.equal(await products.countDocuments(), 28);

    await products.updateOne({ _id: fixture.docs[0]._id }, { $set: { price: 1 } });
    const refused = await run();
    assert.equal(refused.stopReason, "already_present_document_diff");
    assert.equal(refused.inserted, 0);
    assert.equal((await products.findOne({ _id: fixture.docs[0]._id })).price, 1);
  } finally {
    await client.close();
    await memory.stop();
  }
});

test("the recovery command and its library do not update, delete, or unpause", () => {
  const util = fs.readFileSync(path.join(serverDir, "src/utils/brandiraqSelectiveRecovery.js"), "utf8");
  const script = fs.readFileSync(path.join(serverDir, "src/scripts/brandiraqSelectiveRecovery.js"), "utf8");
  for (const word of ["updateOne", "updateMany", "replaceOne", "deleteMany", "deleteOne", "bulkWrite", "findOneAndUpdate", "unlink", "rmSync", "startIbsherAutoSync"]) {
    assert.equal(util.includes(word), false, word);
    assert.equal(script.includes(word), false, word);
  }
  assert.match(script, /insertOne/);
  assert.match(util, /O_RDONLY/);
  const result = spawnSync(process.execPath, ["src/scripts/brandiraqSelectiveRecovery.js", "--execute"], {
    cwd: serverDir,
    encoding: "utf8",
  });
  assert.equal(result.status, 4);
  assert.match(result.stderr, /Refusing to connect/);
});
