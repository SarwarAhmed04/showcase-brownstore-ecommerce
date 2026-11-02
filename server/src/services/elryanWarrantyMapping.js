import mongoose from "mongoose";
import { ElryanConfirmedSend } from "../models/ElryanConfirmedSend.js";
import { ElryanValueMapping } from "../models/ElryanValueMapping.js";
import { Product } from "../models/Product.js";
import { getElryanConnectionPublic, getElryanWritesGatePublic } from "./elryanConnection.js";
import { elryanListWarranties } from "./elryanCatalog.js";
import { upsertElryanValueMapping } from "./elryanAttributeMapping.js";
import { expireElryanPreviewTokens } from "./elryanCollectionDimensions.js";
import { normalizeElryanWarrantyCatalog } from "../utils/elryanWarranty.js";
import {
  describeElryanWarrantyRow,
  elryanWarrantyStorageKey,
  resolveElryanWarrantyFromRows,
} from "../utils/elryanWarrantyResolve.js";
import { resolveElryanScopedValue } from "../utils/elryanValueResolve.js";

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

async function assertStagingConnection() {
  const connection = await getElryanConnectionPublic();
  if (connection.environment !== "staging") {
    throw fail(
      "Warranty mapping is limited to Elryan Staging. Production warranties were not read and no mapping was saved.",
      "production_isolated",
      409
    );
  }
  return connection;
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

function stagingBrandWarranty(warrantyRows, brandId) {
  const resolved = resolveElryanWarrantyFromRows(warrantyRows, {
    environment: "staging",
    explicitKey: "",
    brandId,
  });
  if (resolved.source !== "brand" || !resolved.mapping) return null;
  return resolved.mapping;
}

function presentWarranty(mapping, catalogItems) {
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
    environment: "staging",
    scope: "brand",
  };
}

function presentBrandMapping(brandRows, brandId) {
  const resolved = resolveElryanScopedValue(brandRows, { environment: "staging", subject: brandId });
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
    const listed = await elryanListWarranties();
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
export async function listElryanWarrantyMappingPage() {
  const connection = await assertStagingConnection();
  const [brands, brandRows, warrantyRows, warranties] = await Promise.all([
    loadBrownBrands(),
    ElryanValueMapping.find({ kind: "brand" }).lean(),
    ElryanValueMapping.find({ kind: "warranty" }).lean(),
    loadWarrantyCatalog(),
  ]);

  const byId = new Map(brands.map((row) => [row.brownKey, row]));
  for (const row of warrantyRows) {
    const described = describeElryanWarrantyRow(row);
    if (!described || described.environment !== "staging" || described.scope !== "brand") continue;
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
      brandMapping: presentBrandMapping(brandRows, brand.brownKey),
      warranty: presentWarranty(stagingBrandWarranty(warrantyRows, brand.brownKey), warranties.items),
    }))
    .sort((a, b) => a.brownLabel.localeCompare(b.brownLabel, undefined, { sensitivity: "base" }));

  const mapped = rows.filter((row) => row.warranty?.code).length;
  return {
    environment: "staging",
    stagingOnly: true,
    productionIsolated: true,
    activeEnvironment: connection.environment,
    autoAssigned: false,
    nameMatchApplied: false,
    brands: rows,
    counts: {
      brands: rows.length,
      mapped,
      unmapped: rows.length - mapped,
      warranties: warranties.items.length,
    },
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
  await assertStagingConnection();
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
      "That warranty code is not in the official Elryan Staging list. Nothing was saved.",
      "invalid_warranty_code",
      400
    );
  }

  const known = await knownBrand(brandId);
  const warrantyRows = await ElryanValueMapping.find({ kind: "warranty" }).lean();
  const existing = stagingBrandWarranty(warrantyRows, brandId);
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

  const confirmedBefore = await ElryanConfirmedSend.find({ environment: "staging" })
    .select("productId payloadHash elryanProductId httpStatus confirmedAt")
    .sort({ productId: 1 })
    .lean();

  await upsertElryanValueMapping({
    kind: "warranty",
    warrantyScope: "brand",
    environment: "staging",
    brownKey: brandId,
    brownLabel: known?.brownLabel || existing?.brownLabel || "",
    elryanCode: official.code,
    elryanLabel: official.name || "",
  });

  const storedKey = elryanWarrantyStorageKey({
    environment: "staging",
    scope: "brand",
    subject: brandId,
  });
  const readBack = await ElryanValueMapping.findOne({ kind: "warranty", brownKey: storedKey }).lean();
  const readBackOk = Boolean(
    readBack &&
      readBack.elryanCode === official.code &&
      readBack.environment === "staging" &&
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
  const confirmedAfter = await ElryanConfirmedSend.find({ environment: "staging" })
    .select("productId payloadHash elryanProductId httpStatus confirmedAt")
    .sort({ productId: 1 })
    .lean();

  return {
    ok: true,
    saved: true,
    environment: "staging",
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
