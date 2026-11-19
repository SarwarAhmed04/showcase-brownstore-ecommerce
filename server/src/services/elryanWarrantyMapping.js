import mongoose from "mongoose";
import { ElryanConfirmedSend } from "../models/ElryanConfirmedSend.js";
import { ElryanValueMapping } from "../models/ElryanValueMapping.js";
import { Product } from "../models/Product.js";
import { getElryanConnectionPublic, getElryanWritesGatePublic } from "./elryanConnection.js";
import { elryanListWarranties } from "./elryanCatalog.js";
import { ELRYAN_FIRST_STAGING_CREATE_SKU } from "../utils/elryanStagingGate.js";
import { upsertElryanValueMapping } from "./elryanAttributeMapping.js";
import { expireElryanPreviewTokens } from "./elryanCollectionDimensions.js";
import { normalizeElryanWarrantyCatalog } from "../utils/elryanWarranty.js";
import {
  describeElryanWarrantyRow,
  elryanWarrantyStorageKey,
  resolveElryanWarrantyFromRows,
} from "../utils/elryanWarrantyResolve.js";
import { resolveElryanScopedValue } from "../utils/elryanValueResolve.js";
import { assertElryanSaveEnvironment } from "../utils/elryanTaxonomyMapping.js";
import { filterWarrantyBrands } from "../../../client/src/utils/elryanWarrantyMappingPage.js";
import { compareMappingLabel, paginateElryanMappingRows } from "../utils/elryanMappingTablePage.js";

function fail(message, code, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function brandLabel(name) {
  if (!name) return "";
  if (typeof name === "string") return name.trim();
  return String(name.en || name.ku || name.ar || "").trim();
}

function brandIdVariants(brandId) {
  const id = String(brandId || "").trim();
  const or = [{ "brand._id": id }, { "brand.id": id }];
  if (mongoose.isValidObjectId(id)) {
    const objectId = new mongoose.Types.ObjectId(id);
    or.push({ "brand._id": objectId }, { "brand.id": objectId });
  }
  return or;
}

async function activeWarrantyEnvironment() {
  const connection = await getElryanConnectionPublic();
  return {
    connection,
    environment: connection.environment === "production" ? "production" : "staging",
  };
}

async function loadBrownBrands() {
  const grouped = await Product.aggregate([
    {
      $addFields: {
        brandKey: {
          $toLower: {
            $trim: {
              input: {
                $toString: {
                  $ifNull: ["$brand._id", { $ifNull: ["$brand.id", ""] }],
                },
              },
            },
          },
        },
      },
    },
    { $match: { brandKey: { $nin: ["", "null", "undefined"] } } },
    {
      $group: {
        _id: "$brandKey",
        name: { $first: "$brand.name" },
        productCount: { $sum: 1 },
      },
    },
  ]);
  return grouped
    .filter((row) => row._id)
    .map((row) => ({
      brownKey: String(row._id),
      brownLabel: brandLabel(row.name),
      productCount: Number(row.productCount) || 0,
    }));
}

function brandWarranty(warrantyRows, brandId, environment) {
  const resolved = resolveElryanWarrantyFromRows(warrantyRows, {
    environment,
    explicitKey: "",
    brandId,
  });
  if (resolved.source !== "brand" || !resolved.mapping) return null;
  return resolved.mapping;
}

function presentWarranty(mapping, catalogItems, environment) {
  if (!mapping) return null;
  const code = String(mapping.elryanCode || "").trim();
  const live = (catalogItems || []).find((item) => item.code === code) || null;
  return {
    brownKey: String(mapping.brownKey || ""),
    code,
    label: live?.name || String(mapping.elryanLabel || "").trim(),
    id: live?.id || "",
    duration: live?.duration ?? null,
    terms: live?.terms ?? null,
    status: live?.status ?? null,
    verified: Boolean(live),
    environment,
    scope: "brand",
  };
}

function presentBrandMapping(brandRows, brandId, environment) {
  const resolved = resolveElryanScopedValue(brandRows, { environment, subject: brandId });
  if (!resolved?.row?.elryanId) {
    return { mapped: false, elryanId: "", elryanLabel: "", brownKey: "" };
  }
  return {
    mapped: true,
    elryanId: String(resolved.row.elryanId),
    elryanLabel: String(resolved.row.elryanLabel || resolved.row.brownLabel || ""),
    brownKey: String(resolved.row.brownKey || ""),
  };
}

async function loadWarrantyCatalog() {
  try {
    const listed = await elryanListWarranties({ fresh: true });
    const catalog = normalizeElryanWarrantyCatalog(listed.warranties, listed.httpStatus);
    return {
      ok: true,
      failed: false,
      empty: catalog.empty === true,
      checked: catalog.checked === true,
      httpStatus: catalog.httpStatus,
      message: catalog.empty ? catalog.message : "",
      pagination: listed.pagination || null,
      items: catalog.items,
      codes: catalog.codes,
    };
  } catch (err) {
    return {
      ok: false,
      failed: true,
      empty: false,
      checked: false,
      httpStatus: Number(err?.httpStatus) || Number(err?.status) || 0,
      code: err?.code || "warranty_list_failed",
      message: err?.message || "The Elryan warranty list could not be loaded.",
      pagination: null,
      items: [],
      codes: [],
    };
  }
}

/**
 * Staging brand → warranty page. Reads BrownStore brands and the official
 * warranty list. Does not save a mapping and does not write products.
 */
export async function listElryanWarrantyMappingPage(query = {}) {
  const { connection, environment } = await activeWarrantyEnvironment();
  const [brands, brandRows, warrantyRows, warranties] = await Promise.all([
    loadBrownBrands(),
    ElryanValueMapping.find({ kind: "brand" }).lean(),
    ElryanValueMapping.find({ kind: "warranty" }).lean(),
    loadWarrantyCatalog(),
  ]);

  const byId = new Map(brands.map((row) => [row.brownKey, row]));
  for (const row of warrantyRows) {
    const described = describeElryanWarrantyRow(row);
    if (!described || described.environment !== environment || described.scope !== "brand") continue;
    if (byId.has(described.subject)) continue;
    byId.set(described.subject, {
      brownKey: described.subject,
      brownLabel: String(row.brownLabel || "").trim(),
      productCount: 0,
    });
  }

  const rows = [...byId.values()]
    .map((brand) => ({
      brownKey: brand.brownKey,
      brownLabel: brand.brownLabel || brand.brownKey,
      productCount: brand.productCount,
      brandMapping: presentBrandMapping(brandRows, brand.brownKey, environment),
      warranty: presentWarranty(brandWarranty(warrantyRows, brand.brownKey, environment), warranties.items, environment),
    }))
    .sort((a, b) => compareMappingLabel(a.brownLabel, a.brownKey, b.brownLabel, b.brownKey));

  const matched = filterWarrantyBrands(rows, { q: query?.q, status: query?.status });
  const page = paginateElryanMappingRows(matched, query);
  const mapped = rows.filter((row) => row.warranty?.code).length;
  const sharedWarrantyCounts = {};
  for (const row of rows) {
    const code = String(row.warranty?.code || "").trim();
    if (!code) continue;
    sharedWarrantyCounts[code] = (sharedWarrantyCounts[code] || 0) + 1;
  }
  return {
    environment,
    fresh: true,
    stagingOnly: environment === "staging",
    productionIsolated: environment === "staging",
    activeEnvironment: connection.environment,
    autoAssigned: false,
    nameMatchApplied: false,
    brands: page.rows,
    page: page.page,
    limit: page.limit,
    total: page.total,
    pages: page.pages,
    hasMore: page.hasMore,
    counts: {
      brands: rows.length,
      mapped,
      unmapped: rows.length - mapped,
      warranties: warranties.items.length,
    },
    sharedWarrantyCounts,
    warranties,
    writes: {
      ...getElryanWritesGatePublic(),
      productPostCalled: false,
    },
  };
}

async function knownBrand(brandId) {
  const found = await Product.findOne({ $or: brandIdVariants(brandId) })
    .select({ "brand._id": 1, "brand.id": 1, "brand.name": 1 })
    .lean();
  if (found) {
    const stored = String(found.brand?._id || found.brand?.id || "").trim().toLowerCase();
    if (stored === brandId) return { brownKey: brandId, brownLabel: brandLabel(found.brand?.name) };
  }
  const exprMatch = await Product.findOne({
    $expr: {
      $eq: [
        {
          $toLower: {
            $toString: { $ifNull: ["$brand._id", { $ifNull: ["$brand.id", ""] }] },
          },
        },
        brandId,
      ],
    },
  })
    .select({ "brand.name": 1 })
    .lean();
  if (exprMatch) return { brownKey: brandId, brownLabel: brandLabel(exprMatch.brand?.name) };
  return null;
}

export async function invalidateElryanBrandWarrantyPreviews(brandId) {
  const [direct, matched] = await Promise.all([
    Product.find({ $or: brandIdVariants(brandId) }).select("_id").lean(),
    Product.find({
      $expr: {
        $eq: [
          {
            $toLower: {
              $toString: { $ifNull: ["$brand._id", { $ifNull: ["$brand.id", ""] }] },
            },
          },
          String(brandId || "").trim().toLowerCase(),
        ],
      },
    })
      .select("_id")
      .lean(),
  ]);
  const ids = [...new Set([...direct, ...matched].map((row) => String(row._id)))];
  const invalidatedPreviewTokens = await expireElryanPreviewTokens(ids);
  return {
    affectedProducts: ids.length,
    invalidatedPreviewTokens,
    confirmedSendsUnchanged: true,
  };
}

/**
 * Save one Staging brand default warranty. The code must already exist in the
 * live warranty list. Coverage must be confirmed. A different saved code
 * requires overwrite confirmation. The product document is not updated.
 */
export async function saveElryanBrandWarrantyMapping(input = {}) {
  const { environment } = await activeWarrantyEnvironment();
  if (input.environment != null && String(input.environment).trim() !== "") {
    assertElryanSaveEnvironment(input.environment, environment);
  }
  if (input.confirmCoverage !== true) {
    throw fail(
      "Confirm that this warranty coverage applies to the brand's relevant products before saving.",
      "coverage_confirmation_required"
    );
  }

  const brandId = String(input.brownKey || "").trim().toLowerCase();
  if (!brandId || brandId === "default") {
    throw fail("A BrownStore brand id is required. The universal key \"default\" is not allowed.", "brown_key_required");
  }

  const code = String(input.elryanCode || "").trim();
  if (!code) {
    throw fail("Choose an official Elryan warranty. A warranty was not chosen from a similar name.", "warranty_code_required");
  }

  const warranties = await loadWarrantyCatalog();
  if (!warranties.ok || warranties.failed) {
    throw fail(
      warranties.message || "The official warranty list could not be loaded, so nothing was saved.",
      warranties.code || "warranty_list_failed",
      502
    );
  }
  if (warranties.empty) {
    throw fail(
      "GET /v1/warranty returned no warranty codes. Nothing was invented and nothing was saved.",
      "warranty_list_empty",
      409
    );
  }
  const official = warranties.items.find((item) => item.code === code);
  if (!official) {
    throw fail(
      "That warranty code is not in the fresh Elryan warranty list for the active account. Nothing was saved.",
      "invalid_warranty_code",
      400
    );
  }

  const known = await knownBrand(brandId);
  const warrantyRows = await ElryanValueMapping.find({ kind: "warranty" }).lean();
  const existing = brandWarranty(warrantyRows, brandId, environment);
  if (!known && !existing) {
    throw fail("That BrownStore brand id was not found. A display name cannot be saved as a brand id.", "unknown_brand");
  }
  if (existing && existing.elryanCode !== official.code && input.confirmOverwrite !== true) {
    throw fail(
      "This brand already has a warranty mapping. Confirm the overwrite before replacing it.",
      "overwrite_confirmation_required",
      409
    );
  }

  const confirmedBefore = await ElryanConfirmedSend.find({ environment })
    .select("productId payloadHash elryanProductId httpStatus confirmedAt")
    .sort({ productId: 1 })
    .lean();

  await upsertElryanValueMapping({
    kind: "warranty",
    warrantyScope: "brand",
    environment,
    brownKey: brandId,
    brownLabel: known?.brownLabel || existing?.brownLabel || "",
    elryanCode: official.code,
    elryanLabel: official.name || "",
  });

  const storedKey = elryanWarrantyStorageKey({
    environment,
    scope: "brand",
    subject: brandId,
  });
  const readBack = await ElryanValueMapping.findOne({ kind: "warranty", brownKey: storedKey }).lean();
  const readBackOk = Boolean(
    readBack &&
      readBack.elryanCode === official.code &&
      readBack.environment === environment &&
      readBack.warrantyScope === "brand" &&
      readBack.brownKey === storedKey
  );
  if (!readBackOk) {
    throw fail(
      "The warranty mapping could not be read back from the database. Do not treat it as saved.",
      "warranty_read_back_failed",
      409
    );
  }

  const invalidation = await invalidateElryanBrandWarrantyPreviews(brandId);
  const confirmedAfter = await ElryanConfirmedSend.find({ environment })
    .select("productId payloadHash elryanProductId httpStatus confirmedAt")
    .sort({ productId: 1 })
    .lean();

  return {
    ok: true,
    saved: true,
    environment,
    autoAssigned: false,
    productPostCalled: false,
    productWritesEnabled: getElryanWritesGatePublic().productWritesEnabled,
    mapping: {
      brownKey: readBack.brownKey,
      brownLabel: readBack.brownLabel || "",
      elryanCode: readBack.elryanCode,
      elryanLabel: readBack.elryanLabel || "",
      environment: readBack.environment,
      warrantyScope: readBack.warrantyScope,
    },
    readBack: {
      ok: true,
      brownKey: readBack.brownKey,
      elryanCode: readBack.elryanCode,
      elryanLabel: readBack.elryanLabel || "",
      environment: readBack.environment,
      warrantyScope: readBack.warrantyScope,
    },
    official: {
      id: official.id,
      code: official.code,
      name: official.name,
      duration: official.duration,
      terms: official.terms,
      status: official.status,
    },
    invalidation,
    confirmedSendsUnchanged:
      JSON.stringify(confirmedBefore) === JSON.stringify(confirmedAfter),
  };
}

export const ELRYAN_KENWOOD_FOOD_CHOPPER_WARRANTY = "Kenwood Food Chopper";

/**
 * Save one Production product warranty for SKU OWCH180002.
 * The code must be the catalog row whose name is exactly "Kenwood Food Chopper".
 * The list is read with fresh=true. No product is sent to Elryan.
 */
export async function saveElryanProductWarrantyMapping(input = {}) {
  const connection = await getElryanConnectionPublic();
  if (connection.environment !== "production") {
    throw fail(
      "Save this product warranty while the Elryan connection is Production. Staging warranties were not used.",
      "production_required",
      409
    );
  }
  if (input.confirm !== true) {
    throw fail("Confirm the exact Kenwood Food Chopper warranty before saving.", "confirm_required");
  }
  if (!mongoose.isValidObjectId(input.productId)) {
    throw fail("Product not found", "product_not_found", 404);
  }
  const product = await Product.findById(input.productId).lean();
  if (!product) throw fail("Product not found", "product_not_found", 404);
  const sku = String(product.overrides?.sku || product.itemCode || "").trim();
  if (input.sku && String(input.sku).trim() !== sku) {
    throw fail("SKU does not match this BrownStore product.", "sku_mismatch");
  }
  if (sku !== ELRYAN_FIRST_STAGING_CREATE_SKU) {
    throw fail("This product warranty mapping is limited to SKU OWCH180002.", "first_test_sku_only");
  }

  let listed;
  try {
    listed = await elryanListWarranties({ fresh: true });
  } catch (err) {
    throw fail(err?.message || "The Production warranty list could not be loaded.", err?.code || "warranty_list_failed", 502);
  }
  const catalog = normalizeElryanWarrantyCatalog(listed.warranties, listed.httpStatus);
  const matches = catalog.items.filter((item) => item.name === ELRYAN_KENWOOD_FOOD_CHOPPER_WARRANTY);
  if (matches.length !== 1) {
    throw fail(
      matches.length === 0
        ? `GET /v1/warranty?fresh=true has no exact "${ELRYAN_KENWOOD_FOOD_CHOPPER_WARRANTY}" warranty. Nothing was invented.`
        : `GET /v1/warranty?fresh=true returned more than one exact "${ELRYAN_KENWOOD_FOOD_CHOPPER_WARRANTY}" warranty. Nothing was saved.`,
      matches.length === 0 ? "warranty_name_missing" : "warranty_name_ambiguous",
      409
    );
  }
  const official = matches[0];
  const requested = String(input.elryanCode || "").trim();
  if (requested && requested !== official.code) {
    throw fail(
      "That code is not the exact Kenwood Food Chopper warranty. A similar name was not accepted.",
      "invalid_warranty_code"
    );
  }

  await upsertElryanValueMapping({
    kind: "warranty",
    warrantyScope: "product",
    environment: "production",
    brownKey: sku,
    brownLabel: official.name,
    elryanCode: official.code,
    elryanLabel: official.name,
  });
  const storedKey = elryanWarrantyStorageKey({ environment: "production", scope: "product", subject: sku });
  const readBack = await ElryanValueMapping.findOne({ kind: "warranty", brownKey: storedKey }).lean();
  if (!readBack || readBack.elryanCode !== official.code || readBack.environment !== "production") {
    throw fail("The Production warranty mapping could not be read back.", "warranty_read_back_failed", 409);
  }
  await expireElryanPreviewTokens([String(product._id)]);
  return {
    ok: true,
    saved: true,
    environment: "production",
    productPostCalled: false,
    productWritesEnabled: getElryanWritesGatePublic().productWritesEnabled,
    mapping: {
      brownKey: readBack.brownKey,
      sku,
      elryanCode: readBack.elryanCode,
      elryanLabel: readBack.elryanLabel || "",
      environment: "production",
      warrantyScope: "product",
    },
    official: {
      code: official.code,
      name: official.name,
    },
  };
}
