import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assessResyncIndexes, resyncIndexCreationProcedure } from "./utils/giniResyncIndexes.js";

const SCRIPT = fileURLToPath(new URL("./scripts/giniResyncIndexPreflight.js", import.meta.url));

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: path.resolve(path.dirname(SCRIPT), "..", ".."),
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("re-sync index preflight timed out"));
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
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("GINI re-sync index preflight", () => {
  it("describes the indexes and withholds the commands from the running process", () => {
    const missing = assessResyncIndexes();
    assert.equal(missing.readyForResyncIndexes, false);
    const procedure = resyncIndexCreationProcedure({ ready: false });
    assert.equal(procedure.automatic, false);
    assert.equal(procedure.runFromThisScript, false);
    assert.equal(procedure.commands.length, 5);
    assert.equal(procedure.commands.some((command) => command.includes("giniresynclocks") && command.includes("unique: true")), true);
    const present = assessResyncIndexes({
      lockExists: true,
      lockIndexes: [{ name: "skuKey_1", key: { skuKey: 1 }, unique: true }],
      auditExists: true,
      auditIndexes: [{ name: "skuKey_1_createdAt_-1", key: { skuKey: 1, createdAt: -1 } }],
      jobExists: true,
      jobIndexes: [
        { name: "partner_1", key: { partner: 1 } },
        { name: "status_1", key: { status: 1 } },
      ],
      previewExists: true,
      previewIndexes: [{ name: "partner_1", key: { partner: 1 } }],
    });
    assert.equal(present.readyForResyncIndexes, true);
    assert.deepEqual(resyncIndexCreationProcedure({ ready: true }).commands, []);
    const source = fs.readFileSync(SCRIPT, "utf8");
    assert.equal(source.includes('mongoose.set("autoIndex", false)'), true);
    assert.equal(source.includes('mongoose.set("autoCreate", false)'), true);
    assert.equal(source.includes(".createIndex("), false);
    assert.equal(source.includes("createCollection("), false);
    assert.equal(source.includes("performGiniRequest"), false);
  });

  it("refuses to connect without production confirmation", async () => {
    const result = await runScript([]);
    assert.equal(result.code, 4);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--confirm-production/);
  });

  it("refuses an index-writing flag before opening the database", async () => {
    const result = await runScript(["--confirm-production", "--create-indexes"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot create indexes/);
  });
});
