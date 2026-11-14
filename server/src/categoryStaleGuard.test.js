import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, test } from "node:test";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Category } from "./models/Category.js";
import { CategorySyncAudit } from "./models/CategorySyncAudit.js";
import { CategorySyncHold } from "./models/CategorySyncHold.js";
import { Product } from "./models/Product.js";
import { syncRemoteCategories } from "./utils/categoryCatalogSync.js";
import {
  approveCategoryDeletions,
  CATEGORY_DELETION_APPROVAL,
  planCategoryAbsence,
} from "./utils/categoryStaleGuard.js";

const KEPT = "cat-kept";
const MISSING = "cat-missing";
const USED = "cat-used";

async function reset() {
  await Promise.all([
    Category.deleteMany({}),
    Product.deleteMany({}),
    CategorySyncHold.deleteMany({}),
    CategorySyncAudit.deleteMany({}),
  ]);
}

async function seedCategory(ibsherId, extra = {}) {
  return Category.create({
    ibsherId,
    name: { en: `${ibsherId} source`, ar: "", ku: "" },
    images: [{ url: `https://cdn.example/${ibsherId}.jpg` }],
    displayOrder: 4,
    isActive: true,
    overrides: {
      name: { en: `${ibsherId} shop`, ku: "", ar: "" },
      image: `/media/local/categories/${ibsherId}.jpg`,
    },
    ...extra,
  });
}

before(async () => {
  const memory = await MongoMemoryServer.create();
  await mongoose.connect(memory.getUri());
  globalThis.__categoryGuardMemory = memory;
});

after(async () => {
  await mongoose.disconnect();
  await globalThis.__categoryGuardMemory.stop();
});

test("one omitted category is quarantined and a referenced category is never a deletion candidate", () => {
  const plan = planCategoryAbsence({
    missingIds: [MISSING, USED],
    priorHolds: [],
    remoteTotal: 10,
    localTotal: 12,
    referencedIds: [USED],
  });
  assert.equal(plan.mode, "confirm");
  assert.deepEqual(plan.deleteIds, []);
  assert.equal(plan.quarantine.length, 1);
  assert.equal(plan.referenced.length, 1);
  assert.equal(plan.referenced[0].ibsherId, USED);

  const outage = planCategoryAbsence({
    missingIds: [MISSING],
    priorHolds: [{ ibsherId: MISSING, missingSyncs: 2 }],
    remoteTotal: 2,
    localTotal: 12,
    referencedIds: [],
  });
  assert.equal(outage.mode, "outage");
  assert.deepEqual(outage.quarantine, []);
  assert.deepEqual(outage.deleteIds, []);
});

test("a missing category keeps its id, shop name, local image, and product links", async () => {
  await reset();
  const kept = await seedCategory(KEPT);
  const missing = await seedCategory(MISSING);
  const used = await seedCategory(USED);
  const fillers = [];
  for (let index = 0; index < 9; index += 1) fillers.push(await seedCategory(`cat-fill-${index}`));
  const product = await Product.create({
    ibsherId: "product-1",
    itemCode: "P1",
    name: { en: "Fan" },
    category: { _id: USED, name: { en: "Used" } },
    subCategory: { _id: "sub-1", name: { en: "Fans" } },
    collectionName: { _id: "col-1", name: { en: "Summer" } },
    status: "published",
  });
  const side = mongoose.connection.collection("miswagproductsyncstates");
  await side.insertOne({ productId: String(product._id), externalId: "keep-me" });

  const first = await syncRemoteCategories([
    { _id: KEPT, name: { en: "Renamed source" }, images: [{ url: "https://cdn.example/new.jpg" }], isActive: true },
    ...fillers.map((doc) => ({ _id: doc.ibsherId, name: { en: doc.ibsherId }, isActive: true })),
  ]);
  assert.equal(first.removed, 0);
  assert.equal(first.quarantined, 1);
  assert.equal(first.referenced, 1);

  const keptAfter = await Category.findById(kept._id).lean();
  const missingAfter = await Category.findById(missing._id).lean();
  const usedAfter = await Category.findById(used._id).lean();
  assert.equal(String(keptAfter._id), String(kept._id));
  assert.equal(keptAfter.displayOrder, 4);
  assert.equal(keptAfter.overrides.name.en, `${KEPT} shop`);
  assert.equal(keptAfter.overrides.image, `/media/local/categories/${KEPT}.jpg`);
  assert.equal(keptAfter.name.en, "Renamed source");
  assert.equal(String(missingAfter._id), String(missing._id));
  assert.equal(missingAfter.overrides.image, `/media/local/categories/${MISSING}.jpg`);
  assert.equal(missingAfter.name.en, `${MISSING} source`);
  assert.equal(String(usedAfter._id), String(used._id));
  assert.equal(usedAfter.overrides.name.en, `${USED} shop`);
  const hold = await CategorySyncHold.findOne({ ibsherId: MISSING }).lean();
  assert.equal(hold.missingSyncs, 1);
  assert.equal(hold.approvalState, "quarantine");
  const usedHold = await CategorySyncHold.findOne({ ibsherId: USED }).lean();
  assert.equal(usedHold.approvalState, "referenced");
  const productAfter = await Product.findById(product._id).lean();
  assert.equal(productAfter.category._id, USED);
  assert.equal(productAfter.subCategory._id, "sub-1");
  assert.equal(productAfter.collectionName._id, "col-1");
  assert.equal(await side.countDocuments({ externalId: "keep-me" }), 1);
  const audit = await CategorySyncAudit.findOne({ mode: "confirm" }).lean();
  assert.deepEqual(audit.deleteIds, []);
  assert.equal(audit.removed, 0);
});

test("an inactive feed row and an empty feed do not delete local categories", async () => {
  await reset();
  const local = await seedCategory(KEPT);
  const inactive = await syncRemoteCategories([
    { _id: KEPT, name: { en: "Should not replace" }, isActive: false },
    { _id: "other", name: { en: "Other" }, isActive: true },
  ]);
  assert.equal(inactive.removed, 0);
  const after = await Category.findById(local._id).lean();
  assert.equal(after.name.en, `${KEPT} source`);
  assert.equal(after.overrides.image, `/media/local/categories/${KEPT}.jpg`);
  await assert.rejects(() => syncRemoteCategories([]), /no categories/);
  assert.equal(await Category.countDocuments({ _id: local._id }), 1);
});

test("a short category feed does not advance deletion", async () => {
  await reset();
  await seedCategory(KEPT);
  await seedCategory(MISSING);
  await seedCategory("cat-c");
  await seedCategory("cat-d");
  const outage = await syncRemoteCategories([
    { _id: KEPT, name: { en: "Kept" }, isActive: true },
  ]);
  assert.equal(outage.absenceMode, "outage");
  assert.equal(outage.removed, 0);
  assert.equal(await Category.countDocuments(), 4);
  assert.equal(await CategorySyncHold.countDocuments(), 0);
});

test("a returning category clears its hold and keeps the original id", async () => {
  await reset();
  const missing = await seedCategory(MISSING);
  await seedCategory(KEPT);
  await syncRemoteCategories([{ _id: KEPT, name: { en: "Kept" }, isActive: true }]);
  const back = await syncRemoteCategories([
    { _id: KEPT, name: { en: "Kept" }, isActive: true },
    { _id: MISSING, name: { en: "Back" }, isActive: true },
  ]);
  assert.equal(back.removed, 0);
  assert.equal(back.quarantined, 0);
  assert.equal(await CategorySyncHold.countDocuments({ ibsherId: MISSING }), 0);
  const after = await Category.findById(missing._id).lean();
  assert.equal(String(after._id), String(missing._id));
  assert.equal(after.overrides.image, `/media/local/categories/${MISSING}.jpg`);
  assert.equal(after.name.en, "Back");
});

test("approval cannot delete a referenced category or skip the confirmation phrase", async () => {
  await reset();
  const used = await seedCategory(USED);
  const free = await seedCategory(MISSING);
  await seedCategory(KEPT);
  await seedCategory("cat-also");
  const removedImages = [];
  const feed = [
    { _id: KEPT, name: { en: "Kept" }, isActive: true },
    { _id: "cat-also", name: { en: "Also" }, isActive: true },
  ];
  for (let count = 0; count < 3; count += 1) {
    const result = await syncRemoteCategories(feed);
    assert.equal(result.removed, 0);
  }
  await Product.create({
    ibsherId: "product-used",
    itemCode: "USED",
    name: { en: "Used product" },
    category: { _id: USED },
    status: "published",
  });
  const refused = await approveCategoryDeletions({
    ibsherIds: [USED, MISSING],
    approval: "no",
    removeImage: (image) => removedImages.push(image),
  });
  assert.equal(refused.removed, 0);
  assert.equal(refused.refused, "approval_required");
  const approved = await approveCategoryDeletions({
    ibsherIds: [USED, MISSING],
    approval: CATEGORY_DELETION_APPROVAL,
    removeImage: (image) => removedImages.push(image),
  });
  assert.deepEqual(approved.deleteIds, [MISSING]);
  assert.deepEqual(approved.keptReferenced, [USED]);
  assert.equal(await Category.countDocuments({ _id: used._id }), 1);
  assert.equal(await Category.countDocuments({ _id: free._id }), 0);
  assert.deepEqual(removedImages, [`/media/local/categories/${MISSING}.jpg`]);
  assert.equal(await CategorySyncHold.countDocuments({ ibsherId: USED }), 1);
});

test("category sync has no automatic delete and does not call marketplace clients", () => {
  const admin = fs.readFileSync(new URL("./routes/admin.js", import.meta.url), "utf8");
  const sync = fs.readFileSync(new URL("./utils/categoryCatalogSync.js", import.meta.url), "utf8");
  const guard = fs.readFileSync(new URL("./utils/categoryStaleGuard.js", import.meta.url), "utf8");
  assert.equal(admin.includes("Category.deleteMany"), false);
  assert.equal(sync.includes("deleteMany"), false);
  assert.equal(sync.includes("removeLocalCategoryImage"), false);
  assert.match(guard, /CATEGORY_DELETION_APPROVAL = "DELETE_LOCAL_CATALOG_CATEGORIES"/);
  assert.equal(admin.includes("approveCategoryDeletions"), false);
  assert.equal(CategorySyncHold.schema.options.autoIndex, false);
  assert.equal(CategorySyncHold.schema.options.autoCreate, false);
  assert.equal(CategorySyncAudit.schema.options.autoIndex, false);
  assert.equal(CategorySyncAudit.schema.options.autoCreate, false);
  assert.equal(fs.readFileSync(new URL("./index.js", import.meta.url), "utf8").includes("CategorySync"), false);
  for (const word of ["gini", "miswag", "elryan"]) {
    assert.equal(sync.toLowerCase().includes(word), false, word);
  }
});
