import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const FIXTURE = "OWNERSHIP_HTTP_LOCK_FIXTURE";
const AUDIT_FILE = fileURLToPath(new URL("./utils/giniVariantOwnershipAudit.js", import.meta.url));
const CLOSED_RELEASED = "export const OWNERSHIP_SAVE_RELEASED = false;";
const CLOSED_INDEXES = "export const OWNERSHIP_SAVE_INDEXES_READY = false;";

if (process.env[FIXTURE] !== "1") {
  test("HTTP review and save run with fixture locks in an isolated process", async () => {
    const before = fs.readFileSync(AUDIT_FILE, "utf8");
    const env = { ...process.env, [FIXTURE]: "1" };
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_TEST") || key.startsWith("NODE_CHANNEL")) delete env[key];
    }
    const child = spawn(process.execPath, [
      "--import",
      pathToFileURL(fileURLToPath(new URL("./giniOwnershipHttpSave.register.mjs", import.meta.url))).href,
      "--test",
      fileURLToPath(import.meta.url),
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env,
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(exitCode, 0, output);
    assert.equal(fs.readFileSync(AUDIT_FILE, "utf8"), before);
    assert.equal(before.includes(CLOSED_RELEASED), true);
    assert.equal(before.includes(CLOSED_INDEXES), true);
  });
} else {
  const express = (await import("express")).default;
  const mongoose = (await import("mongoose")).default;
  const { MongoMemoryServer } = await import("mongodb-memory-server");
  const { ObjectId } = await import("mongodb");
  const { giniConnectionRouter } = await import("./routes/giniConnection.js");
  const { armOwnershipWindow, resetOwnershipWindowForTests } = await import("./utils/giniOwnershipAuthorizationWindow.js");
  const { CLOSED_LOCK_LINES } = await import("./utils/giniOwnershipFirstSaveProcedure.js");
  const { OWNERSHIP_PRODUCTION_PREVIEW, clearOwnershipAuthorizations } = await import("./utils/giniOwnershipProductionContext.js");
  const { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_RELEASED } = await import("./utils/giniVariantOwnershipAudit.js");

  const IT = "6adf9ca49dedbaa3dd573cce";
  const JAWAL = "6ae08bbd9dedbaa3dd5740d9";
  const IT_SOURCE = "6adf9824ef43bcf3ec7d1ee4";
  const JAWAL_SOURCE = "6adf9cf4ef43bcf3ec7daac1";
  const ADMIN = "admin-1";

  function tempClosedRepo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ownership-http-"));
    const relative = "server/src/utils/giniVariantOwnershipAudit.js";
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\n`);
    const git = (args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd: root, encoding: "utf8" });
    git(["init", "--quiet"]);
    git(["add", "--", relative]);
    git(["-c", "user.email=http-save@brownstore.test", "-c", "user.name=http-save", "commit", "-m", "closed", "--quiet"]);
    return { root, sha: git(["rev-parse", "HEAD"]).trim() };
  }

  async function seed(db) {
    await db.dropDatabase();
    clearOwnershipAuthorizations();
    await db.collection("giniconnections").insertOne({ baseUrl: "https://merchant.gini.iq/api", clientId: "142300002bee" });
    await db.collection("ginisyncjobs").insertOne({ mode: "preview", ...OWNERSHIP_PRODUCTION_PREVIEW, createdAt: new Date() });
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
    await db.collection("ginivariantownershipoperations").createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
  }

  async function post(server, route, body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  test("Review then Save for IT Lobby 38104 uses the process gates and records one owner", async () => {
    assert.equal(OWNERSHIP_SAVE_RELEASED, true);
    assert.equal(OWNERSHIP_SAVE_INDEXES_READY, true);
    assert.equal(fs.readFileSync(AUDIT_FILE, "utf8").includes(CLOSED_RELEASED), true);
    assert.equal(fs.readFileSync(AUDIT_FILE, "utf8").includes(CLOSED_INDEXES), true);
    const previousEnabled = process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED;
    const previousAllow = process.env.GINI_ALLOW_OWNERSHIP_SAVE;
    process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = "true";
    process.env.GINI_ALLOW_OWNERSHIP_SAVE = "true";
    const repo = tempClosedRepo();
    const memory = await MongoMemoryServer.create();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { _id: ADMIN };
      next();
    });
    app.use(giniConnectionRouter);
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    try {
      const armed = armOwnershipWindow({
        repoRoot: repo.root,
        sha: repo.sha,
        env: process.env,
        supervise: false,
      });
      assert.equal(armed.armed, true);
      assert.equal(armed.code, "window_armed");
      await mongoose.connect(memory.getUri(), { dbName: "brownstore" });
      const db = mongoose.connection.db;
      await seed(db);
      const review = await post(server, "/platforms/gini/variant-sync/ownership/preview", {
        parentSku: "38104",
        productId: IT,
        confirm: true,
      });
      assert.equal(review.status, 200);
      assert.equal(review.body.code, "selection_prepared_not_saved");
      assert.equal(review.body.savePreview.pilot.authorized, true);
      assert.equal(review.body.selected.vendor, "IT Lobby");
      assert.equal(review.body.selected.productId, IT);
      assert.equal(review.body.selected.sourceItemId, IT_SOURCE);
      assert.equal(review.body.excluded[0].productId, JAWAL);
      assert.equal(review.body.excluded[0].vendor, "Jawal Flex");
      assert.equal(review.body.saved, false);
      assert.equal(review.body.sentToGini, 0);
      assert.equal(review.body.saveAvailable, true);

      const save = await post(server, "/platforms/gini/variant-sync/ownership/save", {
        parentSku: "38104",
        productId: review.body.selected.productId,
        vendorId: review.body.selected.vendorId,
        sourceItemId: review.body.selected.sourceItemId,
        snapshotId: review.body.authorizationSnapshot.id,
        confirm: true,
        confirmOwnershipSave: true,
      });
      assert.equal(save.status, 200);
      assert.equal(save.body.code, "ownership_recorded");
      assert.equal(save.body.saved, true);
      assert.equal(save.body.ok, true);
      assert.equal(save.body.sentToGini, 0);
      assert.equal(save.body.canSend, false);
      assert.equal(save.body.databaseRechecked, true);
      assert.equal(save.body.windowClosed, true);
      assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);
      assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 1);
      const owner = await db.collection("ginivariantparentowners").findOne({});
      const operation = await db.collection("ginivariantownershipoperations").findOne({});
      assert.equal(owner.productId, IT);
      assert.equal(owner.vendorId, review.body.selected.vendorId);
      assert.equal(owner.status, "approved");
      assert.equal(owner.giniProductId, "");
      assert.equal(operation.productId, IT);
      assert.equal(operation.sourceItemId, IT_SOURCE);
      assert.equal(operation.status, "recorded");
      assert.deepEqual(operation.excludedProductIds, [JAWAL]);
      const jawal = await db.collection("products").findOne({ _id: new ObjectId(JAWAL) });
      assert.equal(jawal.ibsherId, JAWAL_SOURCE);
      assert.equal(jawal.createdBy.name, "Jawal Flex");

      const repeat = await post(server, "/platforms/gini/variant-sync/ownership/save", {
        parentSku: "38104",
        productId: IT,
        vendorId: review.body.selected.vendorId,
        sourceItemId: IT_SOURCE,
        snapshotId: review.body.authorizationSnapshot.id,
        confirm: true,
        confirmOwnershipSave: true,
      });
      assert.equal(repeat.status, 409);
      assert.equal(await db.collection("ginivariantparentowners").countDocuments(), 1);
      assert.equal(await db.collection("ginivariantownershipoperations").countDocuments(), 1);
      assert.equal(fs.readFileSync(AUDIT_FILE, "utf8").includes(CLOSED_RELEASED), true);
      assert.equal(fs.readFileSync(AUDIT_FILE, "utf8").includes(CLOSED_INDEXES), true);
    } finally {
      if (previousEnabled === undefined) delete process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED;
      else process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = previousEnabled;
      if (previousAllow === undefined) delete process.env.GINI_ALLOW_OWNERSHIP_SAVE;
      else process.env.GINI_ALLOW_OWNERSHIP_SAVE = previousAllow;
      resetOwnershipWindowForTests();
      clearOwnershipAuthorizations();
      await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
      await memory.stop();
      fs.rmSync(repo.root, { recursive: true, force: true });
    }
  });
}
