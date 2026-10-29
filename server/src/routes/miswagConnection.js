import { Router } from "express";
import {
  assertMiswagSyncAllowed,
  findMiswagBrands,
  findMiswagCategories,
  getMiswagConnectionPublic,
  MiswagError,
  saveMiswagConnection,
  testMiswagConnection,
} from "../services/miswag.js";
import {
  previewMiswagTestProduct,
  searchProductsForMiswagTest,
  sendMiswagTestProduct,
} from "../services/miswagTestProduct.js";
import {
  listMiswagCategoryMappings,
  saveMiswagCategoryMapping,
} from "../services/miswagCategoryMapping.js";
import {
  listMiswagBrandMappingRows,
  resetMiswagValueMapping,
  upsertMiswagValueMapping,
} from "../services/miswagValueMapping.js";
import {
  getLatestMiswagSyncJob,
  pauseMiswagSyncAll,
  resumeMiswagSyncAll,
  runMiswagSyncPreview,
  startMiswagSyncAll,
  stopMiswagSyncAll,
} from "../services/miswagSyncAll.js";

export const miswagConnectionRouter = Router();

function fail(res, err, fallback) {
  if (err instanceof MiswagError) {
    // Do not return Miswag's 401/403 as HTTP 401 — that is reserved for BrownStore admin session auth
    // ("Unauthorized") and confuses Sync Preview failures with a logged-out session.
    if (err.code === "sync_disabled") {
      return res.status(403).json({
        message: err.message || fallback,
        code: err.code,
      });
    }
    if (err.code === "not_configured" || err.code === "confirm_required") {
      return res.status(err.status >= 400 && err.status < 500 ? err.status : 400).json({
        message: err.message || fallback,
        code: err.code,
      });
    }
    if (err.code === "changed_preview_required") {
      return res.status(err.status === 400 || err.status === 409 ? err.status : 409).json({
        error: "changed_preview_required",
        code: "changed_preview_required",
        message: err.message || "Run and complete Changed Preview before starting Changed Sync.",
      });
    }
    const miswagAuth = err.status === 401 || err.status === 403;
    const status = miswagAuth
      ? 502
      : err.status >= 400 && err.status < 600
        ? err.status
        : err.status === 0
          ? 502
          : 400;
    return res.status(status).json({
      message: err.message || fallback,
      code: err.code || (miswagAuth ? "miswag_auth_failed" : undefined),
      miswagHttpStatus: miswagAuth ? err.status : undefined,
      method: err.method || undefined,
      endpoint: err.endpoint || undefined,
      operation: err.operation || undefined,
      errors: err.errors?.length ? err.errors : undefined,
    });
  }
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error("Miswag connection error:", err?.message || err);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    message: status >= 500 ? fallback : err?.message || fallback,
  });
}

function assertNoSecretLeak(payload, submittedSecret) {
  const json = JSON.stringify(payload);
  const secret = String(submittedSecret || "");
  if (secret.length >= 4 && json.includes(secret)) {
    const err = new Error("Refusing to return API secret to client");
    err.status = 500;
    throw err;
  }
  return payload;
}

miswagConnectionRouter.get("/platforms/miswag/connection", async (_req, res) => {
  try {
    res.json(await getMiswagConnectionPublic());
  } catch (err) {
    fail(res, err, "Failed to load Miswag connection");
  }
});

miswagConnectionRouter.put("/platforms/miswag/connection", async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await saveMiswagConnection({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
    });
    res.json(assertNoSecretLeak(saved, body.apiSecret));
  } catch (err) {
    fail(res, err, "Failed to save Miswag connection");
  }
});

miswagConnectionRouter.post("/platforms/miswag/connection/test", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await testMiswagConnection({
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      apiSecret: body.apiSecret,
      timeoutMs: body.timeoutMs,
    });
    const payload = assertNoSecretLeak(result, body.apiSecret);
    res.status(result.ok ? 200 : result.httpStatus === 401 ? 401 : 200).json(payload);
  } catch (err) {
    fail(res, err, "Failed to test Miswag connection");
  }
});

/**
 * Product sync is intentionally not implemented yet.
 * These endpoints only enforce the connection gate.
 */
miswagConnectionRouter.post("/platforms/miswag/sync/products", async (_req, res) => {
  try {
    await assertMiswagSyncAllowed();
    res.status(501).json({
      message: "Bulk Miswag product sync is not implemented. Use Sync 1 Product test instead.",
      syncEnabled: true,
    });
  } catch (err) {
    fail(res, err, "Miswag sync is unavailable");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync/bulk", async (_req, res) => {
  try {
    await assertMiswagSyncAllowed();
    res.status(501).json({
      message: "Miswag bulk API actions are not implemented yet.",
      bulkActionsEnabled: true,
    });
  } catch (err) {
    fail(res, err, "Miswag bulk actions are unavailable");
  }
});

miswagConnectionRouter.get("/platforms/miswag/sync-one/products", async (req, res) => {
  try {
    res.json(await searchProductsForMiswagTest(req.query.q, req.query.limit));
  } catch (err) {
    fail(res, err, "Failed to search products");
  }
});

miswagConnectionRouter.get("/platforms/miswag/sync-one/categories", async (req, res) => {
  try {
    await assertMiswagSyncAllowed();
    res.json(
      await findMiswagCategories({
        q: req.query.q,
        limit: req.query.limit,
        maxPages: req.query.maxPages,
      })
    );
  } catch (err) {
    fail(res, err, "Failed to find Miswag categories");
  }
});

miswagConnectionRouter.get("/platforms/miswag/sync-one/brands", async (req, res) => {
  try {
    await assertMiswagSyncAllowed();
    res.json(await findMiswagBrands({ q: req.query.q, limit: req.query.limit }));
  } catch (err) {
    fail(res, err, "Failed to find Miswag brands");
  }
});

miswagConnectionRouter.get("/platforms/miswag/sync-one/preview/:productId", async (req, res) => {
  try {
    const preview = await previewMiswagTestProduct({
      productId: req.params.productId,
      categoryId: req.query.categoryId,
      brandId: req.query.brandId,
    });
    res.json(preview);
  } catch (err) {
    fail(res, err, "Failed to preview Miswag test product");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-one/send", async (req, res) => {
  try {
    const body = req.body || {};
    const productIds = Array.isArray(body.productIds) ? body.productIds : [];
    if (productIds.length > 1 || (body.productId && productIds.length)) {
      return res.status(400).json({
        message: "Exactly one product only. Do not send multiple product IDs.",
        code: "not_exactly_one",
      });
    }
    const result = await sendMiswagTestProduct({
      productId: body.productId,
      categoryId: body.categoryId,
      brandId: body.brandId,
      confirm: body.confirm === true,
    });
    const status = result.ok ? 200 : result.action === "BLOCKED" ? 400 : result.httpStatus === 401 ? 401 : 200;
    res.status(status).json(result);
  } catch (err) {
    fail(res, err, "Failed to send Miswag test product");
  }
});

miswagConnectionRouter.get("/platforms/miswag/mapping-categories", async (req, res) => {
  try {
    res.json(
      await listMiswagCategoryMappings({
        q: req.query.q,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    fail(res, err, "Failed to load Miswag category mappings");
  }
});

miswagConnectionRouter.put("/platforms/miswag/mapping-categories/:brownCollectionId", async (req, res) => {
  try {
    const body = req.body || {};
    const input = {};
    const categoryAttempted =
      Object.prototype.hasOwnProperty.call(body, "categoryId") ||
      Object.prototype.hasOwnProperty.call(body, "miswagCategoryId") ||
      Object.prototype.hasOwnProperty.call(body, "id");
    if (categoryAttempted) {
      input.categoryId = body.categoryId || body.miswagCategoryId || body.id || "";
      input.categoryName = body.categoryName || body.name || "";
      input.categoryPath = body.categoryPath || body.path || "";
      input.categoryLevel = body.categoryLevel || body.level || "";
    }
    if (Object.prototype.hasOwnProperty.call(body, "isLarge")) input.isLarge = body.isLarge;
    else if (Object.prototype.hasOwnProperty.call(body, "is_large")) input.is_large = body.is_large;
    res.json(await saveMiswagCategoryMapping(req.params.brownCollectionId, input));
  } catch (err) {
    fail(res, err, "Failed to save Miswag category mapping");
  }
});

miswagConnectionRouter.get("/platforms/miswag/mapping-brands", async (req, res) => {
  try {
    res.json(
      await listMiswagBrandMappingRows({
        q: req.query.q,
        status: req.query.status,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    fail(res, err, "Failed to load Miswag brand mappings");
  }
});

miswagConnectionRouter.put("/platforms/miswag/mapping-brands/:brownKey", async (req, res) => {
  try {
    const body = req.body || {};
    const mapping = await upsertMiswagValueMapping({
      kind: "brand",
      brownKey: req.params.brownKey,
      brownLabel: body.brownLabel || body.label || "",
      miswagId: body.miswagId || body.id || "",
      miswagLabel: body.miswagLabel || body.name || "",
      mode: "manual",
    });
    res.json({ ok: true, mapping });
  } catch (err) {
    fail(res, err, "Failed to save Miswag brand mapping");
  }
});

miswagConnectionRouter.delete("/platforms/miswag/mapping-brands/:brownKey", async (req, res) => {
  try {
    res.json(await resetMiswagValueMapping("brand", req.params.brownKey));
  } catch (err) {
    fail(res, err, "Failed to reset Miswag brand mapping");
  }
});

miswagConnectionRouter.get("/platforms/miswag/sync-all", async (_req, res) => {
  try {
    res.json(await getLatestMiswagSyncJob());
  } catch (err) {
    fail(res, err, "Failed to load Miswag sync job");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-all/preview", async (req, res) => {
  try {
    res.json(await runMiswagSyncPreview({ strategy: req.body?.strategy }));
  } catch (err) {
    fail(res, err, "Failed to run Miswag sync preview");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-all/start", async (req, res) => {
  try {
    res.json(
      await startMiswagSyncAll({
        confirm: req.body?.confirm === true,
        strategy: req.body?.strategy,
        previewJobId: req.body?.previewJobId,
      })
    );
  } catch (err) {
    fail(res, err, "Failed to start Miswag sync");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-all/pause", async (_req, res) => {
  try {
    res.json(await pauseMiswagSyncAll());
  } catch (err) {
    fail(res, err, "Failed to pause Miswag sync");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-all/resume", async (_req, res) => {
  try {
    res.json(await resumeMiswagSyncAll());
  } catch (err) {
    fail(res, err, "Failed to resume Miswag sync");
  }
});

miswagConnectionRouter.post("/platforms/miswag/sync-all/stop", async (_req, res) => {
  try {
    res.json(await stopMiswagSyncAll());
  } catch (err) {
    fail(res, err, "Failed to stop Miswag sync");
  }
});
