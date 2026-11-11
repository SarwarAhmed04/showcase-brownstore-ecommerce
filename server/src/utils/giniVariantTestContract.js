import { giniCatalogText, giniSkuKey, normalizeGiniItemCode } from "./giniSyncOnePlan.js";
import { publicMediaUrl } from "./commissionExcel.js";

export const GINI_VARIANT_TEST_PRODUCT_ID = "6ae09068b3764a909f69494a";
export const GINI_VARIANT_TEST_IBSHER_ID = "6adf9d38ef43bcf3ec7db6f7";
export const GINI_VARIANT_TEST_VENDOR = "Jawal Flex";
export const GINI_VARIANT_TEST_EXCLUDED_PRODUCT_ID = "6adfa1c9b3764a909f69452a";
export const GINI_VARIANT_TEST_PARENT_SKU = "75244";
export const GINI_VARIANT_TEST_PRICE = 1327000;
export const GINI_VARIANT_TEST_CATEGORY_ID = "3";
export const GINI_VARIANT_TEST_SUBCATEGORY_ID = "3";
export const GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID = "3696";
export const GINI_VARIANT_TEST_COLOR_VALUES = Object.freeze(["Blue", "Black", "Purple"]);
export const GINI_PRODUCTS_PATH = "/api/v2.0/third-party/products";
export const GINI_COLOR_ATTRIBUTE_PATH = "/api/v2.0/third-party/attributes/3696";

/**
 * Save Variants gives each variant its own sku, but the collection has no
 * global variant-SKU lookup. Leave this false until a documented check exists.
 */
export const VARIANT_SKU_GLOBAL_UNIQUENESS_DOCUMENTED = false;

export const GINI_VARIANT_TEST_VARIATIONS = Object.freeze([
  { color: "Blue", sku: "75244-BLUE", stock: 10, sourceVariantId: "6adf9d38ef43bcf3ec7db6f8" },
  { color: "Black", sku: "75244-BLACK", stock: 10, sourceVariantId: "6adf9d38ef43bcf3ec7db6fc" },
  { color: "Purple", sku: "75244-PURPLE", stock: 10, sourceVariantId: "6adf9d38ef43bcf3ec7db6ff" },
]);

const MESSAGES = {
  variant_test_product_mismatch: "This workflow accepts only the Jawal Flex Xiaomi 17T Pro test product.",
  variant_test_vendor_mismatch: "The selected product is not the Jawal Flex listing.",
  variant_test_price_mismatch: "The stored price is not 1,327,000 IQD.",
  variant_test_stock_mismatch: "A variation stock is not the required 10.",
  variant_source_identity_mismatch: "The IBSHER variation ids do not match the three color rows.",
  variant_sku_conflict: "A proposed variant SKU already belongs to a BrownStore or GINI product.",
  variant_sku_uniqueness_unproven: "GINI does not document a way to prove these variant SKUs are unique, so sending is blocked.",
  variant_sku_lookup_incomplete: "A variant SKU lookup did not finish, so uniqueness is not established.",
  parent_lookup_uncertain: "The parent SKU could not be read. No create was sent.",
  parent_sku_mismatch: "The remote product SKU does not match 75244. It was not recreated.",
  remote_variants_not_replaced: "Remote variants are incomplete or include an unrelated row. They were not overwritten.",
  variants_unread: "Existing variants were not read, so nothing was saved.",
  variants_unverified: "The three variants were not all verified. This is not a complete success.",
  parent_create_uncertain: "Parent creation did not return a confirmed product. It was not retried.",
  parent_created_outcome_uncertain: "The parent exists after an uncertain create. It was not recreated.",
  parent_already_exists: "The parent already exists. It was not recreated.",
  color_attribute_mismatch: "GINI Color attribute 3696 did not return Blue, Black, and Purple.",
  category_not_confirmed: "The saved GINI category mapping is not category 3 and subcategory 3.",
  missing_variant_image: "A variation has no image file for the documented variant image field.",
  missing_name: "Missing Arabic or English product name.",
  missing_description: "Missing Arabic description.",
  variant_test_writes_disabled: "The variant-test write gate is off.",
  confirm_required: "Send requires an explicit confirmation after Preview.",
  stage_a_confirm_required: "Stage A requires a separate confirmation to create only the hidden parent.",
  stage_b_confirm_required: "Stage B requires a separate confirmation after the parent has been verified.",
  uniqueness_acknowledgement_required: "Stage B stays closed until the unproven variant-SKU lookup is explicitly acknowledged.",
  image_bytes_missing: "A required image did not load as file bytes, so nothing was uploaded.",
  parent_fields_rejected: "The parent request is not the approved hidden zero-quantity payload. It was not changed or sent.",
  variant_fields_rejected: "The variant request is not the approved three-color payload. It was not sent.",
  parent_create_rejected: "GINI rejected parent creation. Quantity and visibility were not changed, and it was not retried.",
  quantity_zero_rejected: "GINI rejected quantity 0. The value was not changed, and the create was not retried.",
  visibility_value_rejected: "GINI rejected is_visible 0. The value was not changed, and the create was not retried.",
  parent_visible_unexpected: "The parent is visible. Variants were not sent, and the product was not published or hidden by a follow-up write.",
  parent_visibility_unverified: "Parent visibility could not be verified. Variants were not sent.",
  parent_quantity_mismatch: "The parent quantity is not 0. It was not changed, and variants were not sent.",
  operation_in_progress: "A parent or variant write is already recorded as in progress. It was not repeated.",
  operation_uncertain: "An earlier write has an uncertain result. It was not repeated.",
  stage_b_parent_not_verified: "Variants stay closed until the hidden parent has been verified.",
  parent_missing_before_variants: "The parent was not present on the pre-variant read. It was not recreated from Stage B.",
  multipart_upload_failed: "The variant upload failed. It was not retried.",
  stage_not_ready: "This stage is missing required preview data.",
  merchant_not_confirmed: "The stored GINI merchant does not match the verified production connection.",
  connection_required: "Connect GINI API first.",
  duplicate_brownstore_sku: "More than one BrownStore product uses this SKU.",
};

export function giniVariantTestWritesEnabled(env = process.env) {
  return env.GINI_VARIANT_TEST_WRITES_ENABLED === "true" && env.GINI_ALLOW_LIVE_VARIANT_TEST === "true";
}

export function variantTestMessage(code) {
  return MESSAGES[code] || code;
}

export function variantTestSkuKey(value) {
  return giniSkuKey(normalizeGiniItemCode(value));
}

export function vendorLabel(createdBy) {
  if (createdBy == null || createdBy === "") return "";
  if (typeof createdBy === "string" || typeof createdBy === "number") return String(createdBy).trim();
  const name = createdBy.businessName || createdBy.storeName || createdBy.name;
  if (typeof name === "string" || typeof name === "number") return String(name).trim();
  if (name && typeof name === "object") return String(name.en || name.ku || name.ar || "").trim();
  return "";
}

function colorLabel(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  return String(value.en || value.name?.en || value.name || "").trim();
}

function imageUrl(image) {
  if (image == null || image === "") return "";
  if (typeof image === "string") return image.trim();
  return String(image.url || "").trim();
}

/**
 * Duplicate SKU protection stays global. This exception is only the selected
 * Jawal Flex product while IT Lobby is the other owner and is left out.
 */
export function variantTestDuplicateException(productId, ownerIds = []) {
  const selected = String(productId || "");
  const owners = [...new Set((ownerIds || []).map((id) => String(id || "")).filter(Boolean))];
  if (selected !== GINI_VARIANT_TEST_PRODUCT_ID) {
    return { allowed: false, code: "duplicate_brownstore_sku", excludedProductId: "" };
  }
  const others = owners.filter((id) => id !== GINI_VARIANT_TEST_PRODUCT_ID);
  if (!owners.includes(GINI_VARIANT_TEST_PRODUCT_ID) || others.length !== 1 || others[0] !== GINI_VARIANT_TEST_EXCLUDED_PRODUCT_ID) {
    return { allowed: false, code: "duplicate_brownstore_sku", excludedProductId: "" };
  }
  return { allowed: true, code: "", excludedProductId: GINI_VARIANT_TEST_EXCLUDED_PRODUCT_ID };
}

function skuKeysOnProduct(doc) {
  const keys = [];
  const push = (value) => {
    const key = variantTestSkuKey(value);
    if (key) keys.push(key);
  };
  push(doc?.itemCode);
  push(doc?.overrides?.sku);
  for (const variant of doc?.variants || []) {
    push(variant?.sku);
    push(variant?.itemCode);
    push(variant?.barcode);
    for (const size of variant?.sizes || []) {
      push(size?.sku);
      push(size?.itemCode);
      push(size?.barcode);
    }
  }
  return keys;
}

export function localOwnersBySku(products, skus) {
  const wanted = new Set(skus.map((sku) => variantTestSkuKey(sku)));
  const owners = {};
  for (const sku of wanted) owners[sku] = [];
  for (const doc of products || []) {
    const id = String(doc?._id || "");
    if (!id) continue;
    for (const key of new Set(skuKeysOnProduct(doc))) {
      if (wanted.has(key) && !owners[key].includes(id)) owners[key].push(id);
    }
  }
  return owners;
}

function remoteState(found) {
  if (found?.exists === true) return "present";
  if (found?.exists === false && !found.error) return "absent";
  return "uncertain";
}

function selectedImage(variant) {
  const images = Array.isArray(variant?.images) ? variant.images : [];
  const selected = images.find((image) => image?.isMain && imageUrl(image)) || images.find((image) => imageUrl(image));
  const selectedUrl = imageUrl(selected);
  const preserved = images
    .map((image) => imageUrl(image))
    .filter((url) => url && url !== selectedUrl);
  return { selectedUrl, preserved };
}

function variationRows(product) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  return GINI_VARIANT_TEST_VARIATIONS.map((expected) => {
    const source = variants.find((variant) => String(variant?._id || "") === expected.sourceVariantId) || null;
    const sizes = Array.isArray(source?.sizes) ? source.sizes : [];
    const size = sizes[0] || null;
    const images = selectedImage(source);
    return {
      expected,
      source,
      sizeCount: sizes.length,
      size: String(size?.size || ""),
      stock: Number(size?.stockQuantity),
      color: colorLabel(source?.color),
      selectedUrl: images.selectedUrl,
      preserved: images.preserved,
    };
  });
}

export function parentVisibilityPlan() {
  return {
    isVisible: "0",
    remainsHiddenUntilVariantsVerified: true,
    documentedCreateExample: "1",
    documentedProductOffSwitch: "Bulk update accepts is_visible false and says is_visible is for products only.",
    variantRequestHasVisibilityField: false,
    residualRisk:
      "Create Product demonstrates is_visible 1, not 0. A rejected create is not retried. A parent that GINI stores as visible is not recreated and is not treated as verified.",
  };
}

export function buildVariantMultipart(rows) {
  const fields = [{ key: "_method", value: "PUT", type: "text" }];
  rows.forEach((row, index) => {
    fields.push(
      { key: `variants[${index}][sku]`, value: row.sku, type: "text" },
      { key: `variants[${index}][price]`, value: String(GINI_VARIANT_TEST_PRICE), type: "text" },
      { key: `variants[${index}][quantity]`, value: String(row.stock), type: "text" },
      { key: `variants[${index}][attributes][0][attribute_id]`, value: GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID, type: "text" },
      { key: `variants[${index}][attributes][0][value]`, value: row.color, type: "text" },
      {
        key: `variants[${index}][image]`,
        type: "file",
        sourceUrl: row.selectedUrl,
        publicUrl: publicMediaUrl(row.selectedUrl),
        sourceVariantId: row.sourceVariantId,
        color: row.color,
      }
    );
  });
  return {
    method: "PUT",
    path: `${GINI_PRODUCTS_PATH}/${GINI_VARIANT_TEST_PARENT_SKU}/variants`,
    bodyMode: "formdata",
    fields,
  };
}

function parentRequest(text, imageFields) {
  const payload = {
    name: text.name,
    description: text.description,
    sku: GINI_VARIANT_TEST_PARENT_SKU,
    price: GINI_VARIANT_TEST_PRICE,
    quantity: 0,
    security_stock: 0,
    category_id: Number(GINI_VARIANT_TEST_CATEGORY_ID),
    subcategory_id: Number(GINI_VARIANT_TEST_SUBCATEGORY_ID),
    is_visible: 0,
    images: imageFields.map((image) => ({ url: image.publicUrl, sourceUrl: image.sourceUrl, color: image.color })),
  };
  return {
    method: "POST",
    path: GINI_PRODUCTS_PATH,
    bodyMode: "formdata",
    payload,
    fields: [
      { key: "name", value: payload.name, type: "text" },
      { key: "description", value: payload.description, type: "text" },
      { key: "price", value: String(payload.price), type: "text" },
      { key: "quantity", value: "0", type: "text" },
      { key: "security_stock", value: "0", type: "text" },
      { key: "category_id", value: GINI_VARIANT_TEST_CATEGORY_ID, type: "text" },
      { key: "subcategory_id", value: GINI_VARIANT_TEST_SUBCATEGORY_ID, type: "text" },
      { key: "is_visible", value: "0", type: "text" },
      { key: "sku", value: payload.sku, type: "text" },
      ...imageFields.map((image) => ({
        key: "images[]",
        type: "file",
        sourceUrl: image.sourceUrl,
        publicUrl: image.publicUrl,
        sourceVariantId: image.sourceVariantId,
        color: image.color,
      })),
    ],
  };
}

function sameColorValues(values) {
  return Array.isArray(values) && values.length === GINI_VARIANT_TEST_COLOR_VALUES.length && GINI_VARIANT_TEST_COLOR_VALUES.every((value, index) => values[index] === value);
}

function presentId(value) {
  if (value == null || value === "") return "";
  return String(value);
}

/**
 * Reads an attribute id only from fields GINI actually returned.
 * `attributes[].id` and `attributes[].attribute_id` are both accepted.
 * A missing id is never replaced with the expected Color id.
 */
export function explicitRemoteAttributeId(row) {
  const nested = row?.attributes?.[0] && typeof row.attributes[0] === "object" ? row.attributes[0] : null;
  const found = [
    presentId(nested?.attribute_id),
    presentId(nested?.id),
    presentId(row?.attributeId),
    presentId(row?.attribute_id),
  ].filter(Boolean);
  if (!found.length) return "";
  if (new Set(found).size !== 1) return "";
  return found[0];
}

export function classifyRemoteVariants(rows) {
  if (rows == null) return { state: "uncertain", rows: [] };
  if (!Array.isArray(rows)) return { state: "uncertain", rows: [] };
  if (rows.length === 0) return { state: "empty", rows: [] };
  const expected = new Map(GINI_VARIANT_TEST_VARIATIONS.map((row) => [variantTestSkuKey(row.sku), row]));
  const seen = new Set();
  for (const row of rows) {
    const key = variantTestSkuKey(row?.sku);
    const expectedRow = expected.get(key);
    const color = colorLabel(row?.color) || String(row?.value || row?.attributes?.[0]?.value || "").trim();
    const quantity = Number(row?.quantity ?? row?.stock);
    const price = Number(row?.price);
    const attributeId = explicitRemoteAttributeId(row);
    if (
      !expectedRow ||
      seen.has(key) ||
      color !== expectedRow.color ||
      quantity !== expectedRow.stock ||
      price !== GINI_VARIANT_TEST_PRICE ||
      attributeId !== GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID
    ) {
      return { state: "unrelated", rows };
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) return { state: "partial", rows };
  return { state: "match", rows };
}

export function planVariantRecovery({ parent, variants } = {}) {
  const parentState = parent?.state || "uncertain";
  const variantClass = classifyRemoteVariants(variants?.rows === undefined && variants?.state === "empty" ? [] : variants?.rows);
  const variantState = variants?.state === "uncertain" || variants?.state === "unread" ? variants.state : variantClass.state;
  if (parentState === "uncertain") {
    return { write: false, recreateParent: false, verified: false, code: "parent_lookup_uncertain", steps: ["GET parent"] };
  }
  if (parentState === "present" && variantTestSkuKey(parent?.sku || GINI_VARIANT_TEST_PARENT_SKU) !== variantTestSkuKey(GINI_VARIANT_TEST_PARENT_SKU)) {
    return { write: false, recreateParent: false, verified: false, code: "parent_sku_mismatch", steps: ["GET parent"] };
  }
  if (parentState === "absent") {
    return {
      write: true,
      recreateParent: false,
      verified: false,
      code: "create_parent_then_variants",
      steps: ["GET parent", "POST parent", "GET parent", "GET variants", "PUT variants", "GET variants"],
    };
  }
  if (variantState === "uncertain" || variantState === "unread") {
    return { write: false, recreateParent: false, verified: false, code: "variants_unread", steps: ["GET parent", "GET variants"] };
  }
  if (variantState === "partial" || variantState === "unrelated") {
    return { write: false, recreateParent: false, verified: false, code: "remote_variants_not_replaced", steps: ["GET parent", "GET variants"] };
  }
  if (variantState === "match") {
    return { write: false, recreateParent: false, verified: true, code: "variants_verified", steps: ["GET parent", "GET variants"] };
  }
  return {
    write: true,
    recreateParent: false,
    verified: false,
    code: "save_variants_on_existing_parent",
    steps: ["GET parent", "GET variants", "PUT variants", "GET variants"],
  };
}

export function buildVariantTestPreview({
  product,
  localOwners = {},
  remoteBySku = {},
  attribute = null,
  mapping = null,
  merchantMatches = true,
  writesEnabled = false,
  imageFiles = [],
  operation = null,
} = {}) {
  const blockers = [];
  const productId = String(product?._id || "");
  if (
    productId !== GINI_VARIANT_TEST_PRODUCT_ID ||
    String(product?.ibsherId || "") !== GINI_VARIANT_TEST_IBSHER_ID ||
    normalizeGiniItemCode(product?.itemCode) !== GINI_VARIANT_TEST_PARENT_SKU
  ) {
    blockers.push("variant_test_product_mismatch");
  }
  if (vendorLabel(product?.createdBy) !== GINI_VARIANT_TEST_VENDOR) blockers.push("variant_test_vendor_mismatch");
  if (Number(product?.price) !== GINI_VARIANT_TEST_PRICE) blockers.push("variant_test_price_mismatch");

  const parentOwners = localOwners[variantTestSkuKey(GINI_VARIANT_TEST_PARENT_SKU)] || [];
  const duplicate = variantTestDuplicateException(productId, parentOwners);
  if (!duplicate.allowed && parentOwners.length > 0) blockers.push(duplicate.code);
  for (const variation of GINI_VARIANT_TEST_VARIATIONS) {
    const owners = localOwners[variantTestSkuKey(variation.sku)] || [];
    if (owners.length > 0) blockers.push("variant_sku_conflict");
  }

  const rows = variationRows(product);
  const parsed = [];
  const preservedSourceImages = [];
  if (!blockers.includes("variant_test_product_mismatch")) {
    if (Array.isArray(product?.variants) && product.variants.length !== GINI_VARIANT_TEST_VARIATIONS.length) {
      blockers.push("variant_source_identity_mismatch");
    }
    for (const row of rows) {
      if (!row.source || row.color !== row.expected.color || row.sizeCount !== 1) {
        blockers.push("variant_source_identity_mismatch");
        continue;
      }
      if (row.stock !== row.expected.stock) blockers.push("variant_test_stock_mismatch");
      if (!row.selectedUrl) blockers.push("missing_variant_image");
      for (const url of row.preserved) {
        preservedSourceImages.push({
          color: row.expected.color,
          sourceVariantId: row.expected.sourceVariantId,
          sourceUrl: url,
          publicUrl: publicMediaUrl(url),
          assignedTo: null,
        });
      }
      parsed.push({
        color: row.expected.color,
        sku: row.expected.sku,
        stock: row.expected.stock,
        sourceVariantId: row.expected.sourceVariantId,
        selectedUrl: row.selectedUrl,
        size: row.size,
      });
    }
  }

  const attributeBody = attribute?.data || attribute;
  if (!attributeBody || String(attributeBody.id) !== GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID || attributeBody.name !== "Color" || attributeBody.type !== "color" || !sameColorValues(attributeBody.values)) {
    blockers.push("color_attribute_mismatch");
  }
  const savedCategory = String(mapping?.saved?.categoryId || mapping?.category?.id || "");
  const savedSubcategory = String(mapping?.saved?.subcategoryId || mapping?.subcategory?.id || "");
  if (savedCategory !== GINI_VARIANT_TEST_CATEGORY_ID || savedSubcategory !== GINI_VARIANT_TEST_SUBCATEGORY_ID || (mapping?.blockers || []).length > 0) {
    blockers.push("category_not_confirmed");
  }
  if (merchantMatches !== true) blockers.push("merchant_not_confirmed");

  for (const variation of GINI_VARIANT_TEST_VARIATIONS) {
    const remote = remoteBySku[variation.sku] || remoteBySku[variantTestSkuKey(variation.sku)];
    const state = remoteState(remote);
    if (state === "present") blockers.push("variant_sku_conflict");
    if (state === "uncertain") blockers.push("variant_sku_lookup_incomplete");
  }
  const parentRemote = remoteBySku[GINI_VARIANT_TEST_PARENT_SKU] || {};
  if (remoteState(parentRemote) === "uncertain") blockers.push("parent_lookup_uncertain");

  if (!VARIANT_SKU_GLOBAL_UNIQUENESS_DOCUMENTED) blockers.push("variant_sku_uniqueness_unproven");
  const text = giniCatalogText(product || {});
  if (!text.name) blockers.push("missing_name");
  if (!text.description) blockers.push("missing_description");

  const uniqueBlockers = [...new Set(blockers)];
  const requestReady =
    parsed.length === 3 &&
    !["variant_test_product_mismatch", "variant_source_identity_mismatch", "variant_test_stock_mismatch", "missing_variant_image", "variant_test_price_mismatch", "missing_name", "missing_description"].some((code) => uniqueBlockers.includes(code));
  const parent = requestReady
    ? parentRequest(
        text,
        parsed.map((row) => ({
          sourceUrl: row.selectedUrl,
          publicUrl: publicMediaUrl(row.selectedUrl),
          sourceVariantId: row.sourceVariantId,
          color: row.color,
        }))
      )
    : null;
  const variants = requestReady ? buildVariantMultipart(parsed) : null;
  const canSend = requestReady && uniqueBlockers.length === 0 && writesEnabled === true;
  return {
    ok: uniqueBlockers.length === 0,
    canSend,
    readyForLiveTest: canSend,
    writesEnabled: writesEnabled === true,
    sentToGini: 0,
    productId: GINI_VARIANT_TEST_PRODUCT_ID,
    excludedProductId: duplicate.excludedProductId,
    duplicateProtection: {
      globalRule: "duplicate_brownstore_sku",
      globalRuleChanged: false,
      exceptionProductId: duplicate.allowed ? GINI_VARIANT_TEST_PRODUCT_ID : "",
      excludedProductId: duplicate.excludedProductId,
    },
    blockers: uniqueBlockers,
    blockerMessages: uniqueBlockers.map(variantTestMessage),
    parentSku: GINI_VARIANT_TEST_PARENT_SKU,
    parentRemoteState: remoteState(parentRemote),
    price: GINI_VARIANT_TEST_PRICE,
    colorAttribute: {
      id: GINI_VARIANT_TEST_COLOR_ATTRIBUTE_ID,
      name: "Color",
      type: "color",
      values: [...GINI_VARIANT_TEST_COLOR_VALUES],
      valueFormat: "label",
    },
    visibility: parentVisibilityPlan(),
    requestOrder: ["GET parent and variant SKUs", "POST parent while hidden", "GET parent", "PUT variants", "GET variants"],
    parent,
    variants,
    preservedSourceImages,
    recovery: planVariantRecovery({
      parent: {
        state: remoteState(parentRemote),
        sku: parentRemote?.sku || GINI_VARIANT_TEST_PARENT_SKU,
      },
      variants: { state: "unread", rows: null },
    }),
    uniqueness: {
      documented: VARIANT_SKU_GLOBAL_UNIQUENESS_DOCUMENTED,
      withinRequest: "Save Variants uses a separate sku for each variant.",
      globalSearch: "List Variants reads one parent. It does not search variant SKUs across products.",
      globalGuarantee: false,
    },
    stagePlan: buildVariantStagePlan({
      blockers: uniqueBlockers,
      requestReady,
      parentState: remoteState(parentRemote),
      imageFiles,
      operation,
    }),
  };
}

export function buildVariantStagePlan({
  blockers = [],
  requestReady = false,
  parentState = "uncertain",
  imageFiles = [],
  operation = null,
} = {}) {
  const uniqueness = blockers.includes("variant_sku_uniqueness_unproven");
  const hard = blockers.filter((code) => code !== "variant_sku_uniqueness_unproven");
  const imagesOk = imageFiles.length === 3 && imageFiles.every((file) => Number(file?.byteLength) > 0 && file?.verified === true);
  const status = operation?.status || "idle";
  const blocking = ["parent_in_progress", "parent_uncertain", "parent_stopped", "parent_rejected", "variants_in_progress", "variants_uncertain", "operation_unreadable"].includes(status);
  const parentDone = status === "parent_verified" || status === "variants_verified";
  const parentBlockers = [];
  if (!requestReady) parentBlockers.push("stage_not_ready");
  if (hard.length) parentBlockers.push(...hard);
  if (!imagesOk) parentBlockers.push("image_bytes_missing");
  if (parentState === "uncertain") parentBlockers.push("parent_lookup_uncertain");
  if (parentState === "present" || parentDone) parentBlockers.push("parent_already_exists");
  if (blocking) parentBlockers.push(status === "parent_in_progress" ? "operation_in_progress" : "operation_uncertain");
  const variantBlockers = [];
  if (!requestReady) variantBlockers.push("stage_not_ready");
  if (hard.length) variantBlockers.push(...hard);
  if (!imagesOk) variantBlockers.push("image_bytes_missing");
  if (status !== "parent_verified") variantBlockers.push("stage_b_parent_not_verified");
  if (blocking) variantBlockers.push("operation_uncertain");
  return {
    parent: {
      actionable: requestReady && hard.length === 0 && imagesOk && parentState !== "uncertain" && !blocking && !parentDone,
      willCreate: parentState === "absent" && status === "idle",
      blockers: [...new Set(parentBlockers)],
    },
    variants: {
      actionable: requestReady && hard.length === 0 && imagesOk && status === "parent_verified",
      acknowledgementRequired: true,
      uniquenessUnproven: uniqueness,
      blockers: [...new Set(variantBlockers)],
    },
  };
}

function responseData(response) {
  const data = response?.json?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return null;
}

function variantRowsFromResponse(response) {
  if (!response || response.status !== 200) return null;
  if (Array.isArray(response.json)) return response.json;
  if (Array.isArray(response.json?.data)) return response.json.data;
  if (Array.isArray(response.json?.data?.variants)) return response.json.data.variants;
  return null;
}

/**
 * Executes one recovery plan against an injected GINI client.
 * Production send does not call this while uniqueness is unproven.
 */
export async function executeVariantRecovery({ perform, plan, parentFields, variantFields }) {
  const calls = [];
  const request = async (method, path, extra = {}) => {
    calls.push({ method, path });
    return perform({ method, path, ...extra });
  };
  const parentPath = `${GINI_PRODUCTS_PATH}/${encodeURIComponent(GINI_VARIANT_TEST_PARENT_SKU)}`;
  const variantPath = `${parentPath}/variants`;
  if (!plan?.write) {
    return { ok: plan?.verified === true, verified: plan?.verified === true, code: plan?.code || "recovery_blocked", calls, recreateParent: false };
  }
  const current = await request("GET", parentPath);
  const parentExists = current?.status === 200 && variantTestSkuKey(responseData(current)?.sku) === variantTestSkuKey(GINI_VARIANT_TEST_PARENT_SKU);
  if (current?.status !== 200 && current?.status !== 404) {
    return { ok: false, verified: false, code: "parent_lookup_uncertain", calls, recreateParent: false };
  }
  if (plan.code === "create_parent_then_variants" && parentExists) {
    return { ok: false, verified: false, code: "parent_already_exists", calls, recreateParent: false };
  }
  if (plan.code === "create_parent_then_variants" && !parentExists) {
    let created;
    try {
      created = await request("POST", GINI_PRODUCTS_PATH, { fields: parentFields });
    } catch {
      const again = await request("GET", parentPath);
      const existsNow = again?.status === 200;
      return {
        ok: false,
        verified: false,
        code: existsNow ? "parent_created_outcome_uncertain" : "parent_create_uncertain",
        calls,
        recreateParent: false,
      };
    }
    if (created?.status !== 200 && created?.status !== 201) {
      const again = await request("GET", parentPath);
      return {
        ok: false,
        verified: false,
        code: again?.status === 200 ? "parent_created_outcome_uncertain" : "parent_create_uncertain",
        calls,
        recreateParent: false,
      };
    }
  }
  const listed = variantRowsFromResponse(await request("GET", variantPath));
  const before = classifyRemoteVariants(listed);
  if (before.state === "uncertain") {
    return { ok: false, verified: false, code: "variants_unread", calls, recreateParent: false };
  }
  if (before.state === "partial" || before.state === "unrelated") {
    return { ok: false, verified: false, code: "remote_variants_not_replaced", calls, recreateParent: false };
  }
  if (before.state === "match") {
    return { ok: true, verified: true, code: "variants_verified", calls, recreateParent: false };
  }
  let saved;
  try {
    saved = await request("PUT", variantPath, { fields: variantFields });
  } catch {
    return { ok: false, verified: false, code: "variants_unverified", calls, recreateParent: false };
  }
  if (saved?.status !== 200 && saved?.status !== 201) {
    return { ok: false, verified: false, code: "variants_unverified", calls, recreateParent: false };
  }
  const verifiedRows = variantRowsFromResponse(await request("GET", variantPath));
  const after = classifyRemoteVariants(verifiedRows);
  if (after.state !== "match") {
    return { ok: false, verified: false, code: "variants_unverified", calls, recreateParent: false };
  }
  return { ok: true, verified: true, code: "variants_verified", calls, recreateParent: false };
}
