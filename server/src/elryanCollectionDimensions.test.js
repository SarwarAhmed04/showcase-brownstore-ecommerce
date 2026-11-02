import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { fileURLToPath } from "node:url";
import { adminRouter } from "./routes/admin.js";
import { ElryanCollectionDimension } from "./models/ElryanCollectionDimension.js";
import { ElryanConfirmedSend } from "./models/ElryanConfirmedSend.js";
import { ElryanDimensionExclusion } from "./models/ElryanDimensionExclusion.js";
import { ElryanStagingDimensionCheck } from "./models/ElryanStagingDimensionCheck.js";
import { ElryanSyncOnePreview } from "./models/ElryanSyncOnePreview.js";
import { Product } from "./models/Product.js";
import { User } from "./models/User.js";
import {
  getElryanCollectionDimensionDetail,
  listElryanCollectionDimensionCatalog,
  saveElryanCollectionDimension,
  setElryanDimensionExclusion,
} from "./services/elryanCollectionDimensions.js";
import { buildElryanProductPayload } from "./utils/elryanPayloadBuilder.js";
import { elryanOutboundPriceHash } from "./utils/elryanPricing.js";
import {
  resolveElryanDimensions,
  summarizeCollectionDimensionCoverage,
} from "./utils/elryanDimensionResolve.js";
import { elryanDimensionBlockers } from "./utils/elryanStagingGate.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "elryan-collection-dimensions-test-secret";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTO = {
  environment: "staging",
  brownCollectionId: "car-electronic",
  width: 10,
  height: 20,
  depth: 20,
  unit: "cm",
  applyMode: "AUTO_APPLY",
  enabled: true,
  verifiedForCollection: true,
  confirm: true,
  confirmAutoApply: true,
};

function product(collectionId, extra = {}) {
  return {
    collectionName: { _id: collectionId, name: { en: "Car Electronic Accessories" } },
    category: { _id: "automotive", name: { en: "Automotive" } },
    subCategory: { _id: "car-accessories", name: { en: "Car Accessories" } },
    ...extra,
  };
}

describe("Elryan collection dimension resolver", () => {
  const rule = {
    environment: "staging",
    brownCollectionId: "car-electronic",
    width: 10,
    height: 20,
    depth: 20,
    unit: "cm",
    applyMode: "AUTO_APPLY",
    enabled: true,
    verifiedForCollection: true,
  };

  it("auto-applies only the confirmed collection and keeps the source explicit", () => {
    const resolved = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic"),
      collectionRule: rule,
    });
    assert.equal(resolved.source, "COLLECTION_AUTO");
    assert.equal(resolved.confirmed, true);
    assert.equal(resolved.height, 20);
    assert.equal(resolved.width, 10);
    assert.equal(resolved.depth, 20);
    const payload = buildElryanProductPayload({
      resolved: { name: { en: "Sensor" } },
      sku: "SENSOR-1",
      pricing: { proposedElryanPrice: 1000 },
      dimensions: resolved,
      quantity: 1,
    });
    assert.equal(payload.height, 20);
    assert.equal(payload.width, 10);
    assert.equal(payload.depth, 20);
    assert.equal(elryanDimensionBlockers(resolved).length, 0);
  });

  it("does not authorize a suggestion, a disabled rule, a parent category, or another collection", () => {
    const suggested = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic"),
      collectionRule: { ...rule, applyMode: "SUGGEST_REVIEW", verifiedForCollection: false },
    });
    assert.equal(suggested.source, "SUGGESTED");
    assert.equal(suggested.confirmed, false);
    assert.equal(suggested.code, "DIMENSIONS_UNVERIFIED");
    assert.equal(elryanDimensionBlockers(suggested)[0].code, "dimensions_unverified");
    const suggestedPayload = buildElryanProductPayload({
      resolved: { name: { en: "Sensor" } },
      sku: "SENSOR-1",
      dimensions: suggested,
      quantity: 1,
    });
    assert.equal(suggestedPayload.width, undefined);

    const disabled = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic"),
      collectionRule: { ...rule, applyMode: "DISABLED", enabled: false },
    });
    assert.equal(disabled.source, "MISSING");
    assert.equal(disabled.reason, "disabled");

    const parent = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic"),
      collectionRule: { ...rule, brownCollectionId: "automotive" },
    });
    assert.equal(parent.source, "MISSING");
    assert.equal(parent.reason, "missing_mapping");

    const sibling = resolveElryanDimensions({
      environment: "staging",
      product: product("other-collection"),
      collectionRule: rule,
    });
    assert.equal(sibling.source, "MISSING");
  });

  it("gives a verified product override priority and isolates production", () => {
    const override = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic", { collectionName: { _id: "car-electronic", id: "other" } }),
      dimensionRow: {
        environment: "staging",
        unit: "cm",
        width: 7,
        height: 8,
        depth: 9,
        axesConfirmed: true,
      },
      collectionRule: rule,
      excluded: true,
    });
    assert.equal(override.source, "PRODUCT_OVERRIDE");
    assert.equal(override.width, 7);
    assert.equal(override.height, 8);

    const ambiguous = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic", { collectionName: { _id: "car-electronic", id: "other" } }),
      collectionRule: rule,
    });
    assert.equal(ambiguous.source, "MISSING");
    assert.equal(ambiguous.reason, "ambiguous_collection");
    assert.equal(ambiguous.confirmed, false);

    const production = resolveElryanDimensions({
      environment: "production",
      product: product("car-electronic"),
      dimensionRow: {
        environment: "staging",
        unit: "cm",
        width: 7,
        height: 8,
        depth: 9,
        axesConfirmed: true,
      },
      collectionRule: rule,
    });
    assert.equal(production.source, "MISSING");
    assert.equal(production.reason, "production_isolated");
    assert.equal(production.confirmed, false);
  });

  it("rejects invalid dimensions and summarizes coverage without guessing", () => {
    const invalid = resolveElryanDimensions({
      environment: "staging",
      product: product("car-electronic"),
      collectionRule: { ...rule, width: 0 },
    });
    assert.equal(invalid.reason, "invalid_dimensions");
    assert.equal(invalid.confirmed, false);
    const counts = summarizeCollectionDimensionCoverage({
      productCount: 10,
      productOverride: 2,
      excludedOnly: 1,
      ambiguousOnly: 1,
      differs: 1,
      excluded: 2,
      ambiguous: 1,
      rule,
      collectionId: "car-electronic",
    });
    assert.equal(counts.collectionAuto, 6);
    assert.equal(counts.productOverride, 2);
    assert.equal(counts.missing, 2);
    assert.equal(counts.productOverride + counts.collectionAuto + counts.suggested + counts.missing + counts.invalid, 10);
  });

  it("does not write products or call other marketplaces from the dimension service", () => {
    const source = fs.readFileSync(path.join(__dirname, "services/elryanCollectionDimensions.js"), "utf8");
    assert.equal(/miswag|gini|ibsher/i.test(source), false);
    assert.equal(source.includes("elryanRequest"), false);
    assert.equal(source.includes("ElryanConfirmedSend"), false);
    assert.equal(/Product\.(update|findOneAndUpdate|create|delete|bulkWrite)/.test(source), false);
  });
});

describe("Elryan collection dimension storage", () => {
  let memory;
  let server;
  let token;
  let collectionProductId;

  function app() {
    const instance = express();
    instance.use(express.json());
    instance.use("/api/admin", adminRouter);
    return instance;
  }

  async function call(method, urlPath, body) {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json().catch(() => ({}));
    return { status: response.status, json };
  }

  before(async () => {
    memory = await MongoMemoryServer.create();
    await mongoose.connect(memory.getUri("elryan-collection-dimensions"));
    const user = await User.create({
      email: "dimensions@brownstore.test",
      passwordHash: "x",
      role: "admin",
    });
    token = jwt.sign({ sub: user._id.toString(), role: "admin" }, process.env.JWT_SECRET);
    await ElryanCollectionDimension.syncIndexes();
    server = await new Promise((resolve) => {
      const running = app().listen(0, "127.0.0.1", () => resolve(running));
    });
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await memory.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      Product.deleteMany({}),
      ElryanCollectionDimension.deleteMany({}),
      ElryanStagingDimensionCheck.deleteMany({}),
      ElryanDimensionExclusion.deleteMany({}),
      ElryanSyncOnePreview.deleteMany({}),
      ElryanConfirmedSend.deleteMany({}),
    ]);
    const created = await Product.create({
      ibsherId: "ibs-sensor",
      itemCode: "SENSOR-1",
      name: { en: "Car sensor", ar: "حساس" },
      price: 15000,
      category: { _id: "automotive", name: { en: "Automotive" } },
      subCategory: { _id: "car-accessories", name: { en: "Car Accessories" } },
      collectionName: { _id: "car-electronic", name: { en: "Car Electronic Accessories" } },
    });
    collectionProductId = String(created._id);
  });

  it("does not create a rule until the operator confirms, and never creates one for a parent category", async () => {
    const catalog = await listElryanCollectionDimensionCatalog();
    assert.equal(catalog.collections.length, 1);
    assert.equal(catalog.collections[0].rule, null);
    assert.equal(await ElryanCollectionDimension.countDocuments({}), 0);

    const missingConfirm = await call("POST", "/api/admin/platforms/elryan/collection-dimensions", {
      ...AUTO,
      confirm: false,
    });
    assert.equal(missingConfirm.status, 400);
    assert.equal(missingConfirm.json.code, "confirm_required");
    assert.equal(await ElryanCollectionDimension.countDocuments({}), 0);

    const parent = await saveElryanCollectionDimension(
      { ...AUTO, brownCollectionId: "automotive" },
      { email: "dimensions@brownstore.test" }
    ).catch((error) => error);
    assert.equal(parent.code, "collection_not_found");
    const invalid = await saveElryanCollectionDimension(
      { ...AUTO, width: -1 },
      { email: "dimensions@brownstore.test" }
    ).catch((error) => error);
    assert.equal(invalid.code, "invalid_dimensions");
    const production = await saveElryanCollectionDimension(
      { ...AUTO, environment: "production" },
      { email: "dimensions@brownstore.test" }
    ).catch((error) => error);
    assert.equal(production.code, "staging_only");
    const unconfirmedAuto = await saveElryanCollectionDimension(
      { ...AUTO, confirmAutoApply: false },
      { email: "dimensions@brownstore.test" }
    ).catch((error) => error);
    assert.equal(unconfirmedAuto.code, "auto_apply_confirmation_required");
    assert.equal(await ElryanCollectionDimension.countDocuments({}), 0);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);
  });

  it("saves one staging rule, inherits it for a new product, and keeps product overrides and preview tokens safe", async () => {
    const kenwood = await Product.create({
      ibsherId: "ibs-kenwood",
      itemCode: "OWCH180002",
      name: { en: "Kenwood Food Chopper" },
      price: 66250,
      collectionName: { _id: "car-electronic", name: { en: "Car Electronic Accessories" } },
    });
    await ElryanStagingDimensionCheck.create({
      environment: "staging",
      productId: String(kenwood._id),
      sku: "OWCH180002",
      unit: "cm",
      width: 30,
      height: 40,
      depth: 20,
      axesConfirmed: true,
      confirmedAt: new Date(),
    });
    const future = new Date(Date.now() + 10 * 60 * 1000);
    await ElryanSyncOnePreview.create({
      tokenHash: "inherited-token",
      productId: collectionProductId,
      payloadHash: "old-hash",
      readiness: "READY",
      expiresAt: future,
    });
    await ElryanSyncOnePreview.create({
      tokenHash: "kenwood-token",
      productId: String(kenwood._id),
      payloadHash: "kenwood-hash",
      readiness: "READY",
      expiresAt: future,
    });
    const before = await Product.findById(collectionProductId).lean();
    const saved = await call("POST", "/api/admin/platforms/elryan/collection-dimensions", AUTO);
    assert.equal(saved.status, 200);
    assert.equal(saved.json.sentToElryan, 0);
    assert.equal(saved.json.rule.applyMode, "AUTO_APPLY");
    assert.equal(saved.json.rule.confirmedBy, "dimensions@brownstore.test");
    assert.equal(saved.json.invalidation.confirmedSendsUnchanged, true);
    assert.equal(await ElryanCollectionDimension.countDocuments({}), 1);
    const duplicate = await ElryanCollectionDimension.create({
      environment: "staging",
      brownCollectionId: "somewhere-else",
      width: 1,
      height: 1,
      depth: 1,
      unit: "cm",
      applyMode: "DISABLED",
      enabled: false,
    }).then(() => ElryanCollectionDimension.create({
      environment: "staging",
      brownCollectionId: "car-electronic",
      width: 2,
      height: 2,
      depth: 2,
      unit: "cm",
      applyMode: "DISABLED",
      enabled: false,
    })).catch((error) => error);
    assert.equal(duplicate.code, 11000);
    await ElryanCollectionDimension.deleteMany({ brownCollectionId: "somewhere-else" });

    const inheritedToken = await ElryanSyncOnePreview.findOne({ tokenHash: "inherited-token" }).lean();
    const kenwoodToken = await ElryanSyncOnePreview.findOne({ tokenHash: "kenwood-token" }).lean();
    assert.equal(new Date(inheritedToken.expiresAt).getTime(), 0);
    assert.ok(new Date(kenwoodToken.expiresAt).getTime() > Date.now());
    const kenwoodCheck = await ElryanStagingDimensionCheck.findOne({ productId: String(kenwood._id) }).lean();
    assert.equal(kenwoodCheck.width, 30);
    assert.equal(kenwoodCheck.height, 40);
    assert.equal(kenwoodCheck.depth, 20);
    const after = await Product.findById(collectionProductId).lean();
    assert.equal(String(after.updatedAt), String(before.updatedAt));
    assert.equal(after.price, 15000);

    const added = await Product.create({
      ibsherId: "ibs-sensor-2",
      itemCode: "SENSOR-2",
      name: { en: "New sensor" },
      price: 9000,
      collectionName: { _id: "car-electronic", name: { en: "Car Electronic Accessories" } },
    });
    const detail = await getElryanCollectionDimensionDetail("car-electronic");
    assert.equal(detail.counts.productCount, 3);
    assert.equal(detail.counts.productOverride, 1);
    assert.equal(detail.counts.collectionAuto, 2);
    assert.equal(detail.counts.differs, 1);
    const rule = await ElryanCollectionDimension.findOne({ brownCollectionId: "car-electronic" }).lean();
    const inherited = resolveElryanDimensions({
      environment: "staging",
      product: added.toObject(),
      collectionRule: rule,
    });
    assert.equal(inherited.source, "COLLECTION_AUTO");
    assert.equal(inherited.width, 10);
    const kept = resolveElryanDimensions({
      environment: "staging",
      product: kenwood.toObject(),
      dimensionRow: kenwoodCheck,
      collectionRule: rule,
    });
    assert.equal(kept.source, "PRODUCT_OVERRIDE");
    assert.equal(kept.width, 30);

    const oldHash = elryanOutboundPriceHash({ sku: "SENSOR-2", price: 9000 }, { partner: "elryan" });
    const newHash = elryanOutboundPriceHash(
      { sku: "SENSOR-2", price: 9000, width: inherited.width, height: inherited.height, depth: inherited.depth },
      { partner: "elryan" }
    );
    assert.notEqual(oldHash, newHash);
    assert.equal(await ElryanStagingDimensionCheck.countDocuments({ productId: String(added._id) }), 0);
    assert.equal(await ElryanConfirmedSend.countDocuments({}), 0);
  });

  it("excludes a product from inheritance without changing the BrownStore product", async () => {
    await saveElryanCollectionDimension(AUTO, { email: "dimensions@brownstore.test" });
    const before = await Product.findById(collectionProductId).lean();
    const excluded = await setElryanDimensionExclusion(
      {
        environment: "staging",
        productId: collectionProductId,
        sku: "SENSOR-1",
        excluded: true,
        confirm: true,
      },
      { email: "dimensions@brownstore.test" }
    );
    assert.equal(excluded.excluded, true);
    assert.equal(excluded.sentToElryan, 0);
    const rule = await ElryanCollectionDimension.findOne({ brownCollectionId: "car-electronic" }).lean();
    const resolved = resolveElryanDimensions({
      environment: "staging",
      product: before,
      collectionRule: rule,
      excluded: true,
    });
    assert.equal(resolved.reason, "excluded");
    assert.equal(resolved.confirmed, false);
    const after = await Product.findById(collectionProductId).lean();
    assert.equal(String(after.updatedAt), String(before.updatedAt));
    assert.equal(after.price, before.price);
  });
});
