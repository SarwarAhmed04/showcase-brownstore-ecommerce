#!/usr/bin/env node
/**
 * One-time selective restore of the 27 original Brandiraq product documents.
 *
 * The default is a read-only dry-run. Nothing is inserted unless this process
 * is started with both --execute and the one-time authorization phrase.
 * The production backup, the pause marker, .env, and every other collection stay untouched.
 *
 * Dry-run:
 *   node src/scripts/brandiraqSelectiveRecovery.js --confirm-production --allow-verified-production-loopback --report /root/brownstore-backups/brandiraq-27-dry-run-report.json
 *
 * Authorized insert:
 *   node src/scripts/brandiraqSelectiveRecovery.js --confirm-production --allow-verified-production-loopback --execute --authorization AUTHORIZE_ONE_TIME_BRANDIRAQ_27_ORIGINAL_INSERT --report /root/brownstore-backups/brandiraq-27-execute-report.json
 *
 * Verification:
 *   node src/scripts/brandiraqSelectiveRecovery.js --confirm-production --allow-verified-production-loopback --verify --report /root/brownstore-backups/brandiraq-27-verify-report.json
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { MongoClient, ObjectId } from "mongodb";
import {
  BRANDIRAQ_BACKUP_BSON,
  BRANDIRAQ_EXPECTED_DETAILS,
  BRANDIRAQ_EXPECTED_IDS,
  BRANDIRAQ_PAUSE_BASENAME,
  BRANDIRAQ_RECOVERY_AUTHORIZATION,
  PRODUCTS_COLLECTION,
  describeMongoTarget,
  loadExpectedRecoverySet,
  productionInputsAllowed,
  reportPathAllowed,
  runBrandiraqSelectiveRecovery,
  sanitizeText,
  selectBsonDocuments,
} from "../utils/brandiraqSelectiveRecovery.js";

const CONFIRM_FLAG = "--confirm-production";
const LOOPBACK_FLAG = "--allow-verified-production-loopback";

function findServerRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "brownstore-server") return dir;
      } catch {
        // A package file that cannot be parsed is not the server root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "";
}

export function parseRecoveryArguments(argv) {
  const read = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? String(argv[index + 1] || "") : "";
  };
  const execute = argv.includes("--execute");
  const verify = argv.includes("--verify");
  return {
    confirmProduction: argv.includes(CONFIRM_FLAG),
    allowLoopback: argv.includes(LOOPBACK_FLAG),
    execute,
    verify,
    mode: execute ? "execute" : verify ? "verify" : "dry_run",
    conflicting: execute && verify,
    authorization: read("--authorization"),
    bsonPath: read("--bson") || BRANDIRAQ_BACKUP_BSON,
    expectedIdsPath: read("--expected-ids") || BRANDIRAQ_EXPECTED_IDS,
    expectedDetailsPath: read("--expected-details") || BRANDIRAQ_EXPECTED_DETAILS,
    pauseFile: read("--pause-file"),
    reportPath: read("--report"),
  };
}

function scriptIsMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

function fail(code, message) {
  console.error(message);
  process.exitCode = code;
}

async function writeReport(reportPath, report, guards) {
  if (!reportPath) return;
  if (!reportPathAllowed(reportPath, guards)) {
    throw Object.assign(new Error("report_path_refused"), { code: "report_path_refused" });
  }
  await fsPromises.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
}

async function main() {
  const args = parseRecoveryArguments(process.argv.slice(2));
  if (!args.confirmProduction) {
    fail(4, `Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    return;
  }
  if (args.conflicting) {
    fail(2, "Refusing to run. --execute and --verify are separate commands.");
    return;
  }
  const serverDir = findServerRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!serverDir) {
    fail(2, "Refusing to run. The brownstore-server directory was not found.");
    return;
  }
  const pauseFile = args.pauseFile || path.join(serverDir, BRANDIRAQ_PAUSE_BASENAME);
  if (path.resolve(pauseFile) !== path.resolve(serverDir, BRANDIRAQ_PAUSE_BASENAME)) {
    fail(2, "Refusing to run. The pause marker path is not server/ibsher-catalog-sync.paused.");
    return;
  }
  if (!productionInputsAllowed(args)) {
    fail(2, "Refusing to run. The backup and expected-id files must be the verified production paths.");
    return;
  }
  if ((args.execute || args.verify) && !args.reportPath) {
    fail(2, "Refusing to run. Pass --report with a new file outside the production backup.");
    return;
  }
  if (args.reportPath && !reportPathAllowed(args.reportPath, {
    pauseFile,
    expectedIdsPath: args.expectedIdsPath,
    expectedDetailsPath: args.expectedDetailsPath,
    serverDir,
  })) {
    fail(2, "Refusing to run. The report path would overwrite the backup, the pause marker, or .env.");
    return;
  }
  if (args.reportPath && fs.existsSync(args.reportPath)) {
    fail(2, "Refusing to run. The report path already exists; choose a new file so the earlier audit is preserved.");
    return;
  }
  if (args.execute && args.authorization !== BRANDIRAQ_RECOVERY_AUTHORIZATION) {
    fail(2, "Refusing to insert. The one-time administrator authorization is required.");
    return;
  }
  if (args.execute && process.platform === "win32") {
    fail(2, "Refusing to insert from this desktop. Run the authorized command on the production server.");
    return;
  }
  if (!fs.existsSync(pauseFile)) {
    fail(2, "Refusing to run. The IBSHER auto-sync pause marker is absent.");
    return;
  }
  const idText = await fsPromises.readFile(args.expectedIdsPath, "utf8");
  const detailsText = await fsPromises.readFile(args.expectedDetailsPath, "utf8");
  const parsed = loadExpectedRecoverySet(idText, detailsText);
  if (!parsed.ok) {
    fail(2, `Refusing to connect. The expected product set failed validation (${parsed.code}).`);
    return;
  }

  if (fs.existsSync(path.join(serverDir, ".env"))) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available || target.database !== "brownstore") {
    fail(2, "Refusing to connect. MONGO_URL must name the brownstore database. No database was opened.");
    return;
  }
  if (target.loopback && !args.allowLoopback) {
    fail(5, `Refusing loopback database. On the verified production server, re-run with ${LOOPBACK_FLAG}.`);
    return;
  }

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 8000,
    maxPoolSize: 1,
    readPreference: "primary",
  });
  await client.connect();
  try {
    const db = client.db(target.database);
    const products = db.collection(PRODUCTS_COLLECTION);
    const report = await runBrandiraqSelectiveRecovery({
      mode: args.mode,
      platform: process.platform,
      authorization: args.authorization,
      pausePresent: fs.existsSync(pauseFile),
      databaseName: target.database,
      idText,
      detailsText,
      loadBackup: (ids) => selectBsonDocuments(args.bsonPath, ids),
      recheckPause: async () => {
        const stat = await fsPromises.stat(pauseFile).catch(() => null);
        return Boolean(stat?.isFile());
      },
      readCatalog: async () => {
        const expected = loadExpectedRecoverySet(idText, detailsText);
        const rows = expected.ok ? expected.rows : [];
        const objectIds = rows.map((row) => new ObjectId(row.originalId));
        const sourceIds = rows.map((row) => row.sourceId);
        const [total, brandiraq, byId, bySource, listed] = await Promise.all([
          products.countDocuments(),
          products.countDocuments({ "createdBy.name": "Brandiraq" }),
          objectIds.length ? products.find({ _id: { $in: objectIds } }).toArray() : [],
          sourceIds.length ? products.find({ ibsherId: { $in: sourceIds } }).toArray() : [],
          db.listCollections({}, { nameOnly: true }).toArray(),
        ]);
        const collectionCounts = {};
        for (const item of listed) {
          collectionCounts[item.name] = await db.collection(item.name).countDocuments();
        }
        return { total, brandiraq, byId, bySource, collectionCounts };
      },
      insertOriginal: async (doc) => {
        if (args.mode !== "execute") throw new Error("insert_blocked");
        await products.insertOne(doc, { writeConcern: { w: "majority" } });
      },
    });
    const output = {
      ...report,
      database: { host: target.host, name: target.database, loopback: target.loopback },
      inputs: {
        bson: args.bsonPath,
        expectedIds: args.expectedIdsPath,
        expectedDetails: args.expectedDetailsPath,
        pauseFile,
      },
      backupPreserved: true,
    };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    if (args.reportPath) await writeReport(args.reportPath, output, {
      pauseFile,
      expectedIdsPath: args.expectedIdsPath,
      expectedDetailsPath: args.expectedDetailsPath,
      serverDir,
    });
    if (!output.ok) process.exitCode = 2;
  } finally {
    await client.close();
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(sanitizeText(err?.message || err));
    if (!process.exitCode) process.exitCode = err?.code === "report_path_refused" ? 2 : 3;
  });
}
