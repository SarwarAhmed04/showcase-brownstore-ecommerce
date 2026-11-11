#!/usr/bin/env node
/**
 * Read-only GINI category-mapping export.
 *
 * Review this file before running it. Run it only from an authorized
 * Hostinger SSH session, inside the deployed BrownStore server directory:
 *
 *   node src/scripts/giniProductionMappingExport.js --confirm-production
 *
 * It lists collections, finds GINI taxonomy rows, and aggregates product
 * collection names. It does not insert, update, delete, or call GINI.
 * Copy the JSON from stdout. Do not send the shell environment, .env,
 * or any connection string.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";

const CONFIRM_FLAG = "--confirm-production";
const QUERY_MS = 120000;

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|secret|token|jwt|apikey|api_key|clientsecret)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, "[redacted-jwt]");
}

export function describeMongoTarget(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return { available: false };
  const protocol = raw.startsWith("mongodb+srv://") ? "mongodb+srv" : raw.startsWith("mongodb://") ? "mongodb" : "";
  if (!protocol) return { available: false, reason: "unrecognized database protocol" };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { available: false, reason: "database target could not be parsed" };
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || "");
  return {
    available: true,
    protocol,
    host: parsed.host,
    database: database || null,
    loopback:
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1",
  };
}

export function localizedTriple(name) {
  if (typeof name === "string") {
    const value = name.trim().replace(/\s+/g, " ");
    return { en: value, ar: "", ku: "" };
  }
  const read = (key) => String(name?.[key] || "").trim().replace(/\s+/g, " ");
  return { en: read("en"), ar: read("ar"), ku: read("ku") };
}

export function normalizeIdentityPart(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Stable collection identity: category, subcategory, then collection,
 * each in English, Arabic, and Kurdish. An empty key means the product
 * path did not supply a name. MongoDB ids are not part of this key.
 */
export function mappingIdentityKey(collection, category, subcategory) {
  const parts = [category, subcategory, collection].flatMap((name) => {
    const triple = localizedTriple(name);
    return [triple.en, triple.ar, triple.ku].map(normalizeIdentityPart);
  });
  if (parts.every((part) => part === "")) return "";
  return parts.join("|");
}

function storedValue(values, key) {
  return String(values?.[key] ?? "").trim();
}

function cleanIds(ids) {
  return [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
}

export function giniValuesComplete(values) {
  return ["categoryName", "categoryId", "subcategoryName", "subcategoryId"].every(
    (key) => storedValue(values, key) !== ""
  );
}

/**
 * Join saved GINI rows to product-embedded collection paths.
 * `groups` come from a product aggregate keyed by collectionName._id.
 * The separate catalog-collection document id is intentionally unused.
 */
export function buildGiniMappingExport(configs, groups) {
  const byId = new Map((groups || []).map((group) => [String(group?._id || ""), group]));
  const rows = (configs || [])
    .filter((config) => String(config?.partner || "") === "gini")
    .map((config) => {
      const brownCollectionId = String(config?.brownCollectionId || "").trim();
      const group = byId.get(brownCollectionId);
      const collection = localizedTriple(group?.collection);
      const category = localizedTriple(group?.category);
      const subcategory = localizedTriple(group?.subcategory);
      const identityKey = group ? mappingIdentityKey(collection, category, subcategory) : "";
      const categoryIds = cleanIds(group?.categoryIds);
      const subcategoryIds = cleanIds(group?.subcategoryIds);
      const ambiguousHierarchy = Boolean(group) && (categoryIds.length > 1 || subcategoryIds.length > 1);
      const values = config?.values || {};
      return {
        partner: "gini",
        brownCollectionId,
        categoryId: storedValue(values, "categoryId"),
        categoryName: storedValue(values, "categoryName"),
        subcategoryId: storedValue(values, "subcategoryId"),
        subcategoryName: storedValue(values, "subcategoryName"),
        complete: giniValuesComplete(values),
        collection,
        category,
        subcategory,
        identityKey,
        identityResolved: Boolean(identityKey),
        ambiguousHierarchy,
        duplicateIdentity: false,
        productCount: Number(group?.productCount) || 0,
        multiVariantProductCount: Number(group?.multiVariantProductCount) || 0,
      };
    });

  const seen = new Map();
  for (const row of rows) {
    if (!row.identityKey) continue;
    seen.set(row.identityKey, (seen.get(row.identityKey) || 0) + 1);
  }
  for (const row of rows) {
    row.duplicateIdentity = Boolean(row.identityKey) && seen.get(row.identityKey) > 1;
    row.importEligible = Boolean(
      row.complete && row.identityResolved && !row.ambiguousHierarchy && !row.duplicateIdentity
    );
  }

  const summary = {
    mappingCount: rows.length,
    complete: rows.filter((row) => row.complete).length,
    incomplete: rows.filter((row) => !row.complete).length,
    identityResolved: rows.filter((row) => row.identityResolved).length,
    identityUnresolved: rows.filter((row) => !row.identityResolved).length,
    ambiguousHierarchy: rows.filter((row) => row.ambiguousHierarchy).length,
    duplicateIdentity: rows.filter((row) => row.duplicateIdentity).length,
    importEligible: rows.filter((row) => row.importEligible).length,
  };
  return { summary, mappings: rows };
}

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
        // Keep walking. A package file that cannot be parsed is not the server root.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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
    const listed = await cursor.toArray();
    return new Map(listed.map((item) => [String(item.name).toLowerCase(), item.name]));
  } finally {
    await closeCursor(cursor);
  }
}

export async function readGiniMappingExport(db) {
  const names = await collectionNames(db);
  const taxonomyName = names.get("platformtaxonomyconfigs");
  const productName = names.get("products");
  if (!taxonomyName || !productName) {
    return {
      available: false,
      reason: !taxonomyName ? "platformtaxonomyconfigs is absent" : "products is absent",
      summary: buildGiniMappingExport([], []).summary,
      mappings: [],
    };
  }

  const configCursor = db.collection(taxonomyName).find(
    { partner: "gini" },
    { projection: { _id: 0, partner: 1, brownCollectionId: 1, values: 1 }, maxTimeMS: QUERY_MS }
  );
  let configs = [];
  try {
    configs = await configCursor.toArray();
  } finally {
    await closeCursor(configCursor);
  }

  const productCursor = db.collection(productName).aggregate(
    [
      {
        $match: {
          "collectionName._id": { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: { $toString: "$collectionName._id" },
          collection: { $first: "$collectionName.name" },
          category: { $first: "$category.name" },
          subcategory: { $first: "$subCategory.name" },
          categoryIds: { $addToSet: { $toString: { $ifNull: ["$category._id", ""] } } },
          subcategoryIds: { $addToSet: { $toString: { $ifNull: ["$subCategory._id", ""] } } },
          productCount: { $sum: 1 },
          multiVariantProductCount: {
            $sum: {
              $cond: [{ $gt: [{ $size: { $ifNull: ["$variants", []] } }, 1] }, 1, 0],
            },
          },
        },
      },
    ],
    { maxTimeMS: QUERY_MS }
  );
  let groups = [];
  try {
    groups = await productCursor.toArray();
  } finally {
    await closeCursor(productCursor);
  }

  return { available: true, reason: "", ...buildGiniMappingExport(configs, groups) };
}

async function finishConnection(connection) {
  if (!connection || !connection.readyState) return;
  try {
    await connection.disconnect();
  } catch {
    // Closing is cleanup. It must not hide the export result.
  }
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const serverDir = findServerRoot(path.dirname(fileURLToPath(import.meta.url)));
  const envBefore = Boolean(process.env.MONGO_URL || process.env.MONGODB_URI);
  if (serverDir) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const source = !uri ? "missing" : envBefore ? "process environment" : "server .env file";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset for this shell and the server .env file. No database was opened.");
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
    const report = await readGiniMappingExport(mongoose.connection.db);
    const output = {
      readOnly: true,
      purpose: "gini-mapping-identity-export",
      operations: ["listCollections", "find", "aggregate"],
      writes: [],
      liveTreeChecked: false,
      savedIsNotLiveValidation: true,
      catalogCollectionsUsed: false,
      identity: "category en|ar|ku + subcategory en|ar|ku + collection en|ar|ku",
      connectionSource: source,
      database: {
        protocol: target.protocol,
        host: target.host,
        name: target.database,
        loopback: target.loopback,
      },
      ...report,
    };
    if (target.loopback) {
      console.error("Database host is loopback. Keep this result only when this shell is the production server.");
    }
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } catch (err) {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    process.exitCode = 3;
  } finally {
    await finishConnection(mongoose.connection);
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(`Database read failed: ${sanitizeText(err?.message || err)}`);
    if (!process.exitCode) process.exitCode = 3;
  });
}
