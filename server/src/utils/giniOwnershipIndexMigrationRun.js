import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNERSHIP_SAVE_INDEXES_READY, OWNERSHIP_SAVE_PILOT, OWNERSHIP_SAVE_RELEASED } from "./giniVariantOwnershipAudit.js";
import {
  applyOwnershipIndexMigration,
  decideOwnershipIndexMigration,
  OWNERSHIP_INDEX_MIGRATION_RELEASED,
  OWNERSHIP_MIGRATION_COMMANDS,
  OWNERSHIP_OPERATION_COLLECTION,
  OWNERSHIP_PARENT_COLLECTION,
  readSkuKeyIndexState,
} from "./giniOwnershipIndexPlan.js";

export const OWNERSHIP_INDEX_MIGRATION_ONE_SHOT = "create-ownership-operation-indexes";
const PREVIEW_FINGERPRINT = Object.freeze({
  total: 41415,
  readyCreate: 38551,
  alreadyExists: 0,
  blocked: 661,
  inactive: 2203,
});

function held(code, extra = {}) {
  return {
    ok: false,
    code,
    executed: false,
    connected: false,
    dryRun: true,
    writes: [],
    sentToGini: 0,
    modifiesDocuments: false,
    modifiesParentOwners: false,
    modifiesVariantRecords: false,
    authorizesOwnershipSave: false,
    released: false,
    releasedAfter: OWNERSHIP_INDEX_MIGRATION_RELEASED === true,
    commands: [...OWNERSHIP_MIGRATION_COMMANDS],
    gates: ownershipSaveGates(),
    ...extra,
  };
}

export function ownershipSaveGates() {
  return {
    released: OWNERSHIP_SAVE_RELEASED === true,
    indexesReady: OWNERSHIP_SAVE_INDEXES_READY === true,
    pilotParentSku: OWNERSHIP_SAVE_PILOT.parentSku,
    pilotProductId: OWNERSHIP_SAVE_PILOT.productId,
  };
}

export function productionMigrationRequest({ argv = [], env = {}, platform = "linux" } = {}) {
  const backupAt = argv.indexOf("--backup-dir");
  return {
    platform,
    execute: argv.includes("--execute"),
    productionDryRun: argv.includes("--production-dry-run"),
    confirmProduction: argv.includes("--confirm-production"),
    allowLoopback: argv.includes("--allow-verified-production-loopback"),
    confirmMigration: argv.includes("--confirm-ownership-index-migration"),
    oneShot: env.OWNERSHIP_INDEX_MIGRATION_ONE_SHOT === OWNERSHIP_INDEX_MIGRATION_ONE_SHOT,
    backupDir: backupAt >= 0 ? String(argv[backupAt + 1] || "") : "",
    sourceReleased: OWNERSHIP_INDEX_MIGRATION_RELEASED === true,
  };
}

export function refuseProductionMigration(request) {
  if (request.platform === "win32") return "desktop_execution_refused";
  if (request.sourceReleased) return "migration_release_left_enabled";
  if (!request.oneShot) return "ownership_index_migration_disabled";
  if (!request.confirmProduction || !request.allowLoopback || !request.confirmMigration) return "confirmation_required";
  if (request.execute && request.productionDryRun) return "conflicting_execution_flags";
  if (request.execute && !request.backupDir) return "backup_required";
  return "";
}

export function sameCollectionCounts(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of keys) {
    if (before?.[key] !== after?.[key]) return false;
  }
  return true;
}

export async function collectionCountsExceptOperation(db) {
  const listed = await db.listCollections({}, { nameOnly: true }).toArray();
  const counts = {};
  for (const item of listed) {
    if (String(item.name).toLowerCase() === OWNERSHIP_OPERATION_COLLECTION) continue;
    counts[item.name] = await db.collection(item.name).countDocuments();
  }
  return counts;
}

export function exactOwnershipIndexes(indexes) {
  const wanted = [
    ["operationKey_1", "operationKey"],
    ["skuKey_1", "skuKey"],
  ];
  return wanted.every(([name, field]) => indexes.some((index) => {
    const keys = Object.keys(index?.key || {});
    return index?.name === name
      && index?.unique === true
      && index?.sparse !== true
      && !index?.partialFilterExpression
      && keys.length === 1
      && index.key[field] === 1;
  }));
}

export async function dumpBrownstoreDatabase({ uri, directory, databaseName, spawnImpl }) {
  const args = ["--uri", uri, "--db", databaseName, "--out", directory];
  const result = await spawnImpl("mongodump", args);
  if (result?.code !== 0) return { ok: false, code: "backup_failed" };
  const folder = path.join(directory, databaseName);
  const metadata = path.join(folder, `${OWNERSHIP_PARENT_COLLECTION}.metadata.json`);
  const bson = path.join(folder, `${OWNERSHIP_PARENT_COLLECTION}.bson`);
  const compressed = path.join(folder, `${OWNERSHIP_PARENT_COLLECTION}.bson.gz`);
  const metadataStat = await fs.stat(metadata).catch(() => null);
  const dataStat = await fs.stat(bson).catch(() => null);
  const compressedStat = await fs.stat(compressed).catch(() => null);
  if (!metadataStat?.isFile() || metadataStat.size < 2) return { ok: false, code: "backup_incomplete" };
  if (!dataStat?.isFile() && !compressedStat?.isFile()) return { ok: false, code: "backup_incomplete" };
  return { ok: true, directory, code: "backup_completed" };
}

export function backupDirectoryAllowed(directory, serverDir) {
  if (!directory || !path.isAbsolute(directory)) return false;
  const resolved = path.resolve(directory);
  const server = path.resolve(serverDir || "");
  const relative = path.relative(server, resolved);
  return relative.startsWith("..") || path.isAbsolute(relative);
}

export async function runOneShotOwnershipIndexMigration({
  oneShotRelease = false,
  dryRun = true,
  confirm = false,
  readState,
  readCounts,
  backup,
  createCollection,
  createOperationKeyIndex,
  createSkuKeyIndex,
  listOperationIndexes,
} = {}) {
  if (OWNERSHIP_INDEX_MIGRATION_RELEASED === true) return held("migration_release_left_enabled");
  if (oneShotRelease !== true) return held("ownership_index_migration_disabled");
  const before = await readState();
  const countsBefore = await readCounts();
  const decision = decideOwnershipIndexMigration(before);
  if (dryRun !== false || confirm !== true || decision.code !== "ready_to_create") {
    return {
      ...decision,
      executed: false,
      writes: [],
      dryRun: true,
      connected: true,
      releasedAfter: false,
      authorizesOwnershipSave: false,
      gates: ownershipSaveGates(),
      countsUnchanged: true,
    };
  }
  const backupResult = await backup({ counts: countsBefore, parentDocumentCount: before.parentDocumentCount });
  if (!backupResult?.ok) {
    return held("backup_failed", { connected: true, backup: { ok: false, code: backupResult?.code || "backup_failed" } });
  }
  const mid = await readState();
  const midCounts = await readCounts();
  const midDecision = decideOwnershipIndexMigration(mid);
  if (
    midDecision.code !== "ready_to_create"
    || mid.documentCount !== before.documentCount
    || mid.parentDocumentCount !== before.parentDocumentCount
    || !sameCollectionCounts(countsBefore, midCounts)
  ) {
    return held("state_changed_after_backup", { connected: true, backup: { ok: true, directory: backupResult.directory } });
  }
  const applied = await applyOwnershipIndexMigration({
    readState,
    createCollection,
    createOperationKeyIndex,
    createSkuKeyIndex,
    dryRun: false,
    confirm: true,
  });
  const after = await readState();
  const countsAfter = await readCounts();
  const indexes = await listOperationIndexes();
  const countsUnchanged = sameCollectionCounts(countsBefore, countsAfter) && after.documentCount === before.documentCount;
  const indexesReady = exactOwnershipIndexes(indexes);
  if (applied.code !== "ownership_indexes_created" || !indexesReady || !countsUnchanged || after.parentDocumentCount !== before.parentDocumentCount) {
    return held("index_verification_failed", {
      connected: true,
      executed: true,
      dryRun: false,
      writes: applied.writes || [],
      countsUnchanged,
      indexesReady,
      documentCount: after.documentCount,
      parentDocumentCount: after.parentDocumentCount,
    });
  }
  return {
    ...applied,
    ok: true,
    connected: true,
    releasedAfter: OWNERSHIP_INDEX_MIGRATION_RELEASED === true,
    indexesReady: true,
    countsUnchanged: true,
    authorizesOwnershipSave: false,
    gates: ownershipSaveGates(),
    backup: { ok: true, directory: backupResult.directory },
    commands: [...OWNERSHIP_MIGRATION_COMMANDS],
  };
}

export async function runProductionOwnershipIndexMigration({
  argv = [],
  env = process.env,
  platform = process.platform,
  connect,
} = {}) {
  const request = productionMigrationRequest({ argv, env, platform });
  const refusal = refuseProductionMigration(request);
  if (refusal) return held(refusal);
  const connector = connect || connectProductionDatabase;
  return connector(request, env);
}

export async function connectProductionDatabase(request) {
  const [{ MongoClient }, dotenv, { spawn }, { evaluateLoopbackAuthorization }, audit] = await Promise.all([
    import("mongodb"),
    import("dotenv"),
    import("node:child_process"),
    import("../scripts/giniProductionPreflight.js"),
    import("../scripts/giniProductionReadOnlyAudit.js"),
  ]);
  const serverDir = findServerRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!serverDir) return held("database_identity_unverified");
  if (request.execute && !backupDirectoryAllowed(request.backupDir, serverDir)) {
    return held("backup_directory_rejected");
  }
  dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = audit.describeMongoTarget(uri);
  if (!uri || !target.available || target.loopback !== true || target.database !== "brownstore") {
    return held("database_identity_unverified");
  }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, readPreference: "primary", maxPoolSize: 1 });
  await client.connect();
  try {
    const db = client.db(target.database);
    const identity = await readProductionIdentity(db, {
      deployment: audit.inspectDeployment(serverDir),
      evaluateLoopbackAuthorization,
      maskClientId: audit.maskClientId,
    });
    if (!identity.allowed) return held("database_identity_unverified", { connected: true, reason: identity.reason });
    const readState = async () => ({ ...(await readSkuKeyIndexState(db)), identity: identity.identity });
    const operations = () => db.collection(OWNERSHIP_OPERATION_COLLECTION);
    return await runOneShotOwnershipIndexMigration({
      oneShotRelease: true,
      dryRun: request.execute !== true,
      confirm: true,
      readState,
      readCounts: () => collectionCountsExceptOperation(db),
      backup: async (snapshot) => {
        await fs.mkdir(request.backupDir, { recursive: false });
        const dump = await dumpBrownstoreDatabase({
          uri,
          directory: request.backupDir,
          databaseName: target.database,
          spawnImpl: (command, args) => new Promise((resolve) => {
            const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
            let stderr = "";
            child.stderr.on("data", (chunk) => {
              stderr = `${stderr}${chunk}`.slice(-500);
            });
            child.on("close", (code) => resolve({ code, stderr: audit.sanitizeText(stderr) }));
          }),
        });
        if (!dump.ok) return dump;
        await fs.writeFile(path.join(request.backupDir, "ownership-index-manifest.json"), JSON.stringify({
          database: target.database,
          parentDocumentCount: snapshot.parentDocumentCount,
          counts: snapshot.counts,
        }, null, 2));
        return dump;
      },
      createCollection: (name) => db.createCollection(name),
      createOperationKeyIndex: (keys, options) => operations().createIndex(keys, options),
      createSkuKeyIndex: (keys, options) => operations().createIndex(keys, options),
      listOperationIndexes: () => operations().listIndexes().toArray(),
    });
  } catch (err) {
    return held("migration_failed", { connected: true, reason: audit.sanitizeText(err?.message || err) });
  } finally {
    await client.close().catch(() => {});
  }
}

async function readProductionIdentity(db, { deployment, evaluateLoopbackAuthorization, maskClientId }) {
  const names = new Map((await db.listCollections({}, { nameOnly: true }).toArray()).map((item) => [String(item.name).toLowerCase(), item.name]));
  const connection = names.get("giniconnections")
    ? await db.collection(names.get("giniconnections")).findOne({}, { projection: { baseUrl: 1, clientId: 1 } })
    : null;
  const preview = names.get("ginisyncjobs")
    ? await db.collection(names.get("ginisyncjobs")).find({ mode: "preview", ...PREVIEW_FINGERPRINT }).sort({ createdAt: -1 }).limit(1).next()
    : null;
  let host = "";
  try {
    host = new URL(String(connection?.baseUrl || "")).hostname;
  } catch {
    host = "";
  }
  const decision = evaluateLoopbackAuthorization({
    confirmProduction: true,
    allowLoopback: true,
    loopback: true,
    databaseName: db.databaseName,
    deployment,
    merchant: {
      hostMatches: host === "merchant.gini.iq",
      clientMaskMatches: maskClientId(connection?.clientId) === "1423...2bee",
    },
    preview: preview ? { found: true, ...PREVIEW_FINGERPRINT } : { found: false },
  });
  if (!decision.allowed || decision.reason !== "verified_production_loopback") {
    return { allowed: false, reason: decision.reason };
  }
  return {
    allowed: true,
    reason: decision.reason,
    identity: {
      databaseName: "brownstore",
      loopback: true,
      merchantHostMatches: true,
      clientMaskMatches: true,
      previewFingerprintMatches: true,
    },
  };
}

function findServerRoot(start) {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 6; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    if (fsSync.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
        if (pkg.name === "brownstore-server") return dir;
      } catch {
        // Keep walking toward the server package.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
