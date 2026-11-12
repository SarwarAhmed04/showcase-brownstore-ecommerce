#!/usr/bin/env node
/**
 * Read-only ownership index audit.
 *
 * It verifies the Hostinger production context before it lists collections,
 * indexes, owners, or products. An unverified database returns
 * production_context_unverified and does not report local product ids or
 * index state. It does not create a collection, create an index, write a
 * document, or call GINI.
 *
 *   node src/scripts/giniOwnershipReadinessAudit.js --confirm-production --allow-verified-production-loopback
 *
 * Copy the JSON from the terminal. Do not send the shell environment, .env,
 * or any connection string.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { describeMongoTarget, sanitizeText } from "./giniProductionReadOnlyAudit.js";
import { LOOPBACK_FLAG } from "./giniProductionPreflight.js";
import { readOwnershipReadiness, stoppedOwnershipReport } from "../utils/giniOwnershipReadiness.js";

const CONFIRM_FLAG = "--confirm-production";
const WRITE_FLAG = /^--(create|apply|write|ensure|sync|migrate)(?:-|$)/;

function scriptIsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(fileURLToPath(import.meta.url));
  const right = path.resolve(entry);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function findServerRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "brownstore-server") return dir;
      } catch {
        // Keep walking.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function main() {
  const forbidden = process.argv.slice(2).filter((arg) => WRITE_FLAG.test(String(arg)));
  if (forbidden.length) {
    console.error("Refusing to run. This audit cannot create indexes or write to the database.");
    process.exitCode = 2;
    return;
  }
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const serverDir = findServerRoot(path.dirname(fileURLToPath(import.meta.url)));
  const envBefore = Boolean(process.env.MONGO_URL || process.env.MONGODB_URI);
  if (serverDir) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset for this shell and the server .env file. No database was opened.");
    process.exitCode = 2;
    return;
  }
  if (!target.loopback || !process.argv.includes(LOOPBACK_FLAG)) {
    console.error("Refusing database. Production context is not verified. No ownership documents were read.");
    process.stdout.write(`${JSON.stringify(stoppedOwnershipReport(), null, 2)}\n`);
    process.exitCode = 2;
    return;
  }
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    readPreference: "primary",
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    const db = client.db(target.database);
    const report = await readOwnershipReadiness(db, { confirmProduction: true, allowLoopback: true, loopback: true });
    if (report.stopped === true) {
      console.error("Refusing database. Production context is not verified. No product, owner, or index rows were reported.");
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${JSON.stringify({
      readOnly: true,
      connectionSource: envBefore ? "process environment" : "server .env file",
      database: { protocol: target.protocol, host: target.host, name: target.database, loopback: target.loopback },
      ...report,
    }, null, 2)}\n`);
  } catch (err) {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    process.exitCode = 3;
  } finally {
    await client.close().catch(() => {});
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    if (!process.exitCode) process.exitCode = 3;
  });
}
