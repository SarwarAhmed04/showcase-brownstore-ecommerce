import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  assessAttemptCollection,
  attemptSummaryPipeline,
  indexCreationProcedure,
  matchingUniqueAttemptIndex,
  readAttemptSummary,
  refuseIndexWriteFlags,
} from "./utils/giniSkuCreateIndexes.js";

const REQUIRED_INDEXES = [
  { key: { skuKey: 1 }, unique: true, name: "skuKey_1" },
  { key: { productId: 1 }, unique: true, name: "productId_1" },
];

describe("GINI SKU create index preflight", { concurrency: 1 }, () => {
  it("does not connect or write when the checker is loaded", () => {
    assert.equal(mongoose.connection.readyState, 0);
    const source = fs.readFileSync(new URL("./scripts/giniSkuCreateIndexPreflight.js", import.meta.url), "utf8");
    const pipeline = JSON.stringify(attemptSummaryPipeline());
    assert.equal(source.includes("insertOne"), false);
    assert.equal(source.includes("insertMany"), false);
    assert.equal(source.includes("updateOne"), false);
    assert.equal(source.includes("deleteOne"), false);
    assert.equal(source.includes("bulkWrite"), false);
    assert.equal(source.includes("syncIndexes"), false);
    assert.equal(source.includes("createIndex("), false);
    assert.equal(source.includes('mongoose.set("autoIndex", false)'), true);
    assert.equal(source.includes('mongoose.set("autoCreate", false)'), true);
    assert.equal(source.includes("--confirm-production"), true);
    assert.equal(source.includes("--allow-verified-production-loopback"), true);
    assert.equal(pipeline.includes('"$out"'), false);
    assert.equal(pipeline.includes('"$merge"'), false);
    assert.equal(refuseIndexWriteFlags(["--confirm-production", "--allow-verified-production-loopback"]).length, 0);
    assert.deepEqual(refuseIndexWriteFlags(["--create-indexes"]), ["--create-indexes"]);
  });

  it("accepts only the required non-sparse unique indexes", () => {
    const ready = assessAttemptCollection({ collectionName: "giniskucreateattempts", indexes: REQUIRED_INDEXES, documentCount: 0 });
    assert.equal(ready.collectionExists, true);
    assert.equal(ready.indexesEnforced, true);
    assert.equal(ready.schemaMatches, true);
    assert.equal(ready.readyForSkuCreateLock, true);
    assert.equal(matchingUniqueAttemptIndex([{ key: { skuKey: 1 }, unique: true, sparse: true }], "skuKey"), null);
    assert.equal(matchingUniqueAttemptIndex([{ key: { skuKey: 1, productId: 1 }, unique: true }], "skuKey"), null);
    const sparse = assessAttemptCollection({
      collectionName: "giniskucreateattempts",
      indexes: [
        { key: { skuKey: 1 }, unique: true, sparse: true, name: "skuKey_1" },
        { key: { productId: 1 }, unique: true, name: "productId_1" },
      ],
    });
    assert.equal(sparse.indexesEnforced, false);
    assert.equal(sparse.skuKey.enforced, false);
    assert.equal(sparse.skuKey.observed[0].sparse, true);
  });

  it("withholds index commands when duplicate values would reject them", () => {
    const missing = assessAttemptCollection();
    assert.equal(missing.collectionExists, false);
    assert.equal(missing.indexesEnforced, false);
    assert.equal(missing.duplicatesWouldPreventIndexCreation, false);
    const missingProcedure = indexCreationProcedure({ dataWouldAcceptIndexes: true });
    assert.equal(missingProcedure.automatic, false);
    assert.equal(missingProcedure.runFromThisScript, false);
    assert.equal(missingProcedure.commands.length, 2);
    assert.match(missingProcedure.commands[0], /skuKey/);
    assert.match(missingProcedure.commands[1], /productId/);

    const blocked = assessAttemptCollection({
      collectionName: "giniskucreateattempts",
      indexes: [],
      duplicateSkuKeys: [{ value: "HB-632", count: 2 }],
      duplicateProductIds: [],
    });
    assert.equal(blocked.duplicatesWouldPreventIndexCreation, true);
    const withheld = indexCreationProcedure({ dataWouldAcceptIndexes: false });
    assert.deepEqual(withheld.commands, []);
    assert.equal(withheld.automatic, false);
    assert.match(withheld.operatorSteps[0], /Do not create/);
  });

  it("counts duplicate keys and schema mismatches without a write stage", async () => {
    const memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("gini-index-preflight"));
    mongoose.set("autoIndex", false);
    mongoose.set("autoCreate", false);
    try {
      const collection = mongoose.connection.db.collection("giniskucreateattempts");
      await collection.insertMany([
        { skuKey: "same", productId: "p-1", sku: "SAME", status: "confirmed" },
        { skuKey: "same", productId: "p-2", sku: "SAME", status: "confirmed" },
        { skuKey: "other", productId: "p-1", sku: "OTHER", status: "not-a-status" },
      ]);
      const [row] = await collection.aggregate(attemptSummaryPipeline()).toArray();
      const summary = readAttemptSummary(row);
      assert.equal(summary.documentCount, 3);
      assert.equal(summary.duplicateSkuKeys.length, 1);
      assert.equal(summary.duplicateSkuKeys[0].value, "same");
      assert.equal(summary.duplicateSkuKeys[0].count, 2);
      assert.equal(summary.duplicateProductIds.length, 1);
      assert.equal(summary.duplicateProductIds[0].value, "p-1");
      assert.equal(summary.invalidStatus, 1);
      const assessed = assessAttemptCollection({ collectionName: "giniskucreateattempts", indexes: [], ...summary });
      assert.equal(assessed.duplicatesWouldPreventIndexCreation, true);
      assert.equal(assessed.schemaMatches, false);
      assert.equal(indexCreationProcedure({ dataWouldAcceptIndexes: false }).commands.length, 0);

      await collection.deleteMany({});
      await collection.createIndex({ skuKey: 1 }, { unique: true, name: "skuKey_1" });
      await collection.createIndex({ productId: 1 }, { unique: true, name: "productId_1" });
      const indexes = await collection.indexes();
      const enforced = assessAttemptCollection({
        collectionName: "giniskucreateattempts",
        indexes,
        ...readAttemptSummary((await collection.aggregate(attemptSummaryPipeline()).toArray())[0]),
      });
      assert.equal(enforced.indexesEnforced, true);
      assert.equal(enforced.readyForSkuCreateLock, true);
      await collection.insertOne({ skuKey: "only", productId: "p-9", sku: "ONLY", status: "in_progress" });
      await assert.rejects(
        () => collection.insertOne({ skuKey: "only", productId: "p-10", sku: "ONLY", status: "uncertain" }),
        (err) => err?.code === 11000
      );
      await assert.rejects(
        () => collection.insertOne({ skuKey: "different", productId: "p-9", sku: "DIFFERENT", status: "confirmed" }),
        (err) => err?.code === 11000
      );
    } finally {
      await mongoose.disconnect();
      await memory.stop();
    }
  });

  it("refuses to run without --confirm-production", async () => {
    const script = fileURLToPath(new URL("./scripts/giniSkuCreateIndexPreflight.js", import.meta.url));
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script], {
        cwd: path.resolve(path.dirname(script), "..", ".."),
        env: process.env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("index preflight process timed out"));
      }, 20000);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-production/);
  });
});

after(() => {
  assert.equal(mongoose.connection.readyState, 0);
});
