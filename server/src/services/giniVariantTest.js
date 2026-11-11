import mongoose from "mongoose";
import { Product } from "../models/Product.js";
import { GiniVariantTestOperation } from "../models/GiniVariantTestOperation.js";
import { fetchGiniCategoryTree, performGiniRequest, resolveGiniConfig } from "./giniConnection.js";
import { assessGiniMerchantIdentity } from "./giniSkuCreate.js";
import { findExistingGiniProduct } from "./giniSkuLookup.js";
import { buildGiniCreateForm, downloadGiniProductImage } from "./giniSyncOne.js";
import { mappingFromTree } from "../utils/giniSyncEvaluate.js";
import { loadEligibilityContext, taxonomyValuesForProduct } from "../utils/platformTaxonomy.js";
import {
  GINI_COLOR_ATTRIBUTE_PATH,
  GINI_VARIANT_TEST_PARENT_SKU,
  GINI_VARIANT_TEST_PRODUCT_ID,
  GINI_VARIANT_TEST_VARIATIONS,
  buildVariantStagePlan,
  buildVariantTestPreview,
  executeVariantRecovery,
  giniVariantTestWritesEnabled,
  localOwnersBySku,
  variantTestMessage,
  variantTestSkuKey,
} from "../utils/giniVariantTestContract.js";
import {
  GINI_VARIANT_TEST_OPERATION_KEY,
  executeStageA,
  executeStageB,
} from "../utils/giniVariantTestStages.js";

function absentRemote() {
  return { exists: false };
}

async function defaultLoadProduct(productId) {
  if (!mongoose.isValidObjectId(productId)) return null;
  return Product.findById(productId).lean();
}

async function defaultLocalProducts(skus) {
  const clauses = [{ itemCode: /^75244/i }];
  for (const sku of skus) {
    const exact = new RegExp(`^${String(sku).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    clauses.push(
      { itemCode: exact },
      { "overrides.sku": exact },
      { "variants.sku": exact },
      { "variants.itemCode": exact },
      { "variants.barcode": exact },
      { "variants.sizes.sku": exact },
      { "variants.sizes.itemCode": exact },
      { "variants.sizes.barcode": exact }
    );
  }
  return Product.find({ $or: clauses })
    .select("_id itemCode variants overrides.sku")
    .lean();
}

async function defaultMapping(product) {
  const context = await loadEligibilityContext("gini");
  const saved = taxonomyValuesForProduct(product, context) || {};
  try {
    const live = await fetchGiniCategoryTree();
    if (live?.connectionRequired) return { saved, blockers: ["connection_required"], category: null, subcategory: null };
    const mapped = mappingFromTree(saved, live.categories);
    return { ...mapped, saved };
  } catch {
    return { saved, blockers: ["categories_unavailable"], category: null, subcategory: null };
  }
}

async function defaultAttribute(perform) {
  const response = await perform({ method: "GET", path: GINI_COLOR_ATTRIBUTE_PATH });
  if (response?.status !== 200) return null;
  return response.json?.data || response.json;
}

export async function previewGiniVariantTest({ productId } = {}, deps = {}) {
  const writesEnabled = giniVariantTestWritesEnabled(deps.env || process.env);
  const loadProduct = deps.loadProduct || defaultLoadProduct;
  const product = await loadProduct(productId || GINI_VARIANT_TEST_PRODUCT_ID);
  if (!product) {
    return {
      ok: false,
      canSend: false,
      readyForLiveTest: false,
      writesEnabled,
      sentToGini: 0,
      productId: String(productId || ""),
      blockers: ["variant_test_product_mismatch"],
      blockerMessages: [variantTestMessage("variant_test_product_mismatch")],
      parent: null,
      variants: null,
      preservedSourceImages: [],
    };
  }
  const skus = [GINI_VARIANT_TEST_PARENT_SKU, ...GINI_VARIANT_TEST_VARIATIONS.map((row) => row.sku)];
  const products = deps.localProducts ? await deps.localProducts(skus) : await defaultLocalProducts(skus);
  const localOwners = localOwnersBySku([product, ...(products || [])], skus);
  const perform = deps.perform || performGiniRequest;
  const remoteBySku = {};
  let merchantMatches = false;
  let connectionBlocker = "";
  if (deps.merchantMatches != null) {
    merchantMatches = deps.merchantMatches === true;
  } else {
    try {
      const config = deps.config || (await resolveGiniConfig());
      merchantMatches = assessGiniMerchantIdentity(config).matches === true;
    } catch {
      connectionBlocker = "connection_required";
      merchantMatches = false;
    }
  }
  if (!connectionBlocker) {
    for (const sku of skus) {
      try {
        remoteBySku[sku] = deps.findExisting ? await deps.findExisting(sku) : await findExistingGiniProduct(sku, perform);
      } catch {
        remoteBySku[sku] = { error: true, failure: "error" };
      }
    }
  } else {
    for (const sku of skus) remoteBySku[sku] = { error: true, failure: "connection" };
  }
  let attribute = null;
  if (!connectionBlocker) {
    try {
      attribute = deps.attribute || (await defaultAttribute(perform));
    } catch {
      attribute = null;
    }
  }
  const mapping = deps.mapping || (await defaultMapping(product));
  const preview = buildVariantTestPreview({
    product,
    localOwners,
    remoteBySku,
    attribute,
    mapping,
    merchantMatches,
    writesEnabled,
  });
  if (connectionBlocker && !preview.blockers.includes(connectionBlocker)) {
    preview.blockers = [...preview.blockers, connectionBlocker];
    preview.blockerMessages = preview.blockers.map(variantTestMessage);
    preview.ok = false;
    preview.canSend = false;
    preview.readyForLiveTest = false;
  }
  let imageFiles = [];
  if (deps.loadImageBytes && preview.parent) {
    try {
      imageFiles = await deps.loadImageBytes(preview.parent.fields.filter((field) => field.type === "file"));
    } catch {
      imageFiles = [];
    }
  }
  let operation = null;
  if (deps.operation) {
    try {
      operation = await deps.operation.read();
    } catch {
      operation = { status: "operation_unreadable" };
    }
  }
  preview.imageFiles = imageFiles.map((file) => ({
    color: file.color || "",
    byteLength: Number(file.byteLength) || 0,
    verified: file.verified === true,
    filename: file.filename || "",
  }));
  preview.operationStatus = operation?.status || "idle";
  preview.stagePlan = buildVariantStagePlan({
    blockers: preview.blockers,
    requestReady: Boolean(preview.parent && preview.variants),
    parentState: preview.parentRemoteState,
    imageFiles,
    operation,
  });
  return preview;
}

const OPERATION_PATCH_KEYS = ["status", "lastCode", "httpStatus", "sanitizedSnippet", "requestId", "parentQuantity", "parentVisibility"];

function operationFields(patch) {
  const next = {};
  for (const key of OPERATION_PATCH_KEYS) {
    if (patch?.[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

export function mongoVariantTestOperation(Model = GiniVariantTestOperation) {
  return {
    async read() {
      return Model.findOne({ operationKey: GINI_VARIANT_TEST_OPERATION_KEY }).lean();
    },
    async claim(from, to, patch) {
      await Model.collection.createIndex({ operationKey: 1 }, { unique: true });
      const fields = operationFields({ ...patch, status: to });
      const updated = await Model.findOneAndUpdate(
        { operationKey: GINI_VARIANT_TEST_OPERATION_KEY, status: { $in: from.filter((status) => status !== "idle") } },
        { $set: { ...fields, productId: GINI_VARIANT_TEST_PRODUCT_ID, parentSku: GINI_VARIANT_TEST_PARENT_SKU } },
        { new: true }
      ).lean();
      if (updated) return updated;
      if (!from.includes("idle")) return null;
      const existing = await Model.findOne({ operationKey: GINI_VARIANT_TEST_OPERATION_KEY }).select("_id").lean();
      if (existing) return null;
      try {
        const created = await Model.create({
          operationKey: GINI_VARIANT_TEST_OPERATION_KEY,
          productId: GINI_VARIANT_TEST_PRODUCT_ID,
          parentSku: GINI_VARIANT_TEST_PARENT_SKU,
          ...fields,
        });
        return created.toObject();
      } catch (err) {
        if (err?.code === 11000) return null;
        throw err;
      }
    },
    async update(patch) {
      return Model.findOneAndUpdate(
        { operationKey: GINI_VARIANT_TEST_OPERATION_KEY },
        { $set: operationFields(patch) },
        { new: true }
      ).lean();
    },
  };
}

export async function loadVariantTestImageBytes(fields = []) {
  const files = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const downloaded = await downloadGiniProductImage(field.publicUrl, index);
    const byteLength = Number(downloaded?.blob?.size) || 0;
    if (!byteLength) {
      const error = new Error("image bytes missing");
      error.code = "image_bytes_missing";
      throw error;
    }
    files.push({
      key: field.key,
      color: field.color,
      sourceUrl: field.sourceUrl,
      byteLength,
      verified: true,
      blob: downloaded.blob,
      filename: downloaded.filename,
    });
  }
  return files;
}

function variantForm(fields, files) {
  const form = new FormData();
  const byKey = new Map(files.map((file) => [file.key, file]));
  for (const field of fields) {
    if (field.type === "file") {
      const file = byKey.get(field.key);
      form.append(field.key, file.blob, file.filename);
    } else {
      form.append(field.key, field.value);
    }
  }
  return form;
}

function refused(code) {
  return { ok: false, sent: false, verified: false, code, message: variantTestMessage(code), writeMethods: [], operationStatus: "" };
}

export async function runGiniVariantTestStage({ stage, productId, confirm = false, acceptUnprovenVariantSkuUniqueness = false } = {}, deps = {}) {
  const writesEnabled = giniVariantTestWritesEnabled(deps.env || process.env);
  if (String(productId || "") !== GINI_VARIANT_TEST_PRODUCT_ID) return refused("variant_test_product_mismatch");
  if (!writesEnabled) return refused("variant_test_writes_disabled");
  if (stage === "parent" && confirm !== true) return refused("stage_a_confirm_required");
  if (stage === "variants" && confirm !== true) return refused("stage_b_confirm_required");
  if (stage === "variants" && acceptUnprovenVariantSkuUniqueness !== true) return refused("uniqueness_acknowledgement_required");
  if (stage !== "parent" && stage !== "variants") return refused("stage_not_ready");

  const operation = deps.operation || mongoVariantTestOperation();
  const preview = await previewGiniVariantTest({ productId }, { ...deps, env: deps.env || process.env, operation, loadImageBytes: deps.loadImageBytes || loadVariantTestImageBytes });
  const hard = (preview.blockers || []).filter((code) => code !== "variant_sku_uniqueness_unproven");
  const record = await operation.read();
  const status = record?.status || "idle";
  const inspection = stage === "parent"
    ? ["parent_in_progress", "parent_uncertain"].includes(status)
    : ["variants_in_progress", "variants_uncertain", "variants_verified"].includes(status);
  if (hard.length && !inspection) return { ...refused(hard[0]), operationStatus: status };
  const fields = stage === "parent" ? preview.parent?.fields || [] : preview.variants?.fields || [];
  if (!fields.length && !inspection) return { ...refused("stage_not_ready"), operationStatus: status };
  let imageFiles = [];
  if (!inspection) {
    try {
      imageFiles = await (deps.loadImageBytes || loadVariantTestImageBytes)(fields.filter((field) => field.type === "file"));
    } catch {
      return { ...refused("image_bytes_missing"), operationStatus: status };
    }
    if (imageFiles.length !== 3) return { ...refused("image_bytes_missing"), operationStatus: status };
  }
  const perform = deps.perform || performGiniRequest;
  const logs = [];
  const log = (entry) => {
    logs.push(entry);
    console.info(JSON.stringify({ scope: "gini-variant-test", stage, ...entry }));
  };
  const result = stage === "parent"
    ? await executeStageA({
        productId,
        confirm,
        writesEnabled,
        parentFields: fields,
        imageFiles,
        operation,
        perform,
        log,
        buildForm: async () => buildGiniCreateForm(preview.parent.payload, imageFiles),
      })
    : await executeStageB({
        productId,
        confirm,
        acceptUnprovenVariantSkuUniqueness,
        writesEnabled,
        variantFields: fields,
        imageFiles,
        operation,
        perform,
        log,
        buildForm: async () => variantForm(fields, imageFiles),
      });
  return {
    ...result,
    message: variantTestMessage(result.code),
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    parentSku: GINI_VARIANT_TEST_PARENT_SKU,
    sanitizedResponses: logs,
    syncStateChanged: false,
  };
}

export async function sendGiniVariantTest({ productId, confirm = false } = {}, deps = {}) {
  const env = deps.env || process.env;
  if (!giniVariantTestWritesEnabled(env)) {
    return { ok: false, sent: false, verified: false, code: "variant_test_writes_disabled", writeMethods: [] };
  }
  if (confirm !== true) {
    return { ok: false, sent: false, verified: false, code: "confirm_required", writeMethods: [] };
  }
  const preview = await previewGiniVariantTest({ productId }, { ...deps, env });
  if (!preview.canSend) {
    return {
      ok: false,
      sent: false,
      verified: false,
      code: preview.blockers[0] || "variant_sku_uniqueness_unproven",
      writeMethods: [],
    };
  }
  const perform = deps.perform || performGiniRequest;
  const writeMethods = [];
  const guarded = async (request) => {
    const method = String(request?.method || "GET").toUpperCase();
    if (method !== "GET") writeMethods.push(method);
    return perform(request);
  };
  const plan =
    preview.recovery?.code === "variants_unread"
      ? { ...preview.recovery, write: true, code: "save_variants_on_existing_parent" }
      : preview.recovery;
  const result = await executeVariantRecovery({
    perform: guarded,
    plan,
    parentFields: preview.parent?.fields || [],
    variantFields: preview.variants?.fields || [],
  });
  return { ...result, sent: writeMethods.length > 0, writeMethods };
}

export { absentRemote, variantTestSkuKey };
