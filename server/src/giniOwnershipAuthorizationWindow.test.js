import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  OWNERSHIP_WINDOW_MS,
  armOwnershipWindow,
  claimOwnershipSave,
  closeOwnershipWindow,
  dashboardOwnershipSaveAvailable,
  disableOwnershipEnvironmentGates,
  maybeArmOwnershipWindow,
  ownershipWindowSnapshot,
  resetOwnershipWindowForTests,
} from "./utils/giniOwnershipAuthorizationWindow.js";
import { CLOSED_LOCK_LINES, OPEN_LOCK_LINES } from "./utils/giniOwnershipFirstSaveProcedure.js";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_RELEASED, ownershipSaveAuthorization } from "./utils/giniVariantOwnershipAudit.js";

const IT = "6adf9ca49dedbaa3dd573cce";
const IT_SOURCE = "6adf9824ef43bcf3ec7d1ee4";
const JAWAL = "6ae08bbd9dedbaa3dd5740d9";
const AUDIT = "server/src/utils/giniVariantOwnershipAudit.js";

function git(cwd, args) {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bs-ownership-window-"));
  const file = path.join(root, AUDIT);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const closed = `${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\n`;
  fs.writeFileSync(file, closed);
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--", AUDIT]);
  git(root, ["-c", "user.email=window@brownstore.test", "-c", "user.name=window", "commit", "-m", "closed", "--quiet"]);
  const sha = git(root, ["rev-parse", "HEAD"]).trim();
  return { root, file, closed, sha };
}

function openLocks(file) {
  fs.writeFileSync(file, `${OPEN_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\n${OPEN_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\n`);
}

function validDashboard(extra = {}) {
  return dashboardOwnershipSaveAvailable({
    released: true,
    indexesReady: true,
    environmentEnabled: true,
    liveIndexesReady: true,
    confirm: true,
    administratorId: "admin-1",
    snapshot: {
      id: "snapshot-1",
      administratorId: "admin-1",
      productId: IT,
      sourceItemId: IT_SOURCE,
      expiresAt: new Date(Date.now() + OWNERSHIP_WINDOW_MS).toISOString(),
    },
    selected: { vendor: "IT Lobby", productId: IT, sourceItemId: IT_SOURCE },
    pairCode: "",
    windowOpen: true,
    ...extra,
  });
}

function waitFor(read, timeoutMs = 4000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      try {
        const value = read();
        if (value) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          reject(new Error("timed out waiting for the ownership window"));
        }
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 20);
  });
}

test("the dashboard save button enables only for the confirmed IT Lobby snapshot inside an open window", () => {
  assert.equal(validDashboard(), true);
  assert.equal(validDashboard({ released: false }), false);
  assert.equal(validDashboard({ indexesReady: false }), false);
  assert.equal(validDashboard({ environmentEnabled: false }), false);
  assert.equal(validDashboard({ liveIndexesReady: false }), false);
  assert.equal(validDashboard({ confirm: false }), false);
  assert.equal(validDashboard({ windowOpen: false }), false);
  assert.equal(validDashboard({ administratorId: "other-admin" }), false);
  assert.equal(validDashboard({
    selected: { vendor: "Jawal Flex", productId: JAWAL, sourceItemId: "6adf9cf4ef43bcf3ec7daac1" },
  }), false);
  assert.equal(validDashboard({
    snapshot: {
      id: "snapshot-1",
      administratorId: "admin-1",
      productId: IT,
      sourceItemId: IT_SOURCE,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    },
  }), false);
  assert.equal(validDashboard({ pairCode: "pilot_not_authorized" }), false);
  assert.equal(OWNERSHIP_SAVE_RELEASED, false);
  assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  assert.equal(maybeArmOwnershipWindow().code, "gates_closed");
  assert.equal(maybeArmOwnershipWindow({
    released: false,
    indexesReady: false,
    env: { GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true", GINI_ALLOW_OWNERSHIP_SAVE: "true" },
  }).code, "gates_closed");
});

test("the window restores the committed locks and drops the environment gates on failure, timeout, interruption, and a duplicate", async () => {
  const repo = tempRepo();
  const env = {
    GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true",
    GINI_ALLOW_OWNERSHIP_SAVE: "true",
  };
  try {
    openLocks(repo.file);
    const armed = armOwnershipWindow({ repoRoot: repo.root, sha: repo.sha, env, ttlMs: 60_000, supervise: false });
    assert.equal(armed.armed, true);
    assert.equal(armed.execute, false);
    assert.equal(ownershipWindowSnapshot().open, true);
    assert.equal(claimOwnershipSave().ok, true);
    assert.equal(claimOwnershipSave().code, "concurrent_request_refused");
    const failed = closeOwnershipWindow("failure");
    assert.equal(failed.ok, true);
    assert.equal(failed.environment.enabled, false);
    assert.equal(failed.environment.explicitGate, false);
    assert.equal(failed.environment.allowGate, false);
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED, undefined);
    assert.equal(claimOwnershipSave().code, "ownership_window_closed");
    assert.equal(armOwnershipWindow({ repoRoot: repo.root, sha: repo.sha, env, supervise: false }).code, "run_already_used");

    resetOwnershipWindowForTests();
    env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = "true";
    env.GINI_ALLOW_OWNERSHIP_SAVE = "true";
    openLocks(repo.file);
    armOwnershipWindow({ repoRoot: repo.root, sha: repo.sha, env, ttlMs: 40, supervise: false });
    await waitFor(() => ownershipWindowSnapshot().phase === "consumed");
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(ownershipSaveAuthorization(env).explicitGate, false);
    assert.equal(ownershipSaveAuthorization(env).allowGate, false);
    assert.equal(ownershipSaveAuthorization(env).enabled, false);

    resetOwnershipWindowForTests();
    env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = "true";
    env.GINI_ALLOW_OWNERSHIP_SAVE = "true";
    openLocks(repo.file);
    armOwnershipWindow({ repoRoot: repo.root, sha: repo.sha, env, ttlMs: 60_000, supervise: false });
    const interrupted = closeOwnershipWindow("interrupted");
    assert.equal(interrupted.reason, "interrupted");
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(env.GINI_ALLOW_OWNERSHIP_SAVE, undefined);

    resetOwnershipWindowForTests();
    env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = "true";
    env.GINI_ALLOW_OWNERSHIP_SAVE = "true";
    openLocks(repo.file);
    const signal = path.join(repo.root, "close-signal.json");
    armOwnershipWindow({ repoRoot: repo.root, sha: repo.sha, env, ttlMs: 60_000, supervise: false, signalFile: signal });
    fs.writeFileSync(signal, JSON.stringify({ state: "close", reason: "supervisor" }));
    await waitFor(() => ownershipWindowSnapshot().phase === "consumed");
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED, undefined);
    assert.equal(disableOwnershipEnvironmentGates(env).enabled, false);

    resetOwnershipWindowForTests();
    const restarted = {
      GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true",
      GINI_ALLOW_OWNERSHIP_SAVE: "true",
    };
    assert.equal(maybeArmOwnershipWindow({ released: false, indexesReady: false, env: restarted }).code, "gates_closed");
    assert.equal(ownershipSaveAuthorization(restarted).enabled, false);
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(fs.existsSync(`${repo.file}.bak`), false);
  } finally {
    resetOwnershipWindowForTests();
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the independent supervisor restores the committed file on timeout and leaves the api process running", async () => {
  const repo = tempRepo();
  const signal = path.join(repo.root, "window-signal.json");
  const proof = path.join(repo.root, "env-proof.json");
  const parentScript = path.join(repo.root, "parent.mjs");
  const realAudit = fs.readFileSync(new URL("./utils/giniVariantOwnershipAudit.js", import.meta.url));
  fs.writeFileSync(parentScript, `import { readFileSync, writeFileSync } from "node:fs";
import { disableOwnershipEnvironmentGates } from ${JSON.stringify(pathToFileUrl(new URL("./utils/giniOwnershipAuthorizationWindow.js", import.meta.url)))};
process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED = "true";
process.env.GINI_ALLOW_OWNERSHIP_SAVE = "true";
writeFileSync(process.argv[2], String(process.pid));
let closed = false;
setInterval(() => {
  if (closed) return;
  try {
    const notice = JSON.parse(readFileSync(process.argv[4], "utf8"));
    if (notice.state === "close" || notice.state === "restored") {
      closed = true;
      const environment = disableOwnershipEnvironmentGates(process.env);
      writeFileSync(process.argv[3], JSON.stringify({ ...environment, pid: process.pid, online: true }));
      writeFileSync(process.argv[4], JSON.stringify({ state: "graceful", reason: notice.reason || "" }));
    }
  } catch {
    // The supervisor writes the close signal after restoring the committed file.
  }
}, 20);
`);
  const parent = spawn(process.execPath, [parentScript, path.join(repo.root, "parent.pid"), proof, signal], { stdio: "ignore" });
  try {
    openLocks(repo.file);
    const pid = Number(await waitFor(() => {
      const pidFile = path.join(repo.root, "parent.pid");
      return fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : "";
    }));
    const supervisor = spawn(process.execPath, [
      fileURLToPath(new URL("./scripts/giniOwnershipWindowSupervisor.js", import.meta.url)),
      "--repo", repo.root,
      "--sha", repo.sha,
      "--parent", String(pid),
      "--deadline", String(Date.now() + 300),
      "--signal", signal,
      "--grace", "400",
    ], { stdio: "ignore" });
    await new Promise((resolve, reject) => {
      supervisor.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`supervisor exit ${code}`))));
      supervisor.once("error", reject);
    });
    const environment = JSON.parse(await waitFor(() => (fs.existsSync(proof) ? fs.readFileSync(proof, "utf8") : "")));
    assert.equal(environment.enabled, false);
    assert.equal(environment.explicitGate, false);
    assert.equal(environment.allowGate, false);
    assert.equal(environment.online, true);
    assert.equal(environment.pid, pid);
    process.kill(pid, 0);
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    const notice = JSON.parse(fs.readFileSync(signal, "utf8"));
    assert.equal(notice.apiStopped === true, false);
    assert.equal(notice.state === "restored" || notice.state === "graceful", true);
    assert.equal(fs.existsSync(`${repo.file}.bak`), false);
    assert.equal(realAudit.equals(fs.readFileSync(new URL("./utils/giniVariantOwnershipAudit.js", import.meta.url))), true);
    assert.equal(OWNERSHIP_SAVE_RELEASED, false);
    assert.equal(OWNERSHIP_SAVE_INDEXES_READY, false);
  } finally {
    parent.kill("SIGKILL");
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

function pathToFileUrl(url) {
  return url.href;
}

test("the supervisor recovers a closed source file when the api process disappears", async () => {
  const repo = tempRepo();
  const signal = path.join(repo.root, "window-signal.json");
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    openLocks(repo.file);
    const supervisor = spawn(process.execPath, [
      fileURLToPath(new URL("./scripts/giniOwnershipWindowSupervisor.js", import.meta.url)),
      "--repo", repo.root,
      "--sha", repo.sha,
      "--parent", String(parent.pid),
      "--deadline", String(Date.now() + 10_000),
      "--signal", signal,
      "--grace", "200",
    ], { stdio: "ignore" });
    parent.kill("SIGKILL");
    await new Promise((resolve, reject) => {
      supervisor.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`supervisor exit ${code}`))));
      supervisor.once("error", reject);
    });
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(JSON.parse(fs.readFileSync(signal, "utf8")).reason, "parent_exit");
    assert.equal(JSON.parse(fs.readFileSync(signal, "utf8")).apiStopped, false);
    assert.equal(fs.existsSync(`${repo.file}.bak`), false);
  } finally {
    parent.kill("SIGKILL");
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("the supervisor restores only the validated commit of the lock file", async () => {
  const repo = tempRepo();
  const unrelated = path.join(repo.root, "server/src/index.js");
  fs.mkdirSync(path.dirname(unrelated), { recursive: true });
  fs.writeFileSync(unrelated, "unrelated-original\n");
  git(repo.root, ["add", "--", "server/src/index.js"]);
  git(repo.root, ["-c", "user.email=window@brownstore.test", "-c", "user.name=window", "commit", "-m", "unrelated", "--quiet"]);
  openLocks(repo.file);
  fs.writeFileSync(unrelated, "unrelated-local-edit\n");
  git(repo.root, ["add", "--", AUDIT]);
  git(repo.root, ["-c", "user.email=window@brownstore.test", "-c", "user.name=window", "commit", "-m", "opened locks", "--quiet"]);
  const supervisor = spawn(process.execPath, [
    fileURLToPath(new URL("./scripts/giniOwnershipWindowSupervisor.js", import.meta.url)),
    "--repo", repo.root,
    "--sha", repo.sha,
    "--parent", "999999",
    "--deadline", String(Date.now() - 1),
    "--signal", path.join(repo.root, "window-signal.json"),
  ], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      supervisor.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`supervisor exit ${code}`))));
      supervisor.once("error", reject);
    });
    assert.equal(fs.readFileSync(repo.file, "utf8"), repo.closed);
    assert.equal(fs.readFileSync(unrelated, "utf8"), "unrelated-local-edit\n");
    assert.equal(fs.existsSync(`${repo.file}.bak`), false);
    const source = fs.readFileSync(fileURLToPath(new URL("./scripts/giniOwnershipWindowSupervisor.js", import.meta.url)), "utf8");
    for (const token of ["SIGKILL", "SIGTERM", "createIndex", "dropIndex", "git restore"]) {
      assert.equal(source.includes(token), false, token);
    }
  } finally {
    supervisor.kill("SIGKILL");
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("an isolated pm2 restart stays online and cannot inherit save permission", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bs-pm2-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "bs-pm2-app-"));
  const lock = path.join(work, "locks.txt");
  const portFile = path.join(work, "port.txt");
  const pidFile = path.join(work, "pid.txt");
  fs.writeFileSync(lock, `${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED}\n${CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY}\n`);
  fs.writeFileSync(path.join(work, "app.mjs"), `import http from "node:http";
import fs from "node:fs";
const text = fs.readFileSync(process.env.LOCK_FILE, "utf8");
const released = text.includes("OWNERSHIP_SAVE_RELEASED = true");
const envOn = process.env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED === "true" && process.env.GINI_ALLOW_OWNERSHIP_SAVE === "true";
const server = http.createServer((_req, res) => {
  res.end(JSON.stringify({ pid: process.pid, released, envOn, saveAllowed: released && envOn, online: true }));
});
server.listen(0, "127.0.0.1", () => {
  fs.writeFileSync(process.env.PORT_FILE, String(server.address().port));
  fs.writeFileSync(process.env.PID_FILE, String(process.pid));
});
`);
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  execFileSync(process.execPath, [npmCli, "install", "pm2", "--omit=dev", "--prefix", work], { stdio: "pipe", timeout: 180000 });
  const pm2Bin = path.join(work, "node_modules", "pm2", "bin", "pm2");
  const pm2Env = {
    ...process.env,
    PM2_HOME: home,
    GINI_VARIANT_OWNERSHIP_SAVE_ENABLED: "true",
    GINI_ALLOW_OWNERSHIP_SAVE: "true",
    LOCK_FILE: lock,
    PORT_FILE: portFile,
    PID_FILE: pidFile,
  };
  const pm2 = (args) => execFileSync(process.execPath, [pm2Bin, ...args], { env: pm2Env, encoding: "utf8" });
  try {
    pm2(["start", path.join(work, "app.mjs"), "--name", "bs-ownership-window-test", "--interpreter", process.execPath, "--update-env"]);
    const firstPid = Number(await waitFor(() => (fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : ""), 15000));
    const before = await fetch(`http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/`).then((response) => response.json());
    assert.equal(before.online, true);
    assert.equal(before.pid, firstPid);
    assert.equal(before.envOn, true);
    assert.equal(before.saveAllowed, false);
    process.kill(firstPid, "SIGKILL");
    const restartedPid = Number(await waitFor(() => {
      const current = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
      return current && Number(current) !== firstPid ? current : "";
    }, 15000));
    const after = await fetch(`http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}/`).then((response) => response.json());
    assert.equal(after.online, true);
    assert.equal(after.pid, restartedPid);
    assert.notEqual(after.pid, firstPid);
    assert.equal(after.released, false);
    assert.equal(after.envOn, true);
    assert.equal(after.saveAllowed, false);
    assert.equal(maybeArmOwnershipWindow({
      released: false,
      indexesReady: false,
      env: pm2Env,
    }).armed, false);
    assert.equal(ownershipSaveAuthorization(pm2Env).enabled, false);
  } finally {
    try { pm2(["delete", "bs-ownership-window-test"]); } catch { /* already gone */ }
    try { pm2(["kill"]); } catch { /* isolated daemon */ }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});
