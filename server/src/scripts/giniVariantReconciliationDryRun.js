#!/usr/bin/env node
/**
 * Read-only preview of the GINI variant identity reconciliation.
 *
 * Default: connect, GET the six parents, and print the proposed records.
 * It does not write to MongoDB or GINI.
 *
 *   node src/scripts/giniVariantReconciliationDryRun.js --confirm-production
 *
 * On the verified production host, loopback also needs:
 *   --allow-verified-production-loopback
 *
 * A later apply is a separate command and is not the default.
 *   node src/scripts/giniVariantReconciliationDryRun.js --confirm-production --allow-verified-production-loopback --apply-variant-reconciliation --authorization REGISTER_VERIFIED_GINI_IDENTITIES
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { Commission } from "../models/Commission.js";
import { GiniVariantAttributeContract } from "../models/GiniVariantAttributeContract.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { Product } from "../models/Product.js";
import { performGiniRequest } from "../services/giniConnection.js";
import {
  interpretColorAttribute,
  presentRemoteVariant,
  readRemoteParent,
  readRemoteVariantRows,
} from "../utils/giniVariantChangedPlan.js";
import {
  RECONCILIATION_AUTHORIZATION,
  VERIFIED_VARIANT_PARENTS,
  applyVariantReconciliation,
  explainMultiVariantCount,
  planVariantReconciliation,
} from "../utils/giniVariantReconciliation.js";

const CONFIRM_FLAG = "--confirm-production";
const LOOPBACK_FLAG = "--allow-verified-production-loopback";
const APPLY_FLAG = "--apply-variant-reconciliation";

export function describeMongoTarget(uri) {
  const raw = String(uri || "").trim();
  if (!raw) return { available: false };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { available: false };
  }
  return {
    available: true,
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.host,
    database: decodeURIComponent(parsed.pathname.replace(/^\//, "").split("/")[0] || ""),
    loopback: ["127.0.0.1", "localhost"].includes(parsed.hostname),
  };
}

export function sanitizeText(value) {
  return String(value ?? "")
    .replace(/mongodb(?:\+srv)?:\/\/[^\s'"]+/gi, "mongodb://[redacted]")
    .replace(/\b(password|secret|token|jwt|apikey|api_key|clientsecret)=([^\s&]+)/gi, "$1=[redacted]");
}

function scriptIsMain() {
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
  return entry === fileURLToPath(import.meta.url);
}

async function readOnlyGet(request) {
  const method = String(request?.method || "GET").toUpperCase();
  if (method !== "GET") throw new Error("variant_reconciliation_write_blocked");
  return performGiniRequest({ method: "GET", path: request.path });
}

async function readRemote(sku) {
  const parentPath = `/api/v2.0/third-party/products/${encodeURIComponent(sku)}`;
  const parentResponse = await readOnlyGet({ method: "GET", path: parentPath });
  const parent = readRemoteParent(parentResponse, sku);
  if (parent.state !== "present") return parent;
  const variantResponse = await readOnlyGet({ method: "GET", path: `${parentPath}/variants` });
  const parsed = readRemoteVariantRows(variantResponse);
  if (parsed.state !== "present") return { ...parent, variants: null, state: "uncertain" };
  return { ...parent, variants: parsed.rows.map(presentRemoteVariant) };
}

async function collectionIndexes(model) {
  const exists = await model.db.db.listCollections({ name: model.collection.name }).hasNext();
  if (!exists) return [];
  return model.collection.indexes();
}

async function loadPreview() {
  const attributeResponse = await readOnlyGet({ method: "GET", path: "/api/v2.0/third-party/attributes/3696" });
  const remoteBySku = {};
  for (const parent of VERIFIED_VARIANT_PARENTS) {
    remoteBySku[parent.parentSku] = await readRemote(parent.parentSku);
  }
  const skuList = VERIFIED_VARIANT_PARENTS.map((parent) => parent.parentSku);
  const [products, identities, owners, contracts, rules, multi, indexes] = await Promise.all([
    Product.find({ itemCode: { $in: skuList } }).select("ibsherId itemCode name price variants category subCategory collectionName brand createdBy").lean(),
    GiniVariantIdentity.find({}).lean(),
    GiniVariantParentOwner.find({}).lean(),
    GiniVariantAttributeContract.find({}).lean(),
    Commission.find({ partner: "gini", isActive: { $ne: false } }).lean(),
    Product.aggregate([
      { $project: { itemCode: 1, name: "$name.en", vendorName: "$createdBy.name.en", variantCount: { $size: { $ifNull: ["$variants", []] } } } },
      { $match: { variantCount: { $gte: 2 } } },
    ]),
    Promise.all([
      collectionIndexes(GiniVariantIdentity),
      collectionIndexes(GiniVariantParentOwner),
      collectionIndexes(GiniVariantAttributeContract),
    ]),
  ]);
  const plan = planVariantReconciliation({
    products,
    identities,
    owners,
    contracts,
    indexesByCollection: {
      ginivariantidentities: indexes[0],
      ginivariantparentowners: indexes[1],
      ginivariantattributecontracts: indexes[2],
    },
    remoteBySku,
    colorAttribute: { status: attributeResponse.status, json: attributeResponse.json },
    commissionRules: rules,
  });
  return {
    readOnly: true,
    giniMethods: ["GET"],
    catalog: explainMultiVariantCount(multi.map((row) => ({ ...row, createdBy: { name: row.vendorName } }))),
    colorAttribute: interpretColorAttribute({ status: attributeResponse.status, json: attributeResponse.json }),
    plan,
  };
}

function applyRequested() {
  return process.argv.includes(APPLY_FLAG) && process.argv.includes(RECONCILIATION_AUTHORIZATION);
}

async function applyIfAuthorized(plan) {
  if (!process.argv.includes(APPLY_FLAG)) return { applied: false, code: "dry_run", writes: 0 };
  return applyVariantReconciliation(plan, {
    authorization: applyRequested() ? RECONCILIATION_AUTHORIZATION : "",
    confirm: applyRequested(),
    write: async (record) => {
      const model = record.collection === "ginivariantattributecontracts"
        ? GiniVariantAttributeContract
        : record.collection === "ginivariantparentowners"
          ? GiniVariantParentOwner
          : GiniVariantIdentity;
      const existing = await model.findOne(record.naturalKey).lean();
      if (existing) throw new Error("reconciliation_conflict_appeared");
      await model.updateOne(record.naturalKey, { $setOnInsert: record.after }, { upsert: true });
    },
  });
}

async function main() {
  if (!process.argv.includes(CONFIRM_FLAG)) {
    console.error(`Refusing to connect. Re-run with ${CONFIRM_FLAG} from the production server directory.`);
    process.exitCode = 4;
    return;
  }
  const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  if (fs.existsSync(path.join(serverDir, ".env"))) dotenv.config({ path: path.join(serverDir, ".env") });
  const uri = process.env.MONGO_URL || process.env.MONGODB_URI || "";
  const target = describeMongoTarget(uri);
  if (!uri || !target.available) {
    console.error("MONGO_URL and MONGODB_URI are unset. No database was opened.");
    process.exitCode = 2;
    return;
  }
  if (target.loopback && !process.argv.includes(LOOPBACK_FLAG)) {
    console.error("Refusing loopback database. On the verified production server, re-run with --allow-verified-production-loopback.");
    process.exitCode = 5;
    return;
  }
  mongoose.set("autoIndex", false);
  mongoose.set("autoCreate", false);
  mongoose.set("strictQuery", true);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 1 });
  try {
    const preview = await loadPreview();
    const apply = await applyIfAuthorized(preview.plan);
    process.stdout.write(`${JSON.stringify({
      ...preview,
      apply,
      database: { host: target.host, name: target.database, loopback: target.loopback },
    }, null, 2)}\n`);
    if (process.argv.includes(APPLY_FLAG) && apply.applied !== true && apply.code !== "already_registered") process.exitCode = 6;
  } finally {
    await mongoose.disconnect();
  }
}

if (scriptIsMain()) {
  main().catch((err) => {
    console.error(sanitizeText(err?.message || err));
    if (!process.exitCode) process.exitCode = 3;
  });
}
