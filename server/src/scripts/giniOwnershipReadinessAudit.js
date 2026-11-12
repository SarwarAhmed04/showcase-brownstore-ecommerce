#!/usr/bin/env node
/**
 * Read-only ownership index audit.
 *
 * It lists collections and indexes, then finds owner, operation, and product
 * rows. It does not create a collection, create an index, write a document,
 * or call GINI.
 *
 *   node src/scripts/giniOwnershipReadinessAudit.js --confirm-production
 *
 * Loopback databases are refused. Copy the JSON from the terminal. Do not
 * send the shell environment, .env, or any connection string.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { describeMongoTarget, inspectDeployment, maskClientId, sanitizeText } from "./giniProductionReadOnlyAudit.js";
import { evaluateLoopbackAuthorization, LOOPBACK_FLAG } from "./giniProductionPreflight.js";
import { readOwnershipReadiness } from "../utils/giniOwnershipReadiness.js";

const REPORTED_PREVIEW = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

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
  if (target.loopback && !process.argv.includes(LOOPBACK_FLAG)) {
    console.error("Refusing loopback database. --confirm-production does not prove this shell is production.");
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
    if (target.loopback) {
      const names = new Map((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => [String(item.name).toLowerCase(), item.name]));
      const connectionName = names.get("giniconnections");
      const jobName = names.get("ginisyncjobs");
      const connectionDoc = connectionName
        ? await db.collection(connectionName).findOne({}, { projection: { baseUrl: 1, clientId: 1, hasSecret: 1 } })
        : null;
      const preview = jobName
        ? await db.collection(jobName).find({ mode: "preview", ...REPORTED_PREVIEW }).sort({ createdAt: -1 }).limit(1).next()
        : null;
      let host = "";
      try {
        host = new URL(String(connectionDoc?.baseUrl || "")).hostname;
      } catch {
        host = "";
      }
      const clientIdMask = maskClientId(connectionDoc?.clientId);
      const decision = evaluateLoopbackAuthorization({
        confirmProduction: true,
        allowLoopback: true,
        loopback: true,
        databaseName: target.database,
        deployment: inspectDeployment(path.dirname(fileURLToPath(import.meta.url))),
        merchant: {
          hostMatches: host === "merchant.gini.iq",
          clientMaskMatches: clientIdMask === "1423...2bee",
        },
        preview: preview ? { found: true, ...REPORTED_PREVIEW } : { found: false },
      });
      if (!decision.allowed) {
        console.error(`Refusing loopback database: ${decision.reason}. No ownership documents were read.`);
        process.exitCode = 2;
        return;
      }
    }
    const report = await readOwnershipReadiness(db);
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
