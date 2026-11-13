import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLOSED_LOCK_LINES, FIRST_LIVE_AUDIT_FILE } from "./giniOwnershipFirstSaveProcedure.js";
import {
  OWNERSHIP_SAVE_EXCLUDED,
  OWNERSHIP_SAVE_INDEXES_READY,
  OWNERSHIP_SAVE_PILOT,
  OWNERSHIP_SAVE_RELEASED,
  ownershipSaveAuthorization,
} from "./giniVariantOwnershipAudit.js";

export const OWNERSHIP_WINDOW_MS = 15 * 60 * 1000;
const SUPERVISOR_SCRIPT = fileURLToPath(new URL("../scripts/giniOwnershipWindowSupervisor.js", import.meta.url));

const closedState = () => ({
  phase: "closed",
  expires: 0,
  sha: "",
  committedBytes: null,
  repoRoot: "",
  env: null,
  timer: null,
  poll: null,
  supervisor: null,
  signalFile: "",
  consumed: false,
});

let state = closedState();

export function ownershipWindowSnapshot(now = Date.now()) {
  return {
    phase: state.phase,
    open: state.phase === "armed" && now <= state.expires,
    expiresAt: state.expires ? new Date(state.expires).toISOString() : "",
    consumed: state.consumed === true,
  };
}

export function ownershipWindowAllowsSave(now = Date.now()) {
  return state.phase === "armed" && now <= state.expires;
}

export function ownershipWindowPermitsInsert(now = Date.now()) {
  return (state.phase === "armed" || state.phase === "inFlight") && now <= state.expires;
}

export function ownershipWindowBlockCode() {
  if (state.phase === "inFlight" || state.phase === "closing") return "concurrent_request_refused";
  return "ownership_window_closed";
}

export function claimOwnershipSave(now = Date.now()) {
  if (state.phase === "inFlight" || state.phase === "closing") {
    return { ok: false, code: "concurrent_request_refused" };
  }
  if (state.phase !== "armed" || now > state.expires) {
    return { ok: false, code: "ownership_window_closed" };
  }
  state.phase = "inFlight";
  return { ok: true, code: "" };
}

export function disableOwnershipEnvironmentGates(env = process.env) {
  delete env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED;
  delete env.GINI_ALLOW_OWNERSHIP_SAVE;
  const authorization = ownershipSaveAuthorization(env);
  return {
    explicitGate: authorization.explicitGate === true,
    allowGate: authorization.allowGate === true,
    enabled: authorization.enabled === true,
  };
}

export function readCommittedSourceLock(repoRoot, sha, runner = execFileSync) {
  if (!/^[0-9a-f]{40}$/.test(String(sha || ""))) return { ok: false, code: "git_sha_missing", bytes: null };
  let bytes;
  try {
    bytes = runner("git", ["show", `${sha}:${FIRST_LIVE_AUDIT_FILE}`], { cwd: repoRoot });
  } catch {
    return { ok: false, code: "recorded_sha_mismatch", bytes: null };
  }
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  if (!text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED) || !text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY)) {
    return { ok: false, code: "recorded_sha_mismatch", bytes: null };
  }
  return { ok: true, code: "", bytes: Buffer.from(text) };
}

export function restoreCommittedSourceLock(repoRoot, bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes || "");
  if (!text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED) || !text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY)) {
    return { ok: false, code: "recorded_sha_mismatch" };
  }
  const target = path.join(repoRoot, FIRST_LIVE_AUDIT_FILE);
  fs.writeFileSync(target, text);
  const after = fs.readFileSync(target);
  const same = Buffer.compare(after, Buffer.from(text)) === 0;
  return { ok: same, code: same ? "restored" : "restore_failed", bytes: after };
}

function clearTimer() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  if (state.poll) clearInterval(state.poll);
  state.poll = null;
}

export function closeOwnershipWindow(reason = "failure") {
  if (state.phase === "closed" || state.phase === "consumed") {
    return { ok: true, code: "already_closed", reason, windowClosed: true };
  }
  const env = state.env || process.env;
  const repoRoot = state.repoRoot;
  const bytes = state.committedBytes;
  clearTimer();
  state.phase = "closing";
  const environment = disableOwnershipEnvironmentGates(env);
  const restored = bytes ? restoreCommittedSourceLock(repoRoot, bytes) : { ok: false, code: "recorded_sha_mismatch" };
  if (state.signalFile) {
    try {
      fs.writeFileSync(state.signalFile, JSON.stringify({ state: "graceful", reason }));
    } catch {
      // The supervisor restores from the recorded commit even if this notice fails.
    }
  }
  state.phase = "consumed";
  state.consumed = true;
  state.committedBytes = null;
  return {
    ok: restored.ok === true && environment.enabled === false && environment.explicitGate === false && environment.allowGate === false,
    code: restored.ok === true ? "window_closed" : restored.code,
    reason,
    windowClosed: true,
    restored,
    environment,
  };
}

export function armOwnershipWindow({
  repoRoot,
  sha,
  env = process.env,
  now = Date.now(),
  ttlMs = OWNERSHIP_WINDOW_MS,
  supervise = false,
  parentPid = process.pid,
  signalFile = "",
  spawnSupervisor = null,
  readCommit = readCommittedSourceLock,
} = {}) {
  if (state.consumed === true || state.phase === "armed" || state.phase === "inFlight" || state.phase === "closing") {
    return { armed: false, code: "run_already_used", execute: false };
  }
  const committed = readCommit(repoRoot, sha);
  if (!committed.ok) return { armed: false, code: committed.code, execute: false };
  state = {
    ...closedState(),
    phase: "armed",
    expires: now + ttlMs,
    sha,
    committedBytes: committed.bytes,
    repoRoot,
    env,
    signalFile,
  };
  state.timer = setTimeout(() => {
    closeOwnershipWindow("timeout");
  }, Math.max(0, ttlMs));
  if (signalFile) {
    state.poll = setInterval(() => {
      if (state.phase !== "armed" && state.phase !== "inFlight") return;
      try {
        const notice = JSON.parse(fs.readFileSync(signalFile, "utf8"));
        if (notice.state === "close") closeOwnershipWindow(notice.reason || "supervisor");
      } catch {
        // The supervisor creates the signal when it is ready to close.
      }
    }, 30);
  }
  if (supervise === true && typeof spawnSupervisor === "function") {
    state.supervisor = spawnSupervisor({
      repoRoot,
      sha,
      parentPid,
      deadline: state.expires,
      signalFile,
    });
  }
  return {
    armed: true,
    code: "window_armed",
    execute: false,
    expiresAt: new Date(state.expires).toISOString(),
    ttlMs,
  };
}

function defaultSpawnSupervisor(spec) {
  const child = spawn(process.execPath, supervisorLaunchArguments(spec), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}

export function maybeArmOwnershipWindow(options = {}) {
  const released = options.released != null ? options.released === true : OWNERSHIP_SAVE_RELEASED === true;
  const indexesReady = options.indexesReady != null ? options.indexesReady === true : OWNERSHIP_SAVE_INDEXES_READY === true;
  const env = options.env || process.env;
  const environment = env.GINI_VARIANT_OWNERSHIP_SAVE_ENABLED === "true" && env.GINI_ALLOW_OWNERSHIP_SAVE === "true";
  if (released !== true || indexesReady !== true || environment !== true) {
    return { armed: false, code: "gates_closed", execute: false };
  }
  const repoRoot = options.repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  let sha = options.sha || "";
  if (!sha) {
    try {
      sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return { armed: false, code: "git_sha_missing", execute: false };
    }
  }
  return armOwnershipWindow({
    ...options,
    repoRoot,
    sha,
    env,
    supervise: options.supervise === true,
    signalFile: options.signalFile || path.join(os.tmpdir(), `brownstore-ownership-window-${sha}.json`),
    spawnSupervisor: options.spawnSupervisor || defaultSpawnSupervisor,
  });
}

export function resetOwnershipWindowForTests() {
  clearTimer();
  state = closedState();
}

export function dashboardOwnershipSaveAvailable({
  released = false,
  indexesReady = false,
  environmentEnabled = false,
  liveIndexesReady = false,
  confirm = false,
  administratorId = "",
  snapshot = null,
  selected = null,
  pairCode = "pilot_not_authorized",
  windowOpen = false,
  now = Date.now(),
} = {}) {
  if (released !== true || indexesReady !== true || environmentEnabled !== true || liveIndexesReady !== true) return false;
  if (confirm !== true || !String(administratorId || "").trim()) return false;
  if (!snapshot?.id || snapshot.administratorId !== String(administratorId)) return false;
  if (snapshot.productId !== OWNERSHIP_SAVE_PILOT.productId || snapshot.sourceItemId !== OWNERSHIP_SAVE_PILOT.sourceItemId) return false;
  if (snapshot.expiresAt && Date.parse(snapshot.expiresAt) <= now) return false;
  if (selected?.vendor !== OWNERSHIP_SAVE_PILOT.vendorName) return false;
  if (selected?.productId !== OWNERSHIP_SAVE_PILOT.productId || selected?.sourceItemId !== OWNERSHIP_SAVE_PILOT.sourceItemId) return false;
  if (selected?.productId === OWNERSHIP_SAVE_EXCLUDED.productId) return false;
  if (pairCode !== "") return false;
  if (windowOpen !== true) return false;
  return true;
}

export function supervisorLaunchArguments({ repoRoot, sha, parentPid, deadline, signalFile }) {
  return [
    SUPERVISOR_SCRIPT,
    "--repo", repoRoot,
    "--sha", sha,
    "--parent", String(parentPid),
    "--deadline", String(deadline),
    "--signal", signalFile,
  ];
}
