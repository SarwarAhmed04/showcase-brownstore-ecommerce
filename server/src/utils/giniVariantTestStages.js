import {
  GINI_PRODUCTS_PATH,
  GINI_VARIANT_TEST_CATEGORY_ID,
  GINI_VARIANT_TEST_PARENT_SKU,
  GINI_VARIANT_TEST_PRICE,
  GINI_VARIANT_TEST_PRODUCT_ID,
  GINI_VARIANT_TEST_SUBCATEGORY_ID,
  classifyRemoteVariants,
  variantTestSkuKey,
} from "./giniVariantTestContract.js";

export const GINI_VARIANT_TEST_OPERATION_KEY = "jawal-flex-17t-pro-75244";

const PARENT_PATH = `${GINI_PRODUCTS_PATH}/${encodeURIComponent(GINI_VARIANT_TEST_PARENT_SKU)}`;
const VARIANT_PATH = `${PARENT_PATH}/variants`;
const PATCH_KEYS = ["status", "lastCode", "httpStatus", "sanitizedSnippet", "requestId", "parentQuantity", "parentVisibility"];

export function sanitizedGiniResponse(response) {
  return {
    status: Number(response?.status) || 0,
    requestId: String(response?.requestId || "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64),
    snippet: String(response?.safeBodySnippet || "").slice(0, 300),
  };
}

function operationPatch(code, response, extra = {}) {
  const safe = sanitizedGiniResponse(response);
  return {
    lastCode: code,
    httpStatus: safe.status,
    sanitizedSnippet: safe.snippet,
    requestId: safe.requestId,
    ...extra,
  };
}

function allowedPatch(patch) {
  const next = {};
  for (const key of PATCH_KEYS) {
    if (patch?.[key] !== undefined) next[key] = patch[key];
  }
  return next;
}

export function createMemoryVariantOperation() {
  let doc = null;
  return {
    async read() {
      return doc ? { ...doc } : null;
    },
    async claim(from, to, patch) {
      const status = doc?.status || "idle";
      if (!from.includes(status)) return null;
      doc = {
        operationKey: GINI_VARIANT_TEST_OPERATION_KEY,
        productId: GINI_VARIANT_TEST_PRODUCT_ID,
        parentSku: GINI_VARIANT_TEST_PARENT_SKU,
        ...(doc || {}),
        ...allowedPatch({ ...patch, status: to }),
        status: to,
      };
      return { ...doc };
    },
    async update(patch) {
      doc = { ...(doc || {}), ...allowedPatch(patch) };
      return { ...doc };
    },
  };
}

function responseData(response) {
  const data = response?.json?.data;
  if (data && typeof data === "object" && !Array.isArray(data)) return data;
  return null;
}

function visibilityState(value) {
  if (value === 0 || value === false || value === "0" || value === "false") return "hidden";
  if (value === 1 || value === true || value === "1" || value === "true") return "visible";
  return "unverified";
}

export function readParentRecord(response) {
  if (!response) return { state: "uncertain", visibility: "unverified", quantityKnown: false };
  if (response.status === 404) return { state: "absent", visibility: "unverified", quantityKnown: false };
  if (response.status !== 200) return { state: "uncertain", visibility: "unverified", quantityKnown: false };
  const data = responseData(response);
  if (!data || variantTestSkuKey(data.sku) !== variantTestSkuKey(GINI_VARIANT_TEST_PARENT_SKU)) {
    return { state: "uncertain", visibility: "unverified", quantityKnown: false, sku: data?.sku || "" };
  }
  const quantity = Number(data.quantity);
  return {
    state: "present",
    sku: String(data.sku),
    id: data.id == null ? "" : String(data.id),
    quantity,
    quantityKnown: Number.isFinite(quantity),
    visibility: visibilityState(data.is_visible ?? data.isVisible),
  };
}

function variantRowsFromResponse(response) {
  if (!response || response.status !== 200) return null;
  if (Array.isArray(response.json)) return response.json;
  if (Array.isArray(response.json?.data)) return response.json.data;
  if (Array.isArray(response.json?.data?.variants)) return response.json.data.variants;
  return null;
}

function strictVariantState(rows) {
  if (rows == null || !Array.isArray(rows)) return "uncertain";
  return classifyRemoteVariants(rows).state;
}

export function verifiedVariantQuantity(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const total = rows.reduce((sum, row) => sum + Number(row?.quantity ?? row?.stock), 0);
  return Number.isFinite(total) ? total : null;
}

export function parentProblemAfterVariants(record, rows) {
  if (!record || record.state !== "present") return "parent_visibility_unverified";
  if (record.visibility === "visible") return "parent_visible_unexpected";
  if (record.visibility !== "hidden") return "parent_visibility_unverified";
  const expected = verifiedVariantQuantity(rows);
  if (!record.quantityKnown || expected == null || record.quantity !== expected) return "parent_quantity_mismatch";
  return "";
}

function imagesReady(files) {
  return Array.isArray(files) && files.length === 3 && files.every((file) => Number(file?.byteLength) > 0 && file?.verified === true && file?.blob);
}

export function parentFieldsAreSafe(fields = []) {
  const value = (key) => fields.find((field) => field.key === key)?.value;
  return (
    value("sku") === GINI_VARIANT_TEST_PARENT_SKU &&
    value("price") === String(GINI_VARIANT_TEST_PRICE) &&
    value("quantity") === "0" &&
    value("security_stock") === "0" &&
    value("category_id") === GINI_VARIANT_TEST_CATEGORY_ID &&
    value("subcategory_id") === GINI_VARIANT_TEST_SUBCATEGORY_ID &&
    value("is_visible") === "0"
  );
}

export function variantFieldsAreSafe(fields = []) {
  const values = (suffix) => fields.filter((field) => field.key.endsWith(suffix)).map((field) => field.value);
  const files = fields.filter((field) => field.type === "file");
  return (
    fields.some((field) => field.key === "_method" && field.value === "PUT") &&
    JSON.stringify(values("[sku]")) === JSON.stringify(["75244-BLUE", "75244-BLACK", "75244-PURPLE"]) &&
    JSON.stringify(values("[value]")) === JSON.stringify(["Blue", "Black", "Purple"]) &&
    JSON.stringify(values("[quantity]")) === JSON.stringify(["10", "10", "10"]) &&
    JSON.stringify(values("[price]")) === JSON.stringify(["1327000", "1327000", "1327000"]) &&
    values("[attribute_id]").every((item) => item === "3696") &&
    files.length === 3
  );
}

function fieldValue(fields, key) {
  return fields.find((field) => field.key === key)?.value;
}

function rejectionCode(response) {
  const text = `${response?.safeBodySnippet || ""} ${JSON.stringify(response?.json || {})}`.toLowerCase();
  if (text.includes("quantity")) return "quantity_zero_rejected";
  if (text.includes("is_visible") || text.includes("visible")) return "visibility_value_rejected";
  return "parent_create_rejected";
}

function definiteRejection(response) {
  return [400, 422].includes(Number(response?.status));
}

function closed(code, extra = {}) {
  return { ok: false, sent: false, verified: false, code, writeMethods: [], calls: [], ...extra };
}

function parentVerified(record) {
  return record.state === "present" && record.quantityKnown && record.quantity === 0 && record.visibility === "hidden";
}

function parentProblem(record) {
  if (record.visibility === "visible") return "parent_visible_unexpected";
  if (!record.quantityKnown || record.quantity !== 0) return "parent_quantity_mismatch";
  if (record.visibility !== "hidden") return "parent_visibility_unverified";
  return "";
}

export async function executeStageA({
  productId,
  confirm = false,
  writesEnabled = false,
  parentFields = [],
  imageFiles = [],
  operation,
  perform,
  buildForm,
  log = () => {},
} = {}) {
  const calls = [];
  if (String(productId || "") !== GINI_VARIANT_TEST_PRODUCT_ID) return closed("variant_test_product_mismatch");
  if (writesEnabled !== true) return closed("variant_test_writes_disabled");
  if (confirm !== true) return closed("stage_a_confirm_required");
  if (!operation) return closed("operation_uncertain");
  const currentStatus = (await operation.read())?.status || "idle";
  const inspecting = currentStatus === "parent_in_progress" || currentStatus === "parent_uncertain";
  if (!inspecting) {
    if (!parentFieldsAreSafe(parentFields)) return closed("parent_fields_rejected");
    if (fieldValue(parentFields, "quantity") !== "0" || fieldValue(parentFields, "is_visible") !== "0") return closed("parent_fields_rejected");
    if (!imagesReady(imageFiles)) return closed("image_bytes_missing");
  }

  const request = async (method, path, extra = {}) => {
    const verb = String(method || "").toUpperCase();
    if (verb !== "GET" && verb !== "POST") throw new Error("method_blocked");
    calls.push({ method: verb, path });
    const response = await perform({ method: verb, path, ...extra });
    log(sanitizedGiniResponse(response));
    return response;
  };
  const finish = async (code, response, status, extra = {}) => {
    const sent = calls.some((call) => call.method === "POST");
    if (status !== "idle") {
      await operation.update(operationPatch(code, response, { status, parentQuantity: extra.parentQuantity, parentVisibility: extra.parentVisibility }));
    }
    return {
      ok: status === "parent_verified",
      sent,
      verified: status === "parent_verified",
      code,
      writeMethods: calls.filter((call) => call.method !== "GET").map((call) => call.method),
      calls,
      operationStatus: status,
    };
  };

  if (["variants_in_progress", "variants_uncertain", "variants_verified", "parent_stopped"].includes(currentStatus)) {
    return { ...closed(currentStatus === "parent_stopped" ? "parent_visible_unexpected" : "operation_uncertain"), calls };
  }
  if (currentStatus === "parent_in_progress" || currentStatus === "parent_uncertain") {
    const current = await request("GET", PARENT_PATH);
    const record = readParentRecord(current);
    if (parentVerified(record)) return finish("parent_already_exists", current, "parent_verified", { parentQuantity: 0, parentVisibility: "hidden" });
    if (record.state === "present") return finish(parentProblem(record), current, "parent_stopped", { parentQuantity: record.quantity, parentVisibility: record.visibility });
    return finish(currentStatus === "parent_in_progress" ? "operation_in_progress" : "operation_uncertain", current, currentStatus);
  }

  const beforeResponse = await request("GET", PARENT_PATH);
  const before = readParentRecord(beforeResponse);
  if (before.state === "uncertain") return finish("parent_lookup_uncertain", beforeResponse, currentStatus === "idle" ? "idle" : currentStatus);
  if (before.state === "present") {
    if (parentVerified(before)) return finish("parent_already_exists", beforeResponse, "parent_verified", { parentQuantity: 0, parentVisibility: "hidden" });
    return finish(parentProblem(before), beforeResponse, "parent_stopped", { parentQuantity: before.quantity, parentVisibility: before.visibility });
  }

  let form;
  try {
    form = await buildForm();
  } catch {
    return finish("image_bytes_missing", null, currentStatus === "parent_rejected" ? "parent_rejected" : "idle");
  }
  if (!form) return finish("image_bytes_missing", null, currentStatus === "parent_rejected" ? "parent_rejected" : "idle");
  const claimed = await operation.claim(["idle"], "parent_in_progress", operationPatch("parent_in_progress", null));
  if (!claimed) return finish(currentStatus === "parent_rejected" ? "parent_create_rejected" : "operation_in_progress", null, currentStatus === "idle" ? "parent_in_progress" : currentStatus);

  let created;
  try {
    created = await request("POST", GINI_PRODUCTS_PATH, { form });
  } catch {
    const after = await request("GET", PARENT_PATH).catch(() => null);
    return finish("parent_create_uncertain", after, "parent_uncertain");
  }
  if (created?.status !== 200 && created?.status !== 201) {
    let after;
    try {
      after = await request("GET", PARENT_PATH);
    } catch {
      return finish("parent_create_uncertain", created, "parent_uncertain");
    }
    const record = readParentRecord(after);
    if (record.state === "present") return finish("parent_create_uncertain", created, "parent_uncertain", { parentQuantity: record.quantity, parentVisibility: record.visibility });
    if (definiteRejection(created) && record.state === "absent") return finish(rejectionCode(created), created, "parent_rejected");
    return finish("parent_create_uncertain", created, "parent_uncertain");
  }

  let verified;
  try {
    verified = await request("GET", PARENT_PATH);
  } catch {
    return finish("parent_visibility_unverified", created, "parent_uncertain");
  }
  const record = readParentRecord(verified);
  if (parentVerified(record)) return finish("parent_verified", verified, "parent_verified", { parentQuantity: 0, parentVisibility: "hidden" });
  if (record.state === "present") return finish(parentProblem(record) || "parent_visibility_unverified", verified, "parent_stopped", { parentQuantity: record.quantity, parentVisibility: record.visibility });
  return finish("parent_visibility_unverified", verified, "parent_uncertain");
}

export async function executeStageB({
  productId,
  confirm = false,
  acceptUnprovenVariantSkuUniqueness = false,
  writesEnabled = false,
  variantFields = [],
  imageFiles = [],
  operation,
  perform,
  buildForm,
  log = () => {},
} = {}) {
  const calls = [];
  if (String(productId || "") !== GINI_VARIANT_TEST_PRODUCT_ID) return closed("variant_test_product_mismatch");
  if (writesEnabled !== true) return closed("variant_test_writes_disabled");
  if (confirm !== true) return closed("stage_b_confirm_required");
  if (acceptUnprovenVariantSkuUniqueness !== true) return closed("uniqueness_acknowledgement_required");
  if (!operation) return closed("operation_uncertain");
  const currentStatus = (await operation.read())?.status || "idle";
  const inspecting = currentStatus === "variants_in_progress" || currentStatus === "variants_uncertain" || currentStatus === "variants_verified";
  if (!inspecting) {
    if (!variantFieldsAreSafe(variantFields)) return closed("variant_fields_rejected");
    if (!imagesReady(imageFiles)) return closed("image_bytes_missing");
  }

  const request = async (method, path, extra = {}) => {
    const verb = String(method || "").toUpperCase();
    if (verb !== "GET" && verb !== "PUT") throw new Error("method_blocked");
    calls.push({ method: verb, path });
    const response = await perform({ method: verb, path, ...extra });
    log(sanitizedGiniResponse(response));
    return response;
  };
  const finish = async (code, response, status, extra = {}) => {
    const saved = await operation.update({ ...operationPatch(code, response, extra), status });
    return {
      ok: status === "variants_verified",
      sent: calls.some((call) => call.method === "PUT"),
      verified: status === "variants_verified",
      code,
      writeMethods: calls.filter((call) => call.method !== "GET").map((call) => call.method),
      calls,
      operationStatus: saved?.status || status,
    };
  };

  if (currentStatus !== "parent_verified" && currentStatus !== "variants_in_progress" && currentStatus !== "variants_uncertain" && currentStatus !== "variants_verified") {
    return closed("stage_b_parent_not_verified");
  }

  const parent = readParentRecord(await request("GET", PARENT_PATH));
  if (parent.state !== "present") return finish("parent_missing_before_variants", null, "parent_uncertain");
  if (parent.visibility === "visible") {
    return finish("parent_visible_unexpected", null, "parent_stopped", { parentQuantity: parent.quantity, parentVisibility: parent.visibility });
  }
  if (parent.visibility !== "hidden") {
    return finish("parent_visibility_unverified", null, "parent_uncertain", { parentQuantity: parent.quantity, parentVisibility: parent.visibility });
  }

  let listed;
  try {
    listed = variantRowsFromResponse(await request("GET", VARIANT_PATH));
  } catch {
    return finish("variants_unread", null, currentStatus);
  }
  const before = strictVariantState(listed);
  if (before === "uncertain") return finish("variants_unread", null, currentStatus);
  if (before === "partial" || before === "unrelated") return finish("remote_variants_not_replaced", null, currentStatus);
  if (before === "match") {
    const after = parentProblemAfterVariants(parent, listed);
    if (after) return finish(after, null, "parent_stopped", { parentQuantity: parent.quantity, parentVisibility: parent.visibility });
    return finish("variants_verified", null, "variants_verified", { parentQuantity: parent.quantity, parentVisibility: "hidden" });
  }
  if (currentStatus === "variants_in_progress" || currentStatus === "variants_uncertain" || currentStatus === "variants_verified") {
    const code = currentStatus === "variants_in_progress" ? "operation_in_progress" : currentStatus === "variants_verified" ? "variants_verified" : "operation_uncertain";
    return finish(code, null, currentStatus, { parentQuantity: parent.quantity, parentVisibility: parent.visibility });
  }
  if (!parentVerified(parent)) {
    return finish(parentProblem(parent) || "parent_quantity_mismatch", null, "parent_stopped", { parentQuantity: parent.quantity, parentVisibility: parent.visibility });
  }

  let form;
  try {
    form = await buildForm();
  } catch {
    return finish("multipart_upload_failed", null, "parent_verified");
  }
  const claimed = await operation.claim(["parent_verified"], "variants_in_progress", operationPatch("variants_in_progress", null));
  if (!claimed) return { ...closed("operation_in_progress"), calls };

  let saved;
  try {
    saved = await request("PUT", VARIANT_PATH, { form });
  } catch {
    return finish("multipart_upload_failed", null, "variants_uncertain");
  }
  if (saved?.status !== 200 && saved?.status !== 201) return finish("multipart_upload_failed", saved, "variants_uncertain");

  let verifiedRows;
  try {
    verifiedRows = variantRowsFromResponse(await request("GET", VARIANT_PATH));
  } catch {
    return finish("variants_unverified", saved, "variants_uncertain");
  }
  if (strictVariantState(verifiedRows) !== "match") return finish("variants_unverified", saved, "variants_uncertain");
  const hidden = readParentRecord(await request("GET", PARENT_PATH));
  const after = parentProblemAfterVariants(hidden, verifiedRows);
  if (after) return finish(after, null, "parent_stopped", { parentQuantity: hidden.quantity, parentVisibility: hidden.visibility });
  return finish("variants_verified", saved, "variants_verified", { parentQuantity: hidden.quantity, parentVisibility: "hidden" });
}

export async function executeVariantReadBack({ operation, perform } = {}) {
  const calls = [];
  const request = async (method, path) => {
    const verb = String(method || "").toUpperCase();
    if (verb !== "GET") throw new Error("method_blocked");
    calls.push({ method: "GET", path });
    return perform({ method: "GET", path });
  };
  const finish = (code, status, extra = {}) => ({
    ok: status === "variants_verified",
    sent: false,
    verified: status === "variants_verified",
    code,
    writeMethods: [],
    calls,
    operationStatus: status,
    ...extra,
  });
  if (!operation) return finish("operation_uncertain", "variants_uncertain");
  const current = await operation.read();
  const currentStatus = current?.status || "";
  if (!["parent_verified", "variants_in_progress", "variants_uncertain", "variants_verified"].includes(currentStatus)) {
    return finish("stage_b_parent_not_verified", currentStatus || "idle");
  }
  const parent = readParentRecord(await request("GET", PARENT_PATH));
  if (parent.state !== "present") return finish("parent_missing_before_variants", currentStatus);
  let rows;
  try {
    rows = variantRowsFromResponse(await request("GET", VARIANT_PATH));
  } catch {
    return finish("variants_unread", currentStatus);
  }
  if (strictVariantState(rows) !== "match") return finish("variants_unverified", currentStatus, { parent, rows: rows || [] });
  const problem = parentProblemAfterVariants(parent, rows);
  if (problem) return finish(problem, currentStatus, { parentQuantity: parent.quantity, parentVisibility: parent.visibility, parent, rows });
  const saved = await operation.update({
    status: "variants_verified",
    lastCode: "variants_verified",
    httpStatus: 200,
    parentQuantity: parent.quantity,
    parentVisibility: "hidden",
  });
  return finish("variants_verified", saved?.status || "variants_verified", { parentQuantity: parent.quantity, parentVisibility: "hidden", parent, rows });
}
