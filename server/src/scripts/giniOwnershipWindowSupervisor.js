import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CLOSED_LOCK_LINES, FIRST_LIVE_AUDIT_FILE } from "../utils/giniOwnershipFirstSaveProcedure.js";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? "" : String(process.argv[index + 1] || "");
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")).state || "";
  } catch {
    return "";
  }
}

function committedText(repoRoot, sha) {
  const bytes = execFileSync("git", ["show", `${sha}:${FIRST_LIVE_AUDIT_FILE}`], { cwd: repoRoot });
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  if (!text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_RELEASED) || !text.includes(CLOSED_LOCK_LINES.OWNERSHIP_SAVE_INDEXES_READY)) {
    throw new Error("recorded_sha_mismatch");
  }
  return text;
}

function restore(repoRoot, text) {
  const target = path.join(repoRoot, FIRST_LIVE_AUDIT_FILE);
  fs.writeFileSync(target, text);
  const after = fs.readFileSync(target, "utf8");
  if (after !== text) throw new Error("restore_failed");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const repoRoot = argument("--repo");
const sha = argument("--sha");
const parentPid = Number(argument("--parent"));
const deadline = Number(argument("--deadline"));
const signalFile = argument("--signal");

if (!repoRoot || !/^[0-9a-f]{40}$/.test(sha) || !signalFile || !Number.isFinite(deadline)) {
  process.exit(2);
}

const text = committedText(repoRoot, sha);
let reason = "timeout";
while (Date.now() < deadline) {
  const notice = signalState(signalFile);
  if (notice === "graceful") {
    reason = "graceful";
    break;
  }
  if (!pidAlive(parentPid)) {
    reason = "parent_exit";
    break;
  }
  sleep(50);
  if (Date.now() >= deadline) break;
}

restore(repoRoot, text);
const parentAlive = pidAlive(parentPid);
if (parentAlive && reason !== "graceful") {
  fs.writeFileSync(signalFile, JSON.stringify({ state: "close", reason, apiStopped: false }));
  const noticedAt = Date.now() + 1000;
  while (pidAlive(parentPid) && Date.now() < noticedAt) {
    if (signalState(signalFile) === "graceful") break;
    sleep(30);
  }
}
fs.writeFileSync(signalFile, JSON.stringify({
  state: "restored",
  reason,
  apiStopped: false,
  parentAlive: pidAlive(parentPid),
}));
