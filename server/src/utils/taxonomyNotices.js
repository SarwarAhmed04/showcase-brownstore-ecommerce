import { Category } from "../models/Category.js";
import { BrownTaxonomyKnownNode } from "../models/BrownTaxonomyKnownNode.js";
import { PlatformTaxonomyConfig } from "../models/PlatformTaxonomyConfig.js";
import { PlatformTaxonomyNotice } from "../models/PlatformTaxonomyNotice.js";
import { TaxonomyBaseline } from "../models/TaxonomyBaseline.js";
import { PARTNER_SLUGS } from "../models/Partner.js";
import { Product } from "../models/Product.js";
import { isTaxonomyComplete, requiredTaxonomyKeys } from "./platformTaxonomyFields.js";

const BASELINE_KEY = "brown";

function nodeName(name) {
  if (name == null) return "";
  if (typeof name === "string") return name.trim();
  return String(name.en || name.ku || name.ar || "").trim();
}

function joinPath(parts) {
  return parts.map(nodeName).filter(Boolean).join(" → ");
}

function addMember(map, key, value) {
  if (!key || !value) return;
  const set = map.get(key) || new Set();
  set.add(value);
  map.set(key, set);
}

async function bulkUpsert(model, ops) {
  for (let index = 0; index < ops.length; index += 500) {
    await model.bulkWrite(ops.slice(index, index + 500), { ordered: false });
  }
}

async function rememberNodes(nodes, at) {
  if (!nodes.length) return;
  await bulkUpsert(
    BrownTaxonomyKnownNode,
    nodes.map((node) => ({
      updateOne: {
        filter: { scope: node.scope, targetId: node.targetId },
        update: {
          $setOnInsert: {
            scope: node.scope,
            targetId: node.targetId,
            name: node.name,
            path: node.path,
            firstSeenAt: at,
          },
        },
        upsert: true,
      },
    }))
  );
}

export async function listCurrentTaxonomyNodes() {
  const [groups, categories] = await Promise.all([
    Product.aggregate([
      {
        $group: {
          _id: {
            category: { $toString: { $ifNull: ["$category._id", ""] } },
            subcategory: { $toString: { $ifNull: ["$subCategory._id", ""] } },
            collection: { $toString: { $ifNull: ["$collectionName._id", ""] } },
          },
          categoryName: { $first: "$category.name" },
          subcategoryName: { $first: "$subCategory.name" },
          collectionName: { $first: "$collectionName.name" },
        },
      },
    ]).allowDiskUse(true),
    Category.find().select("ibsherId name").lean(),
  ]);

  const nodes = new Map();
  const add = (scope, targetId, name, path) => {
    const id = String(targetId || "").trim();
    if (!id) return;
    const key = `${scope}:${id}`;
    if (nodes.has(key)) return;
    nodes.set(key, {
      scope,
      targetId: id,
      name: nodeName(name) || id,
      path: path || nodeName(name) || id,
    });
  };

  for (const category of categories) {
    add("category", category.ibsherId, category.name, nodeName(category.name));
  }

  const triples = [];
  for (const row of groups) {
    const categoryId = String(row._id?.category || "").trim();
    const subcategoryId = String(row._id?.subcategory || "").trim();
    const collectionId = String(row._id?.collection || "").trim();
    if (categoryId) add("category", categoryId, row.categoryName, nodeName(row.categoryName));
    if (subcategoryId) {
      add(
        "subcategory",
        subcategoryId,
        row.subcategoryName,
        joinPath([row.categoryName, row.subcategoryName])
      );
    }
    if (collectionId) {
      add(
        "collection",
        collectionId,
        row.collectionName,
        joinPath([row.categoryName, row.subcategoryName, row.collectionName])
      );
    }
    triples.push({ categoryId, subcategoryId, collectionId });
  }

  return { nodes: [...nodes.values()], triples };
}

export async function resolveTaxonomyNotices(partnerSlug, triples) {
  const partner = String(partnerSlug || "").toLowerCase();
  if (!requiredTaxonomyKeys(partner).length) return { resolved: 0 };
  const open = await PlatformTaxonomyNotice.find({ partner, status: "open" }).select("_id scope targetId").lean();
  if (!open.length) return { resolved: 0 };

  const snapshot = triples || (await listCurrentTaxonomyNodes()).triples;
  const configs = await PlatformTaxonomyConfig.find({ partner }).select("brownCollectionId values").lean();
  const complete = new Set(
    configs
      .filter((row) => isTaxonomyComplete(partner, row.values))
      .map((row) => String(row.brownCollectionId))
  );
  const collectionsByCategory = new Map();
  const collectionsBySubcategory = new Map();
  for (const row of snapshot) {
    addMember(collectionsByCategory, row.categoryId, row.collectionId);
    addMember(collectionsBySubcategory, row.subcategoryId, row.collectionId);
  }

  const done = [];
  for (const notice of open) {
    let ready = false;
    if (notice.scope === "collection") ready = complete.has(notice.targetId);
    else if (notice.scope === "subcategory") {
      const cols = collectionsBySubcategory.get(notice.targetId);
      ready = Boolean(cols?.size && [...cols].every((id) => complete.has(id)));
    } else if (notice.scope === "category") {
      const cols = collectionsByCategory.get(notice.targetId);
      ready = Boolean(cols?.size && [...cols].every((id) => complete.has(id)));
    }
    if (ready) done.push(notice._id);
  }
  if (!done.length) return { resolved: 0 };
  await PlatformTaxonomyNotice.updateMany(
    { _id: { $in: done }, status: "open" },
    { $set: { status: "resolved", resolvedAt: new Date() } }
  );
  return { resolved: done.length };
}

export async function syncBrownTaxonomyNotices() {
  const { nodes, triples } = await listCurrentTaxonomyNodes();
  if (!nodes.length) return { baseline: false, created: 0, skipped: "empty" };

  const now = new Date();
  const baseline = await TaxonomyBaseline.findOne({ key: BASELINE_KEY }).lean();
  if (!baseline) {
    await rememberNodes(nodes, now);
    await TaxonomyBaseline.updateOne(
      { key: BASELINE_KEY },
      { $setOnInsert: { key: BASELINE_KEY, initializedAt: now, nodeCount: nodes.length } },
      { upsert: true }
    );
    return { baseline: true, created: 0 };
  }

  const known = await BrownTaxonomyKnownNode.find().select("scope targetId").lean();
  const knownKeys = new Set(known.map((row) => `${row.scope}:${row.targetId}`));
  const fresh = nodes.filter((node) => !knownKeys.has(`${node.scope}:${node.targetId}`));
  if (fresh.length) {
    const noticeOps = [];
    for (const node of fresh) {
      for (const partner of PARTNER_SLUGS) {
        noticeOps.push({
          updateOne: {
            filter: { partner, scope: node.scope, targetId: node.targetId },
            update: {
              $setOnInsert: {
                partner,
                scope: node.scope,
                targetId: node.targetId,
                name: node.name,
                path: node.path,
                firstSeenAt: now,
                status: "open",
                resolvedAt: null,
              },
            },
            upsert: true,
          },
        });
      }
    }
    await bulkUpsert(PlatformTaxonomyNotice, noticeOps);
    await rememberNodes(fresh, now);
  }

  for (const partner of PARTNER_SLUGS) await resolveTaxonomyNotices(partner, triples);
  return { baseline: false, created: fresh.length * PARTNER_SLUGS.length };
}

export async function runTaxonomyCheck(task = syncBrownTaxonomyNotices) {
  try {
    await task();
  } catch (err) {
    console.error("Taxonomy notice check failed:", err?.message || err);
  }
}

export async function listOpenTaxonomyNotices(partner) {
  const slug = String(partner || "").toLowerCase();
  const filter = { partner: slug, status: "open" };
  const [notices, count] = await Promise.all([
    PlatformTaxonomyNotice.find(filter).sort({ firstSeenAt: -1 }).limit(100).lean(),
    PlatformTaxonomyNotice.countDocuments(filter),
  ]);
  return {
    count,
    notices: notices.map((row) => ({
      id: String(row._id),
      partner: row.partner,
      scope: row.scope,
      targetId: row.targetId,
      name: row.name || "",
      path: row.path || "",
      firstSeenAt: row.firstSeenAt,
      status: row.status,
    })),
  };
}
