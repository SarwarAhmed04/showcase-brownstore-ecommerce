import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ObjectId } from "mongodb";
import test from "node:test";
import { giniConnectionRouter } from "./routes/giniConnection.js";
import { commitOwnershipSave, OWNERSHIP_COMMIT_TEST } from "./services/giniVariantOwnershipSelection.js";
import { OWNERSHIP_PRODUCTION_PREVIEW, clearOwnershipAuthorizations } from "./utils/giniOwnershipProductionContext.js";
import {
  CLOSED_LOCK_LINES,
  OPEN_LOCK_LINES,
  acceptFirstLivePreview,
  assessFirstLivePreflight,
  decideSingleUse,
  describeFirstLiveOwnershipSaveAuthorization,
  evidenceScriptIsReadOnly,
  firstLiveInsertAllowed,
  firstLivePairDecision,
  firstLiveSaveBody,
  hostingerOpenSourceProgram,
  hostingerReadOnlyEvidenceScript,
  planEmergencyStop,
  planHostingerFirstLive,
  rewriteOwnershipSourceLocks,
  verifyFirstLiveEvidence,
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
  assert.equal(procedure.forbidden.includes("sed"), true);
  assert.equal(procedure.forbidden.includes("source_backup_file"), true);
  assert.equal(procedure.rollback.executed, false);
  assert.equal(procedure.rollback.method, "git-restore-recorded-sha");
  assert.equal(procedure.rollback.createsBackupFile, false);
  assert.equal(procedure.rollback.usesSed, false);
  assert.equal(procedure.open.steps.join("\n").includes("sed -"), false);
  assert.equal(procedure.close.steps.some((step) => step.includes("git restore --source")), true);
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

const CLOSED_SHA = "2cc9810d627170a4e2567d578ddee0f42cfbf522";

function readyObservation(extra = {}) {
  return {
    gitSha: CLOSED_SHA,
    branch: "main",
    porcelain: "",
    auditMatchesHead: true,
    releasedLine: CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED,
    indexesLine: CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY,
    envEnabled: "",
    envAllow: "",
    databaseName: "brownstore",
    mongoHost: "127.0.0.1",
    ownerCount: 0,
    operationCount: 0,
    conflicts: 0,
    liveIndexesReady: true,
    backupCompleted: true,
    singleApiProcess: true,
    itLobbyUpdatedAt: "2026-11-13T12:00:00.000Z",
    jawalUpdatedAt: "2026-11-13T12:00:01.000Z",
    itLobbyProductId: IT,
    itLobbySourceItemId: IT_SOURCE,
    itLobbyVendor: "IT Lobby",
    jawalProductId: JAWAL,
    jawalSourceItemId: JAWAL_SOURCE,
    jawalPresent: true,
    inFlight: false,
    ...extra,
  };
}

function acceptedPreview() {
  return {
    code: "selection_prepared_not_saved",
    saved: false,
    sentToGini: 0,
    productionReview: { verified: true, liveIndexesReady: true },
    selected: {
      vendor: "IT Lobby",
      vendorId: "it-lobby",
      productId: IT,
      sourceItemId: IT_SOURCE,
    },
    authorizationSnapshot: {
      id: "snapshot-1",
      administratorId: "admin-1",
      productId: IT,
      sourceItemId: IT_SOURCE,
      vendorId: "it-lobby",
    },
    excluded: [{
      productId: JAWAL,
      vendor: "Jawal Flex",
      sourceItemId: JAWAL_SOURCE,
      deletedFromBrownStore: false,
    }],
  };
}

test("the Hostinger plan stays unexecuted until preflight matches the closed production baseline", () => {
  const plan = planHostingerFirstLive(readyObservation());
  assert.equal(plan.phase, "planned_not_started");
  assert.equal(plan.execute, false);
  assert.equal(plan.authorizedToRunNow, false);
  assert.equal(plan.writesPermitted, false);
  assert.equal(plan.recordedSha, CLOSED_SHA);
  assert.equal(plan.editMethod, "exact-line-replace");
  assert.equal(plan.rollbackMethod, "git-restore-recorded-sha");
  assert.equal(plan.singleUse, true);
  assert.deepEqual(plan.forbiddenMethods, ["sed", "source-backup-file", ".bak"]);
  assert.equal(plan.openProgram.includes("sed"), false);
  assert.equal(plan.openProgram.includes(".bak"), false);
  assert.equal(plan.rollback.command, `git restore --source=${CLOSED_SHA} -- server/src/utils/giniVariantOwnershipAudit.js`);
  assert.equal(plan.rollback.createsBackupFile, false);
  assert.equal(plan.emergencyStop.usesSed, false);
  assert.equal(plan.previewBody.productId, IT);
  assert.equal(plan.previewBody.confirm, true);
  const dirty = planHostingerFirstLive(readyObservation({ porcelain: " M server/src/utils/giniVariantOwnershipAudit.js" }));
  assert.equal(dirty.phase, "refused");
  assert.equal(dirty.openProgram, "");
  assert.equal(dirty.execute, false);
  assert.equal(dirty.failures.includes("working_tree_dirty"), true);
  const openGate = planHostingerFirstLive(readyObservation({ envAllow: "true" }));
  assert.equal(openGate.failures.includes("allow_gate_open"), true);
  const busy = planHostingerFirstLive(readyObservation({ inFlight: true }));
  assert.equal(busy.failures.includes("concurrent_request_refused"), true);
  const owned = planHostingerFirstLive(readyObservation({ ownerCount: 1 }));
  assert.equal(owned.failures.includes("owner_count"), true);
});

test("preview acceptance builds one save body and drops every other candidate", () => {
  const preview = acceptedPreview();
  assert.equal(acceptFirstLivePreview(preview), "");
  const body = firstLiveSaveBody(preview);
  assert.deepEqual(body, {
    parentSku: "38104",
    productId: IT,
    vendorId: "it-lobby",
    sourceItemId: IT_SOURCE,
    snapshotId: "snapshot-1",
    confirm: true,
    confirmOwnershipSave: true,
  });
  assert.equal(Object.hasOwn(body, "administratorId"), false);
  assert.equal(firstLiveSaveBody({ ...preview, selected: { ...preview.selected, vendor: "Jawal Flex" } }), null);
  assert.equal(acceptFirstLivePreview({ ...preview, sentToGini: 1 }), "gini_send");
  assert.deepEqual(decideSingleUse({ inFlight: true }), { ok: false, code: "concurrent_request_refused" });
  assert.equal(decideSingleUse({ consumed: true }).code, "run_already_used");
  assert.equal(decideSingleUse({ operationCount: 1 }).code, "conflicting_owner");
  assert.equal(decideSingleUse({ ownerCount: 0, operationCount: 0 }).ok, true);
});

test("verification requires one approved owner, one journal, unchanged products, and sentToGini 0", () => {
  const before = { itLobbyUpdatedAt: "2026-11-13T12:00:00.000Z", jawalUpdatedAt: "2026-11-13T12:00:01.000Z" };
  const after = {
    ownerCount: 1,
    operationCount: 1,
    owner: { productId: IT, parentSku: "38104", status: "approved", giniProductId: "" },
    operation: { productId: IT, sourceItemId: IT_SOURCE, status: "recorded", excludedProductIds: [JAWAL] },
    jawalPresent: true,
    jawalSourceItemId: JAWAL_SOURCE,
    jawalVendor: "Jawal Flex",
    itLobbyUpdatedAt: before.itLobbyUpdatedAt,
    jawalUpdatedAt: before.jawalUpdatedAt,
    otherSkuOwnerDelta: 0,
    otherSkuOperationDelta: 0,
    gatesClosed: true,
    disabledSave: { code: "ownership_save_disabled", sentToGini: 0 },
  };
  const response = {
    saved: true,
    code: "ownership_recorded",
    sentToGini: 0,
    canSend: false,
    approvesVariantSkus: false,
    mergesStock: false,
    publishesToGini: false,
  };
  assert.equal(verifyFirstLiveEvidence(before, after, response).ok, true);
  assert.equal(verifyFirstLiveEvidence(before, after, { ...response, sentToGini: 1 }).failures.includes("sent_to_gini"), true);
  assert.equal(verifyFirstLiveEvidence(before, { ...after, jawalUpdatedAt: "2026-11-13T12:00:02.000Z" }, response).failures.includes("jawal_updated_at"), true);
  assert.equal(verifyFirstLiveEvidence(before, { ...after, itLobbyUpdatedAt: "2026-11-13T12:00:02.000Z" }, response).failures.includes("it_lobby_updated_at"), true);
  assert.equal(verifyFirstLiveEvidence(before, { ...after, gatesClosed: false }, response).failures.includes("gates_open"), true);
  assert.equal(verifyFirstLiveEvidence(before, { ...after, ownerCount: 2 }, response).failures.includes("owner_count"), true);
  const script = hostingerReadOnlyEvidenceScript();
  assert.equal(evidenceScriptIsReadOnly(script), true);
  assert.equal(script.includes(IT), true);
  assert.equal(script.includes(JAWAL), true);
  assert.equal(evidenceScriptIsReadOnly(`${script}\ndb.products.updateOne({}, {})`), false);
});

test("exact line replacement round-trips the audit file and refuses a damaged source line", () => {
  const auditUrl = new URL("./utils/giniVariantOwnershipAudit.js", import.meta.url);
  const original = fs.readFileSync(auditUrl, "utf8");
  const opened = rewriteOwnershipSourceLocks(original, "open");
  assert.equal(opened.ok, true);
  assert.equal(opened.text.includes(OPEN_LOCK_LINES.OWNERSHIP_SAVE_RELEASED), true);
  assert.equal(opened.text.includes(OPEN_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY), true);
  assert.equal(opened.text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED), false);
  const closed = rewriteOwnershipSourceLocks(opened.text, "close");
  assert.equal(closed.ok, true);
  assert.equal(closed.text, original);
  assert.equal(fs.readFileSync(auditUrl, "utf8"), original);
  assert.equal(rewriteOwnershipSourceLocks(original.replace(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED, `${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED} // touched`), "open").code, "source_lock_not_exact");
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
});

test("git restore of the recorded closed commit rolls back an open edit and a later commit without a backup file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ownership-rollback-"));
  const relative = "server/src/utils/giniVariantOwnershipAudit.js";
  const file = path.join(root, relative);
  const git = (args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
  try {
    git(["init", "--quiet"]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = `${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\n`;
    fs.writeFileSync(file, original);
    git(["add", "--", relative]);
    git(["-c", "user.email=procedure@brownstore.test", "-c", "user.name=procedure", "commit", "-m", "closed", "--quiet"]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    const opened = rewriteOwnershipSourceLocks(fs.readFileSync(file, "utf8"), "open");
    fs.writeFileSync(file, opened.text);
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.includes(".bak") || name.includes("backup")), false);
    git(["restore", `--source=${sha}`, "--", relative]);
    assert.equal(fs.readFileSync(file, "utf8"), original);

    fs.writeFileSync(file, opened.text);
    git(["add", "--", relative]);
    git(["-c", "user.email=procedure@brownstore.test", "-c", "user.name=procedure", "commit", "-m", "opened by mistake", "--quiet"]);
    assert.notEqual(git(["rev-parse", "HEAD"]).trim(), sha);
    const stop = planEmergencyStop({
      recordedSha: sha,
      releasedLine: OPEN_LOCK_LINES.OWNERSHIP_SAVE_RELEASED,
      indexesLine: OPEN_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY,
    });
    assert.equal(stop.restore, true);
    assert.equal(stop.createsBackupFile, false);
    assert.equal(stop.command, `git restore --source=${sha} -- server/src/utils/giniVariantOwnershipAudit.js`);
    git(["restore", `--source=${sha}`, "--", relative]);
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.equal(fs.existsSync(`${file}.bak`), false);
    assert.equal(planEmergencyStop({ recordedSha: "missing" }).code, "recorded_sha_mismatch");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the Hostinger open program writes only the two lock lines and creates no backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ownership-open-"));
  const relative = "server/src/utils/giniVariantOwnershipAudit.js";
  const file = path.join(root, relative);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const original = `before\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\nmiddle\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\nafter\n`;
    fs.writeFileSync(file, original);
    const program = hostingerOpenSourceProgram();
    assert.equal(program.includes("sed"), false);
    assert.equal(program.includes(".bak"), false);
    execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root, encoding: "utf8" });
    const written = fs.readFileSync(file, "utf8");
    assert.equal(written, `before\n${OPEN_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\nmiddle\n${OPEN_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\nafter\n`);
    assert.equal(fs.readdirSync(path.dirname(file)).filter((name) => name !== "giniVariantOwnershipAudit.js").length, 0);
    assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", program], { cwd: root, encoding: "utf8", stdio: "pipe" }));
    assert.equal(fs.readFileSync(file, "utf8"), written);
    assert.equal(assessFirstLivePreflight(readyObservation()).authorizedToRunNow, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
