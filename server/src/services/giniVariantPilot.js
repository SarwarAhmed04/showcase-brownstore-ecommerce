import { Product } from "../models/Product.js";
import { GiniVariantIdentity } from "../models/GiniVariantIdentity.js";
import { GiniVariantOperation } from "../models/GiniVariantOperation.js";
import { GiniVariantParentOwner } from "../models/GiniVariantParentOwner.js";
import { fetchGiniCategoryTree, performGiniRequest } from "./giniConnection.js";
import { downloadGiniProductImage, buildGiniCreateForm } from "./giniSyncOne.js";
import { listCategorySetup } from "../utils/platformTaxonomy.js";
import { giniCatalogText, giniSkuKey } from "../utils/giniSyncOnePlan.js";
import { publicMediaUrl } from "../utils/commissionExcel.js";
import { buildReusableVariantFields } from "../utils/giniVariantPayload.js";
import { explicitRemoteAttributeId } from "../utils/giniVariantTestContract.js";
import { giniVariantSyncWritesEnabled } from "../utils/giniVariantCatalog.js";
import { clearVariantCatalogCache, loadVariantCatalog, runPreparedVariantStageA, runPreparedVariantStageB } from "./giniVariantSync.js";
import {
  GINI_VARIANT_PILOT_SLOTS,
  buildPilotView,
  classifyPilotRemoteVariants,
  remoteRecordFromGet,
} from "../utils/giniVariantPilot.js";

function parentPath(sku) {
  return `/api/v2.0/third-party/products/${encodeURIComponent(sku)}`;
}

function readOnly(perform) {
  return async (request) => {
    if (String(request?.method || "GET").toUpperCase() !== "GET") {
      throw new Error("pilot_preview_write_blocked");
    }
    return perform(request);
  };
}

async function readRemote(perform, sku) {
  try {
    const parent = await perform({ method: "GET", path: parentPath(sku) });
    if (parent?.status !== 200) return remoteRecordFromGet(parent);
    const variants = await perform({ method: "GET", path: `${parentPath(sku)}/variants` });
    return remoteRecordFromGet(parent, variants);
  } catch {
    return { exists: false, state: "uncertain", status: 0 };
  }
}

function mongoOperation(productId, sku) {
  return {
    async read() {
      return GiniVariantOperation.findOne({ productId }).lean();
    },
    async update(patch) {
      await GiniVariantOperation.updateOne(
        { productId },
        { $set: { productId, parentSku: sku, skuKey: giniSkuKey(sku), ...patch } },
        { upsert: true }
      );
      return GiniVariantOperation.findOne({ productId }).lean();
    },
  };
}

function variantForm(rows, files) {
  const preview = buildReusableVariantFields(rows.map((row) => ({
    sku: row.proposedSku,
    price: row.price,
    stock: row.stock,
    attributeId: row.attributeId,
    value: row.giniColor,
  })));
  const form = new FormData();
  let fileIndex = 0;
  for (const field of preview.fields) {
    if (field.type === "file") {
      const file = files[fileIndex];
      fileIndex += 1;
      if (!file?.blob) {
        const error = new Error("image_bytes_missing");
        error.code = "image_bytes_missing";
        throw error;
      }
      form.append(field.key, file.blob, file.filename);
    } else {
      form.append(field.key, field.value);
    }
  }
  return form;
}

async function defaultImages(rows) {
  const files = [];
  for (let index = 0; index < rows.length; index += 1) {
    const downloaded = await downloadGiniProductImage(publicMediaUrl(rows[index].imageUrl), index);
    const byteLength = Number(downloaded?.blob?.size) || 0;
    if (!byteLength) {
      const error = new Error("image_bytes_missing");
      error.code = "image_bytes_missing";
      throw error;
    }
    files.push({ blob: downloaded.blob, filename: downloaded.filename, byteLength, verified: true });
  }
  return files;
}

function closed(code) {
  return { ok: false, sent: false, sentToGini: 0, code, writeMethods: [], canSend: false, bulkSyncEnabled: false };
}

export async function previewGiniVariantPilot(deps = {}) {
  const perform = readOnly(deps.perform || performGiniRequest);
  const loadCatalog = deps.loadCatalog || loadVariantCatalog;
  const catalog = await loadCatalog({ force: true });
  let categoryCounts = deps.categoryCounts || null;
  if (!deps.categoryCounts && !deps.skipCategoryCounts) {
    try {
      const setup = await listCategorySetup({ partner: "gini", page: 1, limit: 1 });
      categoryCounts = setup.counts || null;
    } catch {
      categoryCounts = null;
    }
  }
  let categories = deps.categories || [];
  let categoriesUnavailable = deps.categoriesUnavailable === true;
  if (!deps.categories && deps.categoriesUnavailable !== true) {
    try {
      const tree = await fetchGiniCategoryTree();
      categories = tree?.categories || [];
      categoriesUnavailable = Boolean(tree?.connectionRequired) || categories.length === 0;
    } catch {
      categoriesUnavailable = true;
      categories = [];
    }
  }
  let attribute = deps.attribute || null;
  if (!deps.attribute) {
    try {
      const response = await perform({ method: "GET", path: "/api/v2.0/third-party/attributes/3696" });
      attribute = response?.status === 200 ? response.json?.data || response.json : null;
    } catch {
      attribute = null;
    }
  }
  const remoteBySku = { ...(deps.remoteBySku || {}) };
  if (!deps.remoteBySku) {
    for (const slot of GINI_VARIANT_PILOT_SLOTS) remoteBySku[slot.parentSku] = await readRemote(perform, slot.parentSku);
  }
  const ids = (catalog.products || []).filter((row) => GINI_VARIANT_PILOT_SLOTS.some((slot) => giniSkuKey(slot.parentSku) === giniSkuKey(row.parentSku))).map((row) => row.productId);
  const texts = { ...(deps.texts || {}) };
  if (!deps.texts && ids.length) {
    const docs = await Product.find({ _id: { $in: ids } }).select("name description").lean();
    for (const doc of docs) {
      const text = giniCatalogText(doc);
      texts[String(doc._id)] = { name: text.name, description: text.description };
    }
  }
  let operations = deps.operations || null;
  if (!operations) operations = await GiniVariantOperation.find({ productId: { $in: ids } }).select("productId status").lean();
  return buildPilotView({
    products: catalog.products || [],
    texts,
    attribute,
    categories,
    categoriesUnavailable,
    remoteBySku,
    operations,
    writesEnabled: giniVariantSyncWritesEnabled(deps.env || process.env),
    categoryCounts,
    catalogSummary: catalog.summary || null,
  });
}

function matchesConfirmed(parent, rows, slot) {
  const state = classifyPilotRemoteVariants(rows, slot.combinations);
  const expected = slot.combinations.reduce((sum, row) => sum + Number(row.stock), 0);
  if (state !== "match" || parent?.visibility !== "hidden" || parent?.quantity !== expected) return false;
  return slot.combinations.every((expectedRow) => rows.some((row) => {
    const price = Number(row?.price);
    return giniSkuKey(row?.sku) === giniSkuKey(expectedRow.proposedSku)
      && Number(row?.quantity) === Number(expectedRow.stock)
      && explicitRemoteAttributeId(row) === String(expectedRow.attributeId)
      && String(row?.attributes?.[0]?.value || row?.value || "").toLowerCase() === String(expectedRow.giniColor).toLowerCase()
      && price === Number(expectedRow.price);
  }));
}

async function persistParent(slot, parent) {
  const doc = await Product.findById(slot.productId).select("createdBy").lean();
  await GiniVariantParentOwner.updateOne(
    { skuKey: giniSkuKey(slot.parentSku) },
    {
      $set: {
        parentSku: slot.parentSku,
        productId: slot.productId,
        vendorId: slot.vendorId || String(doc?.createdBy?._id || ""),
        giniProductId: parent.id || "",
        parentQuantity: 0,
        visibility: "hidden",
        verifiedAt: new Date(),
        status: "verified_remote",
        approvalNote: "Recorded after a GET confirmed the hidden parent. No other vendor listing was merged.",
      },
    },
    { upsert: true }
  );
  clearVariantCatalogCache();
}

async function persistVerified(slot, parent, rows) {
  const doc = await Product.findById(slot.productId).select("ibsherId createdBy").lean();
  await GiniVariantParentOwner.updateOne(
    { skuKey: giniSkuKey(slot.parentSku) },
    {
      $set: {
        parentSku: slot.parentSku,
        productId: slot.productId,
        vendorId: slot.vendorId || String(doc?.createdBy?._id || ""),
        giniProductId: parent.id || "",
        parentQuantity: parent.quantity,
        visibility: "hidden",
        verifiedAt: new Date(),
        status: "verified_remote",
        approvalNote: "Recorded after a GET confirmed this parent and its variants. No other vendor listing was merged.",
      },
    },
    { upsert: true }
  );
  for (const expected of slot.combinations) {
    const remote = rows.find((row) => giniSkuKey(row?.sku) === giniSkuKey(expected.proposedSku));
    await GiniVariantIdentity.updateOne(
      { productId: slot.productId, sourceVariantId: expected.sourceVariantId, sourceSizeId: expected.sourceSizeId || "" },
      {
        $set: {
          ibsherId: String(doc?.ibsherId || ""),
          vendorId: String(doc?.createdBy?._id || ""),
          parentSku: slot.parentSku,
          parentSkuKey: giniSkuKey(slot.parentSku),
          proposedSku: expected.proposedSku,
          proposedSkuKey: giniSkuKey(expected.proposedSku),
          approvedSku: expected.proposedSku,
          approvedSkuKey: giniSkuKey(expected.proposedSku),
          confirmedGiniVariantId: String(remote?.id || ""),
          attributeId: expected.attributeId,
          attributeName: "Color",
          attributeValue: expected.giniColor,
          lastVerifiedQuantity: Number(expected.stock),
          lastVerifiedPrice: Number(expected.price),
          lastVerifiedAt: new Date(),
          status: "verified",
          approvalNote: "Confirmed by a GET of the GINI variant. No further write was sent.",
        },
      },
      { upsert: true }
    );
  }
  clearVariantCatalogCache();
}

export async function runGiniVariantPilotStage({ productId, stage, confirm = false } = {}, deps = {}) {
  if (confirm !== true) return closed("approval_required");
  if (stage !== "parent" && stage !== "variants") return closed("stage_not_ready");
  const preview = deps.preview || await previewGiniVariantPilot(deps);
  const requested = String(productId || "");
  const slot = (preview.products || []).find((item) => item.productId === requested || (item.candidates || []).some((candidate) => candidate.productId === requested));
  if (!slot) return closed("not_in_pilot");
  if (!slot.productId || slot.productId !== requested) return closed(slot.ownerRequired ? "duplicate_parent_sku" : "not_in_pilot");
  const operationUncertain = ["parent_uncertain", "parent_in_progress"].includes(slot.operationStatus);
  const recoverParent = stage === "parent"
    && operationUncertain
    && slot.remote?.state === "present"
    && slot.remote.visibility === "hidden"
    && slot.remote.quantity === 0
    && (slot.blockers || []).every((code) => code === "parent_uncertain" || code === "parent_in_progress");
  if ((slot.queue === "stopped" || slot.blockers?.some((code) => ["parent_lookup_uncertain", "variants_unread", "parent_uncertain", "variants_uncertain", "parent_in_progress", "variants_in_progress"].includes(code))) && !recoverParent) {
    return closed("pilot_stopped_uncertain");
  }
  if (slot.queue !== "next" && !recoverParent) return closed(slot.queueCode || "pilot_waiting_for_previous");
  const env = deps.env || process.env;
  if (!giniVariantSyncWritesEnabled(env)) return closed("variant_sync_writes_disabled");
  const parentTurn = stage === "parent" && !["parent_verified", "variants_verified"].includes(slot.operationStatus);
  const variantTurn = stage === "variants" && slot.operationStatus === "parent_verified";
  if (stage === "parent" && !parentTurn) return closed("stage_not_ready");
  if (stage === "variants" && !variantTurn) return closed("stage_b_parent_not_verified");
  if (slot.blockers?.length && !recoverParent) return closed(slot.blockers[0]);

  const perform = deps.perform || performGiniRequest;
  const operation = deps.operation ? deps.operation(slot.productId, slot.parentSku) : mongoOperation(slot.productId, slot.parentSku);
  const rows = slot.combinations || [];
  let form = null;
  if ((stage === "parent" && slot.remote?.state === "absent") || stage === "variants") {
    const withImages = deps.imageRows ? await deps.imageRows(slot) : await rowsFromProduct(slot);
    if (withImages.some((row) => !row.imageUrl)) return closed("image_bytes_missing");
    let files;
    try {
      files = deps.loadImages ? await deps.loadImages(withImages) : await defaultImages(withImages);
    } catch {
      return closed("image_bytes_missing");
    }
    if (!files || files.length !== withImages.length || files.some((file) => !file?.blob || !(file.byteLength > 0))) return closed("image_bytes_missing");
    if (stage === "parent") {
      form = buildGiniCreateForm({
        name: slot.name,
        description: slot.description,
        sku: slot.parentSku,
        price: rows[0].price,
        quantity: 0,
        security_stock: 0,
        category_id: slot.categoryId,
        subcategory_id: slot.subcategoryId,
        is_visible: 0,
      }, files);
    } else {
      try {
        form = variantForm(withImages, files);
      } catch {
        return closed("image_bytes_missing");
      }
    }
  }

  const result = stage === "parent"
    ? await runPreparedVariantStageA({ sku: slot.parentSku, approved: true, writesEnabled: true, env, perform, operation, form })
    : await runPreparedVariantStageB({
        sku: slot.parentSku,
        approvedRows: rows.map((row) => ({ sku: row.proposedSku, stock: row.stock, attributeId: row.attributeId })),
        approved: true,
        writesEnabled: true,
        env,
        perform,
        operation,
        form,
      });
  if (!result.ok) return { ...closed(result.code), sent: result.sent === true, sentToGini: result.sent === true ? 1 : 0, writeMethods: result.writeMethods || [] };

  let confirmedParent;
  let confirmedRows = [];
  try {
    const parentResponse = await perform({ method: "GET", path: parentPath(slot.parentSku) });
    const variantResponse = await perform({ method: "GET", path: `${parentPath(slot.parentSku)}/variants` });
    confirmedParent = remoteRecordFromGet(parentResponse, variantResponse);
    confirmedRows = Array.isArray(variantResponse?.json?.data) ? variantResponse.json.data : [];
  } catch {
    await operation.update({ status: stage === "parent" ? "parent_uncertain" : "variants_uncertain", lastCode: "pilot_confirmation_uncertain" });
    return { ...closed("pilot_stopped_uncertain"), sent: result.sent === true, sentToGini: result.sent === true ? 1 : 0, writeMethods: result.writeMethods || [] };
  }
  const parentOk = stage === "parent"
    ? confirmedParent.state === "present" && confirmedParent.visibility === "hidden" && confirmedParent.quantity === 0 && giniSkuKey(confirmedParent.sku) === giniSkuKey(slot.parentSku)
    : matchesConfirmed(confirmedParent, confirmedRows, slot);
  if (!parentOk) {
    await operation.update({ status: stage === "parent" ? "parent_uncertain" : "variants_uncertain", lastCode: "pilot_confirmation_uncertain" });
    return { ...closed("pilot_stopped_uncertain"), sent: result.sent === true, sentToGini: result.sent === true ? 1 : 0, writeMethods: result.writeMethods || [] };
  }
  if (deps.persist !== false && stage === "parent") await persistParent(slot, confirmedParent);
  if (stage === "variants" && deps.persist !== false) await persistVerified(slot, confirmedParent, confirmedRows);
  return {
    ok: true,
    sent: result.sent === true,
    sentToGini: result.sent === true ? 1 : 0,
    code: result.code,
    writeMethods: result.writeMethods || [],
    canSend: false,
    bulkSyncEnabled: false,
    productId: slot.productId,
    parentSku: slot.parentSku,
    confirmedBy: "GET",
  };
}

async function rowsFromProduct(slot) {
  const doc = await Product.findById(slot.productId).select("variants").lean();
  return (slot.combinations || []).map((row) => {
    const variant = (doc?.variants || []).find((item) => String(item?._id) === String(row.sourceVariantId));
    const imageUrl = (variant?.images || []).find((image) => image?.url)?.url || "";
    return { ...row, imageUrl };
  });
}
