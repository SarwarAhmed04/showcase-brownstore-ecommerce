#!/usr/bin/env node
/**
 * Read-only check for the GINI re-sync indexes.
 *
 * Run this only from an authorized Hostinger SSH session, in the deployed
 * BrownStore server directory. It does not create a collection, create an
 * index, write to MongoDB, or call GINI.
 *
 *   node src/scripts/giniResyncIndexPreflight.js --confirm-production --allow-verified-production-loopback
 *
 * --confirm-production is required. Loopback is accepted only with the second
 * flag and after the same production fingerprint used by the GINI preflight.
 * If indexes are missing, the JSON includes mongosh commands for a later
 * operator. This process never runs those commands.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { describeMongoTarget, inspectDeployment, maskClientId, sanitizeText } from "./giniProductionReadOnlyAudit.js";
import { evaluateLoopbackAuthorization, LOOPBACK_FLAG } from "./giniProductionPreflight.js";
import { refuseIndexWriteFlags } from "../utils/giniSkuCreateIndexes.js";
import {
  RESYNC_AUDIT_COLLECTION,
  RESYNC_JOB_COLLECTION,
  RESYNC_LOCK_COLLECTION,
  RESYNC_PREVIEW_COLLECTION,
  assessResyncIndexes,
  resyncIndexCreationProcedure,
} from "../utils/giniResyncIndexes.js";

const CONFIRM_FLAG = "--confirm-production";
const QUERY_MS = 120000;
const REPORTED_PREVIEW = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

function scriptIsMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  const left = path.resolve(fileURLToPath(import.meta.url));
  const right = path.resolve(entry);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function scriptDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
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
        // Keep walking. A package file that cannot be parsed is not the server root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function finishConnection(connection) {
  if (!connection?.readyState) return;
  try {
    await connection.disconnect();
  } catch {
    // Closing is cleanup. It must not hide the preflight result.
  }
}

async function closeCursor(cursor) {
  if (typeof cursor?.close !== "function") return;
  try {
    await cursor.close();
  } catch {
    // The documents were already read, or the read already failed.
  }
}

async function collectionNames(db) {
  const cursor = db.listCollections({}, { nameOnly: true });
  try {
    if (typeof cursor.maxTimeMS === "function") cursor.maxTimeMS(QUERY_MS);
    const listed = await cursor.toArray();
    return new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  } finally {
    await closeCursor(cursor);
  }
}

async function listIndexes(collection) {
  const cursor = collection.listIndexes();
  try {
    if (typeof cursor.maxTimeMS === "function") cursor.maxTimeMS(QUERY_MS);
    return await cursor.toArray();
  } finally {
    await closeCursor(cursor);
  }
}

function publicConnection(doc) {
  if (!doc) return { found: false, host: null, hostMatches: false, clientIdMask: "", clientMaskMatches: false };
  let host = "";
  try {
    host = new URL(String(doc.baseUrl || "")).hostname;
  } catch {
    host = "";
  }
  const clientIdMask = maskClientId(doc.clientId);
  return {
    found: true,
    host: host || null,
    hostMatches: host === "merchant.gini.iq",
    clientIdMask,
    clientMaskMatches: clientIdMask === "1423...2bee",
  };
}

async function readPreview(jobs) {
  if (!jobs) return null;
  const cursor = jobs
    .find({ mode: "preview", ...REPORTED_PREVIEW })
    .sort({ createdAt: -1 })
    .limit(1)
    .maxTimeMS(QUERY_MS);
  try {
    return await cursor.next();
  } finally {
    await closeCursor(cursor);
  }
}

async function indexesFor(db, names, collectionName) {
  const actual = names.get(collectionName);
  if (!actual) return { exists: false, indexes: [] };
  return { exists: true, indexes: await listIndexes(db.collection(actual)) };
}

async function main() {
  const forbidden = refuseIndexWriteFlags(process.argv.slice(2));
  if (forbidden.length) {
    console.error("Refusing to run. This preflight cannot create indexes or write to the database.");
    process.exitCode = 2;
    return;
  }
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const serverDir = findServerRoot(scriptDirectory());
  const envBefore = Boolean(process.env.MONGO_URL || process.env.MONGODB_URI);
  if (serverDir) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset for this shell and the server .env file. No database was opened.");
    process.exitCode = 2;
    return;
  }
  const allowLoopback = process.argv.includes(LOOPBACK_FLAG);
  if (target.loopback && !allowLoopback) {
    console.error(
      "Refusing loopback database. --confirm-production does not prove this shell is production. On the verified Hostinger server, re-run with --allow-verified-production-loopback."
    );
    process.exitCode = 2;
    return;
  }

  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  mongoose.set("strictQuery", true);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      readPreference: "primary",
      maxPoolSize: 1,
    });
    let output;
    try {
      output = await (async () => {
        const db = mongoose.connection.db;
        const names = await collectionNames(db);
        const jobs = names.get("ginisyncjobs") ? db.collection(names.get("ginisyncjobs")) : null;
        const connections = names.get("giniconnections") ? db.collection(names.get("giniconnections")) : null;
        const preview = await readPreview(jobs);
        const connection = connections
          ? publicConnection(await connections.findOne({}, { projection: { clientSecretEnc: 0 }, maxTimeMS: QUERY_MS }))
          : { found: false, hostMatches: false, clientMaskMatches: false };
        const deployment = inspectDeployment(scriptDirectory());
        if (target.loopback) {
          const decision = evaluateLoopbackAuthorization({
            confirmProduction: true,
            allowLoopback: true,
            loopback: true,
            databaseName: target.database,
            deployment,
            merchant: connection,
            preview: preview
              ? {
                  found: true,
                  total: Number(preview.total) || 0,
                  readyCreate: Number(preview.readyCreate) || 0,
                  alreadyExists: Number(preview.alreadyExists) || 0,
                  blocked: Number(preview.blocked) || 0,
                  inactive: Number(preview.inactive) || 0,
                }
              : { found: false },
          });
          if (!decision.allowed) {
            const refusal = new Error("Refusing loopback database. Production deployment context was not verified. No index was created.");
            refusal.code = "loopback_refused";
            throw refusal;
          }
        }
        const [lock, audit, job, previewIndexes] = await Promise.all([
          indexesFor(db, names, RESYNC_LOCK_COLLECTION),
          indexesFor(db, names, RESYNC_AUDIT_COLLECTION),
          indexesFor(db, names, RESYNC_JOB_COLLECTION),
          indexesFor(db, names, RESYNC_PREVIEW_COLLECTION),
        ]);
        const assessment = assessResyncIndexes({
          lockExists: lock.exists,
          lockIndexes: lock.indexes,
          auditExists: audit.exists,
          auditIndexes: audit.indexes,
          jobExists: job.exists,
          jobIndexes: job.indexes,
          previewExists: previewIndexes.exists,
          previewIndexes: previewIndexes.indexes,
        });
        return {
          readOnly: true,
          writesPerformed: false,
          methods: [],
          database: { protocol: target.protocol, host: target.host, name: target.database, loopback: target.loopback },
          connectionSource: envBefore ? "process environment" : "server .env file",
          deployment,
          merchant: connection,
          resyncIndexes: assessment,
          procedure: resyncIndexCreationProcedure({ ready: assessment.readyForResyncIndexes }),
          readyForResyncIndexes: assessment.readyForResyncIndexes === true,
          blockers: [
            "This script does not create indexes.",
            "GINI_RESYNC_WRITES_ENABLED and GINI_ALLOW_LIVE_RESYNC_WRITES stay off.",
            "Historical hold SKUs stay blocked. A request flag cannot authorize a new GINI create.",
          ],
        };
      })();
    } finally {
      await finishConnection(mongoose.connection);
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    console.error(`Index preflight read failed: ${sanitizeText(err?.message || err)}`);
    process.exitCode = err?.code === "loopback_refused" ? 2 : 3;
  } finally {
    await finishConnection(mongoose.connection);
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(`Index preflight read failed: ${sanitizeText(err?.message || err)}`);
    if (!process.exitCode) process.exitCode = 3;
  });
}
