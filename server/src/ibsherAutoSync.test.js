import fs from "fs";
import assert from "node:assert/strict";
import test from "node:test";
import { IBSHER_AUTO_SYNC_INTERVAL_MS, ibsherAutoSyncEnabled, startIbsherAutoSync } from "./utils/ibsherAutoSync.js";

function harness(env) {
  const calls = [];
  const timers = [];
  const result = startIbsherAutoSync({
    env,
    sync: () => {
      calls.push("sync");
      return Promise.resolve({ skipped: true });
    },
    setTimer: (fn, interval) => {
      timers.push({ fn, interval });
      return { fake: true };
    },
  });
  return { result, calls, timers };
}

test("development does not import or start a timer unless opted in", () => {
  for (const env of [
    { NODE_ENV: "development" },
    { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "false" },
    { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "TRUE" },
    {},
  ]) {
    const run = harness(env);
    assert.equal(ibsherAutoSyncEnabled(env), false);
    assert.equal(run.result.enabled, false);
    assert.equal(run.result.timer, null);
    assert.deepEqual(run.calls, []);
    assert.deepEqual(run.timers, []);
  }
});

test("development runs automatic sync only when the opt-in is exactly true", () => {
  const env = { NODE_ENV: "development", IBSHER_AUTO_SYNC_ENABLED: "true" };
  const run = harness(env);
  assert.equal(ibsherAutoSyncEnabled(env), true);
  assert.equal(run.result.enabled, true);
  assert.deepEqual(run.calls, ["sync"]);
  assert.equal(run.timers.length, 1);
  assert.equal(run.timers[0].interval, IBSHER_AUTO_SYNC_INTERVAL_MS);
});

test("production keeps automatic sync and ignores the development opt-in", () => {
  for (const env of [
    { NODE_ENV: "production" },
    { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" },
    { NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "" },
  ]) {
    const run = harness(env);
    assert.equal(ibsherAutoSyncEnabled(env), true);
    assert.equal(run.calls.length, 1);
    assert.equal(run.timers.length, 1);
    assert.equal(run.timers[0].interval, 60 * 60 * 1000);
  }
});

test("each production process start requests one immediate catalog sync", () => {
  const first = harness({ NODE_ENV: "production" });
  const restarted = harness({ NODE_ENV: "production", IBSHER_AUTO_SYNC_ENABLED: "false" });
  assert.deepEqual(first.calls, ["sync"]);
  assert.deepEqual(restarted.calls, ["sync"]);
  assert.equal(first.timers[0].interval, 60 * 60 * 1000);
  assert.equal(restarted.timers[0].interval, 60 * 60 * 1000);
});

test("startup uses the guard and the manual admin sync route is unchanged", () => {
  const index = fs.readFileSync(new URL("./index.js", import.meta.url), "utf8");
  const admin = fs.readFileSync(new URL("./routes/admin.js", import.meta.url), "utf8");
  assert.match(index, /startIbsherAutoSync\(\{\s*sync:\s*syncFromIbsher\s*\}\)/);
  assert.equal(index.includes("setInterval(refreshCatalog"), false);
  assert.equal(index.includes("refreshCatalog()"), false);
  assert.match(admin, /adminRouter\.post\("\/sync"/);
  assert.match(admin, /const result = await syncFromIbsher\(\)/);
  assert.equal(admin.includes("ibsherAutoSyncEnabled"), false);
});
