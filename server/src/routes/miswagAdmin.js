import { Router } from "express";
import { requireAdmin } from "../middleware/auth.js";
import { collectionDiagnostics } from "../utils/brownTaxonomy.js";
import { healthCheck, MiswagError } from "../services/miswag.js";
import {
  importMiswagCategories,
  searchCachedCategories,
  syncMiswagCategories,
  toPublicCategory,
} from "../services/miswagCategories.js";
import {
  assignMapping,
  listMappings,
  mapAllCollections,
  mapOneCollection,
  mappingSummary,
  verifyMapping,
} from "../services/platformCategoryMapping.js";
import {
  adoptExistingMiswagProduct,
  listSyncProducts,
  pollJob,
  previewProduct,
  publishProductIds,
  publishReady,
  retryFailed,
  syncAllEligible,
  syncMiswagPrices,
  syncProduct,
  syncProductIds,
  syncSummary,
} from "../services/miswagSync.js";

export const miswagAdminRouter = Router();
miswagAdminRouter.use(requireAdmin);

function fail(res, err) {
  const status = err instanceof MiswagError
    ? err.status || 502
    : Number(err.status) || 500;
  const code = status >= 400 && status < 600 ? status : status === 0 ? 502 : 500;
  if (code >= 500) console.error("Miswag admin error:", err.message);
  res.status(code).json({
    message: err.message || "Request failed",
    errors: err.errors || undefined,
  });
}

function actor(req) {
  return req.user?.email || String(req.user?._id || "");
}

miswagAdminRouter.get("/health", async (_req, res) => {
  try {
    const result = await healthCheck();
    res.json({ ok: true, status: result.status });
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/categories/sync", async (_req, res) => {
  try {
    res.json(await syncMiswagCategories());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/categories/import", async (req, res) => {
  try {
    res.json(await importMiswagCategories(req.body));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/categories/search", async (req, res) => {
  try {
    const categories = await searchCachedCategories(req.query.q, req.query.limit);
    res.json({ categories: categories.map(toPublicCategory) });
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/mapping/summary", async (_req, res) => {
  try {
    res.json(await mappingSummary());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/mapping", async (req, res) => {
  try {
    res.json(await listMappings(req.query));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/mapping/run", async (_req, res) => {
  try {
    res.json(await mapAllCollections());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/mapping/:collectionId/run", async (req, res) => {
  try {
    res.json(await mapOneCollection(req.params.collectionId));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.patch("/mapping/:collectionId", async (req, res) => {
  try {
    const mapping = await assignMapping(req.params.collectionId, req.body?.externalCategoryId);
    if (req.body?.verify) {
      res.json({ mapping: await verifyMapping(req.params.collectionId, actor(req)) });
      return;
    }
    res.json({ mapping });
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/mapping/:collectionId/verify", async (req, res) => {
  try {
    res.json({ mapping: await verifyMapping(req.params.collectionId, actor(req)) });
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/diagnostics", async (_req, res) => {
  try {
    const [diagnostics, summary] = await Promise.all([collectionDiagnostics(), mappingSummary()]);
    res.json({ diagnostics, summary });
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/sync/summary", async (_req, res) => {
  try {
    res.json(await syncSummary());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/products", async (req, res) => {
  try {
    res.json(await listSyncProducts(req.query));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/sync", async (req, res) => {
  try {
    res.json(await syncProductIds(req.body?.productIds, "delta"));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/sync-eligible", async (req, res) => {
  try {
    if (req.body?.confirm !== true) {
      const err = new Error("Sync all eligible requires confirm: true.");
      err.status = 400;
      throw err;
    }
    res.json(await syncAllEligible());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/retry-failed", async (req, res) => {
  try {
    res.json(await retryFailed(req.body?.limit));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/publish", async (req, res) => {
  try {
    res.json(await publishProductIds(req.body?.productIds));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/publish-ready", async (_req, res) => {
  try {
    res.json(await publishReady());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/products/:id/preview", async (req, res) => {
  try {
    res.json(await previewProduct(req.params.id));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/:id/test-sync", async (req, res) => {
  try {
    res.json(await syncProduct(req.params.id, "full"));
  } catch (err) {
    fail(res, err);
  }
});

// Read Miswag item and upsert local PlatformProductSync only. Never bulk-creates or publishes.
miswagAdminRouter.post("/products/:id/adopt-existing", async (req, res) => {
  try {
    res.json(
      await adoptExistingMiswagProduct(req.params.id, {
        externalId: req.body?.externalId,
        confirm: req.body?.confirm === true,
      })
    );
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/:id/price", async (req, res) => {
  try {
    res.json(await syncProduct(req.params.id, "price"));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/products/:id/stock", async (req, res) => {
  try {
    res.json(await syncProduct(req.params.id, "stock"));
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.post("/prices/reconcile", async (_req, res) => {
  try {
    res.json(await syncMiswagPrices());
  } catch (err) {
    fail(res, err);
  }
});

miswagAdminRouter.get("/jobs/:jobId", async (req, res) => {
  try {
    res.json({ job: await pollJob(req.params.jobId) });
  } catch (err) {
    fail(res, err);
  }
});
