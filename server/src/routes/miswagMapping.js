import { MAPPING_STATUSES } from "../models/PlatformCategoryMapping.js";
import { fetchAllMiswagCategories, miswagHealth } from "../services/miswag.js";
import {
  categoryMappingState,
  listExternalCategories,
  rerunCollectionMapping,
  runAutoMapping,
  saveExternalCategories,
  selectCollectionMapping,
  verifyCollectionMapping,
} from "../services/platformCategoryMapping.js";

const PARTNER = "miswag";

function sendError(res, err, fallback, fallbackStatus = 500) {
  console.error(err);
  const status = err.status || fallbackStatus;
  const safe = Boolean(err.status) || String(err.message || "").startsWith("Miswag");
  res.status(status).json({ message: safe ? err.message : fallback });
}

async function withSummary(mapping) {
  const state = await categoryMappingState(PARTNER);
  return { mapping, summary: state.summary };
}

export function registerMiswagMappingRoutes(adminRouter) {
  adminRouter.get("/platforms/miswag/category-mapping/health", async (_req, res) => {
    try {
      res.json(await miswagHealth());
    } catch (err) {
      sendError(res, err, "Failed to check Miswag");
    }
  });

  adminRouter.post("/platforms/miswag/category-mapping/categories/sync", async (_req, res) => {
    try {
      const items = await fetchAllMiswagCategories();
      const saved = await saveExternalCategories(PARTNER, items);
      const state = await categoryMappingState(PARTNER);
      res.json({
        message: "Miswag categories synced",
        count: saved.count,
        lastSyncedAt: saved.lastSyncedAt,
        summary: state.summary,
      });
    } catch (err) {
      sendError(res, err, "Failed to sync Miswag categories", 502);
    }
  });

  adminRouter.get("/platforms/miswag/category-mapping/categories", async (req, res) => {
    try {
      const categories = await listExternalCategories(PARTNER, req.query.q);
      res.json({ categories });
    } catch (err) {
      sendError(res, err, "Failed to load Miswag categories");
    }
  });

  adminRouter.get("/platforms/miswag/category-mapping/summary", async (_req, res) => {
    try {
      const state = await categoryMappingState(PARTNER);
      res.json({ summary: state.summary });
    } catch (err) {
      sendError(res, err, "Failed to load category mapping summary");
    }
  });

  adminRouter.post("/platforms/miswag/category-mapping/auto", async (_req, res) => {
    try {
      const result = await runAutoMapping(PARTNER);
      const state = await categoryMappingState(PARTNER);
      res.json({ ...result, summary: state.summary });
    } catch (err) {
      sendError(res, err, "Failed to run auto mapping");
    }
  });

  adminRouter.get("/platforms/miswag/category-mapping", async (req, res) => {
    try {
      const status = String(req.query.status || "").trim();
      if (status && !MAPPING_STATUSES.includes(status)) {
        return res.status(400).json({ message: "Invalid mapping status" });
      }
      const state = await categoryMappingState(PARTNER, { status });
      res.json(state);
    } catch (err) {
      sendError(res, err, "Failed to load category mappings");
    }
  });

  adminRouter.patch("/platforms/miswag/category-mapping/:collectionId", async (req, res) => {
    try {
      const mapping = await selectCollectionMapping(
        PARTNER,
        req.params.collectionId,
        req.body?.externalCategoryId
      );
      res.json(await withSummary(mapping));
    } catch (err) {
      sendError(res, err, "Failed to update category mapping");
    }
  });

  adminRouter.post("/platforms/miswag/category-mapping/:collectionId/verify", async (req, res) => {
    try {
      const mapping = await verifyCollectionMapping(PARTNER, req.params.collectionId);
      res.json(await withSummary(mapping));
    } catch (err) {
      sendError(res, err, "Failed to verify category mapping");
    }
  });

  adminRouter.post("/platforms/miswag/category-mapping/:collectionId/rerun", async (req, res) => {
    try {
      const mapping = await rerunCollectionMapping(PARTNER, req.params.collectionId);
      res.json(await withSummary(mapping));
    } catch (err) {
      sendError(res, err, "Failed to rerun category mapping");
    }
  });
}
