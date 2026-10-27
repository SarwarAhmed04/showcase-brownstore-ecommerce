import { Router } from "express";
import { ElryanClientError } from "../services/elryanClient.js";
import {
  getElryanConnectionPublic,
  getElryanWritesGatePublic,
  saveElryanConnection,
  testElryanConnection,
} from "../services/elryanConnection.js";
import {
  elryanAttributeSetForCategory,
  elryanAttributeValueById,
  elryanAttributeValues,
  elryanCalculateCommission,
  elryanCategoryAttributes,
  elryanCategoryChildren,
  elryanCategoryDescendants,
  elryanGetCategory,
  elryanHealthCheck,
  elryanListCategories,
  elryanListCommissions,
  elryanListWarranties,
  elryanSkuExists,
} from "../services/elryanCatalog.js";
import {
  cancelElryanCategoryCatalogSync,
  getElryanCategoryCatalog,
  getElryanCategoryCatalogStatus,
  startElryanCategoryCatalogSync,
} from "../services/elryanCategoryCatalogSync.js";
import {
  buildElryanMappingPreview,
  elryanAttributeCompatibility,
} from "../services/elryanMappingPreview.js";
import {
  previewElryanMappingSave,
  saveElryanVerifiedMapping,
  searchElryanSnapshotCategories,
} from "../services/elryanMappingSave.js";
import {
  deleteElryanValueMapping,
  listElryanValueMappings,
  upsertElryanValueMapping,
} from "../services/elryanAttributeMapping.js";
import { verifyElryanAttributeValueFromList } from "../services/elryanAttributeValueCatalog.js";
import {
  elryanBulkDesignNotes,
  previewElryanSyncOne,
  searchElryanSyncProducts,
  sendElryanSyncOne,
} from "../services/elryanSyncOne.js";
import { assertNoElryanSecretLeak } from "../utils/elryanRedact.js";

export const elryanConnectionRouter = Router();

function fail(res, err, fallback) {
  if (err instanceof ElryanClientError) {
    return res.status(err.status >= 400 && err.status < 600 ? err.status : 400).json({
      message: err.message || fallback,
      code: err.code || undefined,
      classification: err.classification || undefined,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
  }
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error("Elryan route error");
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    message: status >= 500 ? fallback : err?.message || fallback,
    ...(err?.code ? { code: err.code } : {}),
    ...(err?.details !== undefined ? { details: err.details } : {}),
  });
}

function originFromReq(req) {
  const configured = String(process.env.PUBLIC_ORIGIN || process.env.CLIENT_ORIGIN || "")
    .split(",")[0]
    .trim();
  if (configured) return configured.replace(/\/+$/, "");
  const host = req.get("x-forwarded-host") || req.get("host");
  const proto = req.get("x-forwarded-proto") || req.protocol || "https";
  if (!host) return "";
  return `${proto}://${host}`.replace(/\/+$/, "");
}

elryanConnectionRouter.get("/platforms/elryan/connection", async (_req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await getElryanConnectionPublic(), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan connection");
  }
});

elryanConnectionRouter.put("/platforms/elryan/connection", async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await saveElryanConnection({
      environment: body.environment,
      apiKey: body.apiKey,
    });
    res.json(assertNoElryanSecretLeak(saved, body.apiKey));
  } catch (err) {
    fail(res, err, "Failed to save Elryan connection");
  }
});

elryanConnectionRouter.post("/platforms/elryan/connection/test", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await testElryanConnection({
      environment: body.environment,
      apiKey: body.apiKey,
      timeoutMs: body.timeoutMs,
    });
    res.status(result.ok ? 200 : result.code === "api_access_pending" ? 409 : 200).json(
      assertNoElryanSecretLeak(result, body.apiKey)
    );
  } catch (err) {
    fail(res, err, "Failed to test Elryan connection");
  }
});

elryanConnectionRouter.get("/platforms/elryan/writes-gate", async (_req, res) => {
  res.json(getElryanWritesGatePublic());
});

elryanConnectionRouter.get("/platforms/elryan/bulk-design", async (_req, res) => {
  res.json(elryanBulkDesignNotes());
});

// --- Read-only catalog (admin-triggered only) ---

elryanConnectionRouter.get("/platforms/elryan/health", async (_req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanHealthCheck(), ""));
  } catch (err) {
    fail(res, err, "Elryan health check failed");
  }
});

elryanConnectionRouter.get("/platforms/elryan/categories", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanListCategories(req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to list Elryan categories");
  }
});

elryanConnectionRouter.get("/platforms/elryan/categories/:id", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanGetCategory(req.params.id), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan category");
  }
});

elryanConnectionRouter.get("/platforms/elryan/categories/:id/children", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanCategoryChildren(req.params.id, req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan category children");
  }
});

elryanConnectionRouter.get("/platforms/elryan/categories/:id/descendants", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await elryanCategoryDescendants(req.params.id, req.query), "")
    );
  } catch (err) {
    fail(res, err, "Failed to load Elryan category descendants");
  }
});

elryanConnectionRouter.get("/platforms/elryan/categories/:id/attributes", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await elryanCategoryAttributes(req.params.id, req.query), "")
    );
  } catch (err) {
    fail(res, err, "Failed to load Elryan category attributes");
  }
});

elryanConnectionRouter.get(
  "/platforms/elryan/categories/:id/attribute-compatibility",
  async (req, res) => {
    try {
      res.json(assertNoElryanSecretLeak(await elryanAttributeCompatibility(req.params.id), ""));
    } catch (err) {
      fail(res, err, "Failed to inspect Elryan attribute compatibility");
    }
  }
);

elryanConnectionRouter.get(
  "/platforms/elryan/attribute-sets/category/:categoryId",
  async (req, res) => {
    try {
      res.json(
        assertNoElryanSecretLeak(await elryanAttributeSetForCategory(req.params.categoryId), "")
      );
    } catch (err) {
      fail(res, err, "Failed to load Elryan attribute set");
    }
  }
);

// --- Phase 3 / 3.1: staging catalog sync + smart/manual mapping (local save only) ---

elryanConnectionRouter.get("/platforms/elryan/category-catalog/status", async (_req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await getElryanCategoryCatalogStatus(), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan category catalog status");
  }
});

elryanConnectionRouter.get("/platforms/elryan/category-catalog", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await getElryanCategoryCatalog(req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan category catalog snapshot");
  }
});

elryanConnectionRouter.post("/platforms/elryan/category-catalog/sync", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await startElryanCategoryCatalogSync({ confirm: req.body?.confirm }), "")
    );
  } catch (err) {
    fail(res, err, "Failed to start Elryan category catalog sync");
  }
});

elryanConnectionRouter.post("/platforms/elryan/category-catalog/cancel", async (_req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await cancelElryanCategoryCatalogSync(), ""));
  } catch (err) {
    fail(res, err, "Failed to cancel Elryan category catalog sync");
  }
});

elryanConnectionRouter.get("/platforms/elryan/mapping-preview", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await buildElryanMappingPreview(req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to build Elryan mapping preview");
  }
});

elryanConnectionRouter.get("/platforms/elryan/mapping/snapshot-search", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(
        await searchElryanSnapshotCategories({
          q: req.query.q,
          limit: req.query.limit,
          offset: req.query.offset,
          leafOnly: req.query.leafOnly === "1" || req.query.leafOnly === "true",
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to search Elryan catalog snapshot");
  }
});

elryanConnectionRouter.post("/platforms/elryan/mapping/preview-save", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(
        await previewElryanMappingSave({
          brownCollectionId: req.body?.brownCollectionId,
          categoryId: req.body?.categoryId,
          includeAttributes: req.body?.includeAttributes !== false,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to preview Elryan mapping save");
  }
});

elryanConnectionRouter.post("/platforms/elryan/mapping/save", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(
        await saveElryanVerifiedMapping({
          brownCollectionId: req.body?.brownCollectionId,
          categoryId: req.body?.categoryId,
          confirm: req.body?.confirm,
          overwrite: req.body?.overwrite,
          source: req.body?.source,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to save Elryan mapping");
  }
});

elryanConnectionRouter.get("/platforms/elryan/attribute-values", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await elryanAttributeValues(req.query.attribute, req.query), "")
    );
  } catch (err) {
    fail(res, err, "Failed to load Elryan attribute values");
  }
});

// Register before /:attribute so "id" / "verify" are not captured as attribute names.
elryanConnectionRouter.get("/platforms/elryan/attribute-values/id/:id", async (req, res) => {
  try {
    // Kept for OpenAPI compatibility; Brand/Color verification uses /list (see verify route).
    res.json(assertNoElryanSecretLeak(await elryanAttributeValueById(req.params.id), ""));
  } catch (err) {
    fail(res, err, "Failed to load Elryan attribute value by id");
  }
});

elryanConnectionRouter.post("/platforms/elryan/attribute-values/verify", async (req, res) => {
  try {
    const attribute = req.body?.attribute || "Brand";
    const valueId = req.body?.valueId ?? req.body?.id ?? req.body?.elryanId;
    const name = req.body?.name ?? req.body?.elryanLabel;
    res.json(
      assertNoElryanSecretLeak(
        await verifyElryanAttributeValueFromList({
          attribute,
          valueId,
          name,
          requireName: Boolean(String(name || "").trim()),
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to verify Elryan attribute value");
  }
});

elryanConnectionRouter.get("/platforms/elryan/attribute-values/:attribute", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await elryanAttributeValues(req.params.attribute, req.query), "")
    );
  } catch (err) {
    fail(res, err, "Failed to load Elryan attribute values");
  }
});

elryanConnectionRouter.get("/platforms/elryan/commissions", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanListCommissions(req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to list Elryan commissions");
  }
});

elryanConnectionRouter.get("/platforms/elryan/commissions/calculate", async (req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanCalculateCommission(req.query), ""));
  } catch (err) {
    fail(res, err, "Failed to calculate Elryan commission");
  }
});

elryanConnectionRouter.get("/platforms/elryan/warranties", async (_req, res) => {
  try {
    res.json(assertNoElryanSecretLeak(await elryanListWarranties(), ""));
  } catch (err) {
    fail(res, err, "Failed to list Elryan warranties");
  }
});

elryanConnectionRouter.get("/platforms/elryan/sku-exists", async (req, res) => {
  try {
    res.json(
      assertNoElryanSecretLeak(await elryanSkuExists(req.query.sku, req.query.productId), "")
    );
  } catch (err) {
    fail(res, err, "Failed to check Elryan SKU");
  }
});

// --- Local attribute mappings (no Elryan write) ---

elryanConnectionRouter.get("/platforms/elryan/value-mappings", async (req, res) => {
  try {
    res.json({ mappings: await listElryanValueMappings(req.query.kind) });
  } catch (err) {
    fail(res, err, "Failed to list Elryan value mappings");
  }
});

elryanConnectionRouter.put("/platforms/elryan/value-mappings", async (req, res) => {
  try {
    const row = await upsertElryanValueMapping(req.body || {});
    res.json({ mapping: row });
  } catch (err) {
    fail(res, err, "Failed to save Elryan value mapping");
  }
});

elryanConnectionRouter.delete(
  "/platforms/elryan/value-mappings/:kind/:brownKey",
  async (req, res) => {
    try {
      res.json(await deleteElryanValueMapping(req.params.kind, req.params.brownKey));
    } catch (err) {
      fail(res, err, "Failed to delete Elryan value mapping");
    }
  }
);

// --- Preview / gated sync ---

elryanConnectionRouter.get("/platforms/elryan/sync-one/products", async (req, res) => {
  try {
    res.json(await searchElryanSyncProducts(req.query.q, req.query.limit));
  } catch (err) {
    fail(res, err, "Failed to search products");
  }
});

elryanConnectionRouter.post("/platforms/elryan/sync-one/preview", async (req, res) => {
  try {
    const preview = assertNoElryanSecretLeak(
      await previewElryanSyncOne({
        productId: req.body?.productId,
        origin: originFromReq(req),
        investigateCommission: req.body?.investigateCommission === true,
      }),
      ""
    );
    res.json(preview);
  } catch (err) {
    fail(res, err, "Failed to preview Elryan product");
  }
});

elryanConnectionRouter.post("/platforms/elryan/sync-one/send", async (req, res) => {
  try {
    const result = assertNoElryanSecretLeak(
      await sendElryanSyncOne({
        productId: req.body?.productId,
        confirm: req.body?.confirm === true,
        previewToken: req.body?.previewToken,
      }),
      ""
    );
    res.status(result.ok ? 200 : 403).json(result);
  } catch (err) {
    fail(res, err, "Failed to send Elryan product");
  }
});
