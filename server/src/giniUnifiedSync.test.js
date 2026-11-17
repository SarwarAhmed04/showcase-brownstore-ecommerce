import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Partner } from "./models/Partner.js";
import { Product } from "./models/Product.js";
import { PlatformTaxonomyConfig } from "./models/PlatformTaxonomyConfig.js";
import { GiniSyncSendState } from "./models/GiniSyncSendState.js";
import { GiniVariantIdentity } from "./models/GiniVariantIdentity.js";
import { GiniVariantParentOwner } from "./models/GiniVariantParentOwner.js";
import { normalizeGiniCategories } from "./utils/giniCategoryTree.js";
import { giniSkuKey } from "./utils/giniSyncOnePlan.js";
import { proposeVariantSku } from "./utils/giniVariantCatalog.js";
import { giniUnifiedSyncWritesEnabled } from "./utils/giniUnifiedSyncPlan.js";
import { previewGiniUnifiedSync, resetGiniUnifiedSyncForTests, resumeGiniUnifiedSync, startGiniUnifiedSync } from "./services/giniUnifiedSync.js";

const LIVE_TREE = {
  data: [{ id: 1, name: "Home", slug: "home", is_active: 1, subcategories: [{ id: 10, name: "Blenders", slug: "blenders", is_active: 1 }] }],
};
const CATEGORIES = normalizeGiniCategories(LIVE_TREE).categories;
const COLOR = { attributeId: "3696", name: "Color", values: ["Black", "Blue", "White"] };
const ENV = {
  NODE_ENV: "test",
  GINI_UNIFIED_SYNC_WRITES_ENABLED: "true",
  GINI_ALLOW_LIVE_UNIFIED_SYNC: "true",
  GINI_VARIANT_SYNC_WRITES_ENABLED: "true",
  GINI_ALLOW_LIVE_VARIANT_SYNC: "true",
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

let memory;
let calls;
let remote;

function imageFile() {
  return { blob: new Blob([PNG], { type: "image/png" }), filename: "color.png", byteLength: PNG.length };
}

function parentBody(sku, extra = {}) {
  return {
    id: extra.id,
    sku,
    price: extra.price,
    quantity: extra.quantity,
    is_visible: extra.visible === false ? 0 : 1,
  };
}

async function formEntries(form) {
  const entries = [];
  if (!form?.entries) return entries;
  for (const pair of form.entries()) entries.push(pair);
  return entries;
}

function textFields(entries) {
  const fields = {};
  for (const [key, value] of entries) {
    if (typeof value === "string") fields[key] = value;
  }
  return fields;
}

function installRemote() {
  calls = [];
  remote = new Map();
  remote.set("upd-simple", parentBody("UPD-SIMPLE", { id: "501", price: 6000, quantity: 5, visible: true }));
  remote.set("upd-var", {
    ...parentBody("UPD-VAR", { id: "601", price: 1000, quantity: 7, visible: true }),
    variants: [
      { id: "301", sku: "UPD-VAR-BLACK", price: 750, quantity: 4, attributes: [{ attribute_id: "3696", value: "Black" }] },
      { id: "302", sku: "UPD-VAR-BLUE", price: 1000, quantity: 3, attributes: [{ attribute_id: "3696", value: "Blue" }] },
    ],
  });
}

function skuFromPath(path) {
  const clean = String(path).split("?")[0];
  const marker = "/products/";
  const index = clean.indexOf(marker);
  if (index < 0) return "";
  return decodeURIComponent(clean.slice(index + marker.length).replace(/\/variants$|\/stock$/, ""));
}

async function perform(request) {
  const method = String(request.method || "GET").toUpperCase();
  const path = String(request.path || "");
  calls.push({ method, path, rawBody: request.rawBody || "", form: request.form || null });
  if (method === "GET" && path.endsWith("/attributes/3696")) {
    return { status: 200, json: { data: { id: "3696", name: "Color", values: COLOR.values } } };
  }
  const sku = skuFromPath(path);
  const key = giniSkuKey(sku);
  const current = remote.get(key);
  if (method === "GET" && path.endsWith("/variants")) {
    if (!current) return { status: 404, json: { message: "Product not found." } };
    return { status: 200, json: { data: current.variants || [] } };
  }
  if (method === "GET") {
    if (!current) return { status: 404, json: { message: "Product not found." } };
    return { status: 200, json: { data: { id: current.id, sku: current.sku, price: current.price, quantity: current.quantity, is_visible: current.is_visible } } };
  }
  if (method === "POST") {
    const fields = textFields(await formEntries(request.form));
    const created = {
      id: "701",
      sku: fields.sku,
      price: Number(fields.price),
      quantity: Number(fields.quantity),
      is_visible: Number(fields.is_visible),
      variants: [],
    };
    if (giniSkuKey(fields.sku) === "new-var") created.id = "801";
    remote.set(giniSkuKey(fields.sku), created);
    return { status: 201, json: { data: { id: created.id, sku: created.sku } } };
  }
  if (method === "PUT" && path.endsWith("/variants")) {
    const fields = textFields(await formEntries(request.form));
    const rows = [];
    for (let index = 0; index < 10; index += 1) {
      const child = fields[`variants[${index}][sku]`];
      if (!child) continue;
      rows.push({
        id: String(810 + index),
        sku: child,
        price: Number(fields[`variants[${index}][price]`]),
        quantity: Number(fields[`variants[${index}][quantity]`]),
        attributes: [{ attribute_id: fields[`variants[${index}][attributes][0][attribute_id]`], value: fields[`variants[${index}][attributes][0][value]`] }],
      });
    }
    current.variants = rows;
    return { status: 200, json: { data: rows } };
  }
  if (method === "PUT") {
    const body = JSON.parse(request.rawBody);
    if (Object.hasOwn(body, "is_visible")) throw new Error("visibility write");
    if (body.price != null) current.price = body.price;
    if (body.quantity != null) current.quantity = body.quantity;
    return { status: 200, json: { data: { id: current.id, sku: current.sku, price: current.price, quantity: current.quantity, is_visible: current.is_visible } } };
  }
  if (method === "PATCH") {
    const body = JSON.parse(request.rawBody);
    if (Object.hasOwn(body, "is_visible")) throw new Error("visibility write");
    const row = (current.variants || []).find((item) => String(item.id) === String(body.variant_id));
    if (!row) return { status: 404, json: { message: "missing variant" } };
    if (body.price != null) row.price = body.price;
    if (body.quantity != null) row.quantity = body.quantity;
    return { status: 200, json: { data: row } };
  }
  throw new Error(`unexpected ${method} ${path}`);
}

async function makeProduct(itemCode, variants) {
  return Product.create({
    ibsherId: `ibs-${crypto.randomBytes(4).toString("hex")}`,
    itemCode,
    name: { en: `${itemCode} name`, ar: `${itemCode} اسم`, ku: itemCode },
    description: { en: "English description.", ar: "وصف عربي للمنتج", ku: "وەسف" },
    price: itemCode.startsWith("UPD-VAR") || itemCode.startsWith("NEW-VAR") || itemCode.startsWith("BLOCKED") ? 1000 : 6500,
    discountPrice: 0,
    brand: { _id: "brand-cosrx", name: "COSRX" },
    category: { _id: "cat-beauty", name: { en: "Beauty" } },
    subCategory: { _id: "sub-skin", name: { en: "Skin" } },
    collectionName: { _id: "col-acne", name: { en: "Acne" } },
    isActive: true,
    variants,
  });
}

function simpleVariant(stock = 5) {
  return [{
    _id: new mongoose.Types.ObjectId(),
    color: { en: "white", ar: "", ku: "" },
    images: [{ url: "/uploads/products/simple.webp", isMain: true }],
    sizes: [{ _id: new mongoose.Types.ObjectId(), size: "medium", stockQuantity: stock }],
  }];
}

function colors(itemCode) {
  return ["Black", "Blue"].map((color, index) => ({
    _id: new mongoose.Types.ObjectId(),
    color: { en: color, ar: color, ku: color },
    images: [{ url: `/uploads/products/${itemCode}-${color}.webp`, isMain: true }],
    sizes: [{ _id: new mongoose.Types.ObjectId(), size: "One", stockQuantity: index === 0 ? 4 : 3 }],
  }));
}

async function approveChildren(product) {
  const multipleSizes = false;
  for (const variant of product.variants) {
    for (const size of variant.sizes) {
      const sku = proposeVariantSku(product.itemCode, variant.color.en, size.size, { multipleSizes });
      await GiniVariantIdentity.create({
        productId: String(product._id),
        parentSku: product.itemCode,
        parentSkuKey: giniSkuKey(product.itemCode),
        sourceVariantId: String(variant._id),
        sourceSizeId: String(size._id),
        proposedSku: sku,
        proposedSkuKey: giniSkuKey(sku),
        approvedSku: sku,
        approvedSkuKey: giniSkuKey(sku),
        confirmedGiniVariantId: product.itemCode === "UPD-VAR" ? (variant.color.en === "Black" ? "301" : "302") : "",
        attributeId: "3696",
        attributeName: "Color",
        attributeValue: variant.color.en,
        status: "approved",
      });
    }
  }
}

before(async () => {
  memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
});

after(async () => {
  await mongoose.disconnect();
  await memory.stop();
});

beforeEach(async () => {
  resetGiniUnifiedSyncForTests();
  installRemote();
  await Promise.all([
    Partner.deleteMany({}),
    Product.deleteMany({}),
    PlatformTaxonomyConfig.deleteMany({}),
    GiniSyncSendState.deleteMany({}),
    GiniVariantIdentity.deleteMany({}),
    GiniVariantParentOwner.deleteMany({}),
    mongoose.connection.collection("giniunifiedsyncjobs").deleteMany({}),
    mongoose.connection.collection("giniunifiedsyncitems").deleteMany({}),
  ]);
  await Partner.create({ slug: "gini", name: "Gini", isActive: true });
  await PlatformTaxonomyConfig.create({
    partner: "gini",
    brownCollectionId: "col-acne",
    values: { categoryId: "1", categoryName: "Home", subcategoryId: "10", subcategoryName: "Blenders" },
  });
});

function deps(env = ENV) {
  return {
    env,
    perform,
    categories: CATEGORIES,
    colorContract: COLOR,
    loadImages: async (urls) => urls.map(() => imageFile()),
  };
}

test("production writes stay disabled even when both flags are set", () => {
  assert.equal(giniUnifiedSyncWritesEnabled({ NODE_ENV: "production", GINI_UNIFIED_SYNC_WRITES_ENABLED: "true", GINI_ALLOW_LIVE_UNIFIED_SYNC: "true" }), false);
  assert.equal(giniUnifiedSyncWritesEnabled({ NODE_ENV: "test" }), false);
  assert.equal(process.env.GINI_UNIFIED_SYNC_WRITES_ENABLED, undefined);
});

test("one job creates and updates a simple product and a multi-variant product, and blocks the unsafe product", async () => {
  const createdSimple = await makeProduct("NEW-SIMPLE", simpleVariant());
  const createdVariant = await makeProduct("NEW-VAR", colors("NEW-VAR"));
  const updatedSimple = await makeProduct("UPD-SIMPLE", simpleVariant());
  const updatedVariant = await makeProduct("UPD-VAR", colors("UPD-VAR"));
  const blocked = await makeProduct("BLOCKED-SIZE", [{
    _id: new mongoose.Types.ObjectId(),
    color: { en: "White", ar: "أبيض", ku: "سپی" },
    images: [{ url: "/uploads/products/blocked.webp", isMain: true }],
    sizes: [
      { _id: new mongoose.Types.ObjectId(), size: "small", stockQuantity: 1 },
      { _id: new mongoose.Types.ObjectId(), size: "medium", stockQuantity: 2 },
    ],
  }]);
  await approveChildren(createdVariant);
  await approveChildren(updatedVariant);
  await GiniVariantParentOwner.create({
    skuKey: giniSkuKey("UPD-VAR"),
    parentSku: "UPD-VAR",
    productId: String(updatedVariant._id),
    giniProductId: "601",
    visibility: "visible",
    status: "verified_remote",
    approvalNote: "Excel import reconciled by exact parent SKU.",
  });
  assert.equal(await GiniSyncSendState.countDocuments({ sku: "UPD-SIMPLE" }), 0);

  const preview = await previewGiniUnifiedSync(deps());
  const bySku = Object.fromEntries(preview.job.rows.map((row) => [row.sku, row]));
  assert.equal(bySku["NEW-SIMPLE"].action, "CREATE");
  assert.equal(bySku["NEW-SIMPLE"].flow, "simple");
  assert.equal(bySku["NEW-VAR"].action, "CREATE");
  assert.equal(bySku["NEW-VAR"].flow, "variant");
  assert.equal(bySku["UPD-SIMPLE"].action, "UPDATE");
  assert.equal(bySku["UPD-SIMPLE"].flow, "simple");
  assert.equal(bySku["UPD-VAR"].action, "UPDATE");
  assert.equal(bySku["UPD-VAR"].flow, "variant");
  assert.equal(bySku["BLOCKED-SIZE"].action, "BLOCKED");
  assert.equal(bySku["BLOCKED-SIZE"].reasons.includes("size_attribute_unverified"), true);
  assert.equal(preview.job.create, 2);
  assert.equal(preview.job.update, 2);
  assert.equal(preview.job.blocked, 1);
  assert.equal(preview.sentToGini, 0);
  assert.equal(calls.some((call) => call.method !== "GET"), false);

  const finished = await startGiniUnifiedSync({ confirm: true, previewJobId: preview.job.id }, deps());
  assert.equal(finished.job.status, "completed");
  assert.equal(finished.job.created, 2);
  assert.equal(finished.job.updated, 2);
  assert.equal(finished.productionWritesEnabled, false);

  const posts = calls.filter((call) => call.method === "POST");
  assert.equal(posts.length, 2);
  const simpleForm = textFields(await formEntries(posts.find((call) => true) && posts[0].form));
  const variantForm = textFields(await formEntries(posts[1].form));
  const forms = [simpleForm, variantForm];
  assert.equal(forms.some((fields) => fields.sku === "NEW-SIMPLE" && fields.is_visible === "0"), true);
  assert.equal(forms.some((fields) => fields.sku === "NEW-VAR" && fields.is_visible === "0" && fields.quantity === "0"), true);
  assert.equal(calls.filter((call) => call.method === "PUT" && call.path.endsWith("/variants")).length, 1);
  const simpleUpdate = calls.find((call) => call.method === "PUT" && call.path.includes("UPD-SIMPLE"));
  assert.equal(JSON.parse(simpleUpdate.rawBody).is_visible, undefined);
  assert.equal(JSON.parse(simpleUpdate.rawBody).price, 6500);
  const patch = calls.find((call) => call.method === "PATCH");
  const patchBody = JSON.parse(patch.rawBody);
  assert.equal(patchBody.variant_id, 301);
  assert.equal(patchBody.price, 1000);
  assert.equal(patchBody.is_visible, undefined);
  assert.equal(calls.some((call) => call.path.includes("BLOCKED-SIZE") && call.method !== "GET"), false);
  assert.equal(remote.get("upd-simple").is_visible, 1);
  assert.equal(remote.get("upd-var").is_visible, 1);
  assert.equal(remote.get("new-simple").is_visible, 0);
  assert.equal(remote.get("new-var").is_visible, 0);
  assert.equal(remote.get("upd-var").variants.find((row) => row.sku === "UPD-VAR-BLUE").price, 1000);
  assert.equal(await GiniSyncSendState.countDocuments({ sku: "UPD-SIMPLE", giniProductId: "501" }), 1);
  assert.equal(await GiniSyncSendState.countDocuments({ sku: "NEW-VAR" }), 0);
  void createdSimple;
  void updatedSimple;
  void blocked;

  await Product.updateOne({ itemCode: "UPD-SIMPLE" }, { $set: { price: 9000 } });
  await makeProduct("NEW-IMPORT", simpleVariant());
  const postsBefore = calls.filter((call) => call.method === "POST").length;
  const later = await previewGiniUnifiedSync(deps());
  const laterRows = Object.fromEntries(later.job.rows.map((row) => [row.sku, row]));
  assert.equal(laterRows["NEW-SIMPLE"].action, "UNCHANGED");
  assert.equal(laterRows["NEW-IMPORT"].action, "CREATE");
  assert.equal(laterRows["UPD-SIMPLE"].action, "UPDATE");
  assert.equal(laterRows["BLOCKED-SIZE"].action, "BLOCKED");
  const second = await startGiniUnifiedSync({ confirm: true, previewJobId: later.job.id }, deps());
  assert.equal(second.job.created, 1);
  assert.equal(second.job.updated, 1);
  const createdSkus = [];
  for (const call of calls.filter((entry) => entry.method === "POST")) {
    createdSkus.push(textFields(await formEntries(call.form)).sku);
  }
  assert.equal(createdSkus.filter((sku) => sku === "NEW-SIMPLE").length, 1);
  assert.equal(createdSkus.filter((sku) => sku === "NEW-IMPORT").length, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, postsBefore + 1);
  assert.equal(remote.get("new-import").is_visible, 0);
  assert.equal(remote.get("upd-simple").price, 9000);
  assert.equal(remote.get("upd-simple").is_visible, 1);
});

test("a restarted job reconciles an uncertain create with GET before it retries", async () => {
  await makeProduct("NEW-SIMPLE", simpleVariant());
  let dropped = false;
  const flaky = async (request) => {
    const method = String(request.method || "GET").toUpperCase();
    if (method === "POST" && !dropped) {
      dropped = true;
      calls.push({ method, path: String(request.path || ""), rawBody: "", form: request.form || null });
      const fields = textFields(await formEntries(request.form));
      remote.set(giniSkuKey(fields.sku), {
        id: "901",
        sku: fields.sku,
        price: Number(fields.price),
        quantity: Number(fields.quantity),
        is_visible: Number(fields.is_visible),
        variants: [],
      });
      throw new Error("response dropped");
    }
    return perform(request);
  };
  const preview = await previewGiniUnifiedSync({ ...deps(), perform: flaky });
  const first = await startGiniUnifiedSync({ confirm: true, previewJobId: preview.job.id }, { ...deps(), perform: flaky });
  assert.equal(first.job.uncertain, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  const second = await resumeGiniUnifiedSync({ jobId: first.job.id }, { ...deps(), perform: flaky });
  assert.equal(second.job.created, 1);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(remote.get("new-simple").id, "901");
});
