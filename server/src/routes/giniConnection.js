import { Router } from "express";
import mongoose from "mongoose";
import {
  fetchGiniCategoryTree,
  getGiniConnectionPublic,
  GiniConnectionError,
  saveGiniConnection,
  testGiniConnection,
} from "../services/giniConnection.js";
import { previewGiniSyncOne, searchGiniSyncProducts, sendGiniSyncOne } from "../services/giniSyncOne.js";
import {
  getLatestGiniSyncJob,
  pauseGiniSyncAll,
  resumeGiniSyncAll,
  runGiniChangedPreview,
  reconcileStoredGiniPreview,
  runGiniSuccessorPreview,
  runGiniSyncPreview,
  startGiniSyncAll,
  stopGiniSyncAll,
} from "../services/giniSyncAll.js";
import { diagnoseGiniPreviewRecovery } from "../services/giniPreviewRecovery.js";
import {
  pauseGiniChangedSync,
  resumeGiniChangedSync,
  startGiniChangedSync,
  stopGiniChangedSync,
} from "../services/giniProductUpdate.js";
import { reconcileGiniImageReplacement, resolveGiniImageReplacement, startGiniImageReplacement } from "../services/giniImageReplacement.js";
import { getLatestGiniResyncJob, reconcileGiniResync, runGiniResyncPreview, startGiniResync } from "../services/giniResync.js";
import { previewGiniSkuCreate, sendGiniSkuCreate } from "../services/giniSkuCreate.js";
import { loadVariantTestImageBytes, mongoVariantTestOperation, previewGiniVariantTest, runGiniVariantTestStage } from "../services/giniVariantTest.js";
import { approveParentOwner, approveVariantSkus, variantCatalogPage } from "../services/giniVariantSync.js";
import { previewGiniVariantPilot, runGiniVariantPilotStage } from "../services/giniVariantPilot.js";
import { previewVariantChangedSync } from "../services/giniVariantChangedSync.js";
import { listOwnershipGroups, prepareOwnershipSelection, saveOwnershipSelection } from "../services/giniVariantOwnershipSelection.js";
import { approveVariantPricePilot } from "../services/giniVariantPricePilot.js";
import { previewEi8888PricePatch, previewKe20PricePatch, refreshEi8888CommissionSnapshot, runAuthorizedEi8888PricePatch, runAuthorizedKe20PricePatch } from "../services/giniVariantPricePatch.js";
import { previewKe20StockPatch, runAuthorizedKe20StockPatch } from "../services/giniVariantStockPatch.js";
import { verifyXiaomiVariantReadBack } from "../services/giniVariantReadBack.js";

export const giniConnectionRouter = Router();

function fail(res, err, fallback) {
  if (err instanceof GiniConnectionError) {
    const body = {
      message: err.message || fallback,
      code: err.code || undefined,
    };
    if (err.code === "categories_unavailable" || err.failureClass) {
      body.httpStatus = Number(err.httpStatus) || 0;
      if (err.failureClass) body.failureClass = err.failureClass;
    }
    return res.status(err.status >= 400 && err.status < 500 ? err.status : 400).json(body);
  }
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error("GINI connection error");
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    message: status >= 500 ? fallback : err?.message || fallback,
    ...(err?.code ? { code: err.code } : {}),
  });
}

function assertNoSecretLeak(payload, submittedSecret) {
  const json = JSON.stringify(payload);
  const secret = String(submittedSecret || "");
  if (
    json.includes("clientSecretEnc") ||
    json.includes("clientSecret") ||
    json.includes("X-SIGNATURE") ||
    json.includes("signingString") ||
    (secret.length >= 4 && json.includes(secret))
  ) {
    const error = new Error("Refusing to return GINI secret");
    error.status = 500;
    throw error;
  }
  return payload;
}

giniConnectionRouter.get("/platforms/gini/connection", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await getGiniConnectionPublic(), ""));
  } catch (err) {
    fail(res, err, "Failed to load GINI connection");
  }
});

giniConnectionRouter.put("/platforms/gini/connection", async (req, res) => {
  try {
    const body = req.body || {};
    const saved = await saveGiniConnection({
      baseUrl: body.baseUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
    });
    res.json(assertNoSecretLeak(saved, body.clientSecret));
  } catch (err) {
    fail(res, err, "Failed to save GINI connection");
  }
});

giniConnectionRouter.get("/platforms/gini/categories", async (_req, res) => {
  try {
    const live = await fetchGiniCategoryTree();
    if (live.connectionRequired) {
      return res.status(409).json({
        message: "Connect GINI API first",
        code: "connection_required",
        categories: [],
      });
    }
    res.json(assertNoSecretLeak({ categories: live.categories }, ""));
  } catch (err) {
    fail(res, err, "Failed to load GINI categories");
  }
});

giniConnectionRouter.get("/platforms/gini/sync-one/products", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await searchGiniSyncProducts(req.query.q, req.query.limit), ""));
  } catch (err) {
    fail(res, err, "Failed to search products");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-one/preview", async (req, res) => {
  try {
    const preview = assertNoSecretLeak(await previewGiniSyncOne({ productId: req.body?.productId }), "");
    if (preview.blockers?.includes("connection_required")) {
      return res.status(409).json({
        ...preview,
        message: "Connect GINI API first",
        code: "connection_required",
      });
    }
    res.json(preview);
  } catch (err) {
    fail(res, err, "Failed to preview GINI product");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-one/send", async (req, res) => {
  try {
    const body = req.body || {};
    const result = assertNoSecretLeak(
      await sendGiniSyncOne({
        productId: body.productId,
        confirm: body.confirm === true,
        previewToken: body.previewToken,
      }),
      ""
    );
    res.status(result.ok ? 200 : 400).json(result);
  } catch (err) {
    fail(res, err, "Failed to send GINI product");
  }
});

giniConnectionRouter.get("/platforms/gini/sync-all", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await getLatestGiniSyncJob(), ""));
  } catch (err) {
    fail(res, err, "Failed to load GINI sync");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/preview", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await runGiniSyncPreview(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview GINI catalog");
  }
});

giniConnectionRouter.get("/platforms/gini/sync-all/recovery/:jobId", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await diagnoseGiniPreviewRecovery(req.params.jobId), ""));
  } catch (err) {
    fail(res, err, "Failed to read the GINI preview recovery");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/successor-preview", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await runGiniSuccessorPreview({ sourceJobId: req.body?.sourceJobId }), ""));
  } catch (err) {
    fail(res, err, "Failed to start the GINI successor preview");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/reconcile", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await reconcileStoredGiniPreview(req.body?.jobId), ""));
  } catch (err) {
    fail(res, err, "Failed to reconcile the GINI preview");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/changed-preview", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await runGiniChangedPreview(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview GINI changes");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/changed-sync/start", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      assertNoSecretLeak(
        await startGiniChangedSync({
          confirm: body.confirm === true,
          previewId: body.previewId,
          previewSignature: body.previewSignature,
          sku: body.sku,
          expectedChanges: body.expectedChanges,
          scope: body.scope,
          skus: body.skus,
          all: body.all === true,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to start the GINI update");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/changed-sync/pause", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await pauseGiniChangedSync(), ""));
  } catch (err) {
    fail(res, err, "Failed to pause the GINI update");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/changed-sync/resume", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await resumeGiniChangedSync(), ""));
  } catch (err) {
    fail(res, err, "Failed to resume the GINI update");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/image-replacement/start", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      assertNoSecretLeak(
        await startGiniImageReplacement({
          confirm: body.confirm === true,
          previewId: body.previewId,
          previewSignature: body.previewSignature,
          sku: body.sku,
          deleteImageUrl: body.deleteImageUrl,
          replacementImageUrl: body.replacementImageUrl,
          scope: body.scope,
          skus: body.skus,
          all: body.all === true,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to replace the GINI image");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/image-replacement/reconcile", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await reconcileGiniImageReplacement({ confirm: body.confirm === true, sku: body.sku }), ""));
  } catch (err) {
    fail(res, err, "Failed to reconcile the GINI image");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/image-replacement/resolve", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      assertNoSecretLeak(
        await resolveGiniImageReplacement({
          confirm: body.confirm === true,
          sku: body.sku,
          resolution: body.resolution,
          acknowledgeDelay: body.acknowledgeDelay === true,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to resolve the GINI image");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/changed-sync/stop", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await stopGiniChangedSync(), ""));
  } catch (err) {
    fail(res, err, "Failed to stop the GINI update");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/start", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await startGiniSyncAll({
      confirm: body.confirm === true,
      previewJobId: body.previewJobId,
      catalogSignature: body.catalogSignature,
      expectedReady: body.expectedReady,
      expectedChanged: body.expectedChanged,
      scope: body.scope,
      limit: body.limit,
      approveFullRun: body.approveFullRun === true,
    });
    res.json(assertNoSecretLeak(result, ""));
  } catch (err) {
    fail(res, err, "Failed to start GINI sync");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/pause", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await pauseGiniSyncAll(), ""));
  } catch (err) {
    fail(res, err, "Failed to pause GINI sync");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/resume", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await resumeGiniSyncAll(), ""));
  } catch (err) {
    fail(res, err, "Failed to resume GINI sync");
  }
});

giniConnectionRouter.post("/platforms/gini/sync-all/stop", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await stopGiniSyncAll(), ""));
  } catch (err) {
    fail(res, err, "Failed to stop GINI sync");
  }
});

giniConnectionRouter.post("/platforms/gini/sku-create/preview", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await previewGiniSkuCreate({ sku: body.sku, productId: body.productId }), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the GINI product");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-test/preview", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await previewGiniVariantTest({ productId: body.productId }, {
      loadImageBytes: loadVariantTestImageBytes,
      operation: mongoVariantTestOperation(),
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the GINI variant test");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-test/stage-a", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await runGiniVariantTestStage({
      stage: "parent",
      productId: body.productId,
      confirm: body.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the GINI variant parent stage");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-test/stage-b", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await runGiniVariantTestStage({
      stage: "variants",
      productId: body.productId,
      confirm: body.confirm === true,
      acceptUnprovenVariantSkuUniqueness: body.acceptUnprovenVariantSkuUniqueness === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the GINI variant stage");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync", async (req, res) => {
  try {
    const page = await variantCatalogPage({ status: req.query.status || "", page: req.query.page || 1 });
    res.json(assertNoSecretLeak(page, ""));
  } catch (err) {
    fail(res, err, "Failed to preview GINI variants");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/ownership", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await listOwnershipGroups({
      query: req.query.query || req.query.q || "",
      page: req.query.page || 1,
      pageSize: req.query.pageSize || 10,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to read duplicate SKU ownership groups");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/ownership/preview", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await prepareOwnershipSelection({
      parentSku: body.parentSku,
      productId: body.productId,
      confirm: body.confirm === true,
      administratorId: String(req.user?._id || ""),
      requireProductionReview: true,
    }, { host: mongoose.connection?.host || "" }), ""));
  } catch (err) {
    fail(res, err, "Failed to prepare the ownership selection");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/ownership/save", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await saveOwnershipSelection({
      parentSku: body.parentSku,
      productId: body.productId,
      vendorId: body.vendorId,
      sourceItemId: body.sourceItemId,
      confirm: body.confirm === true,
      confirmOwnershipSave: body.confirmOwnershipSave === true,
      seenProductIds: Array.isArray(body.seenProductIds) ? body.seenProductIds : null,
      administratorId: String(req.user?._id || ""),
      snapshotId: typeof body.snapshotId === "string" ? body.snapshotId : "",
    }, { host: mongoose.connection?.host || "" });
    const status = result.saved === true && result.ok === true ? 200 : 409;
    res.status(status).json(assertNoSecretLeak(result, ""));
  } catch (err) {
    fail(res, err, "Failed to save the ownership selection");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/changed-preview", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await previewVariantChangedSync(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview GINI variant changes");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/price-pilot/approve", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await approveVariantPricePilot({
      parentSku: req.body?.parentSku,
      confirm: req.body?.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to record the GINI price pilot approval");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/ke20-price-patch", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await previewKe20PricePatch(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the KE20 price PATCH");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/ke20-price-patch", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await runAuthorizedKe20PricePatch({
      stage: req.body?.stage,
      confirm: req.body?.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the KE20 price PATCH");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/ei8888-price-patch", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await previewEi8888PricePatch(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the EI-8888 price PATCH");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/ei8888-price-patch/commission-snapshot", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await refreshEi8888CommissionSnapshot({
      confirm: req.body?.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to refresh the EI-8888 commission snapshot");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/ei8888-price-patch", async (req, res) => {
  try {
    res.json(assertNoSecretLeak(await runAuthorizedEi8888PricePatch({
      stage: req.body?.stage,
      confirm: req.body?.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the EI-8888 price PATCH");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/stock-patch", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await previewKe20StockPatch(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the KE20 stock PATCH");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/stock-patch", async (req, res) => {
  try {
    const direction = req.body?.direction === "restore" ? "restore" : "apply";
    res.json(assertNoSecretLeak(await runAuthorizedKe20StockPatch({
      direction,
      confirm: req.body?.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the KE20 stock PATCH");
  }
});

giniConnectionRouter.get("/platforms/gini/variant-sync/pilot", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await previewGiniVariantPilot(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview the GINI variant pilot");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/pilot/stage", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await runGiniVariantPilotStage({
      productId: body.productId,
      stage: body.stage,
      confirm: body.confirm === true,
    }), ""));
  } catch (err) {
    fail(res, err, "Failed to run the GINI variant pilot stage");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/approve-skus", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await approveVariantSkus({ productId: body.productId, confirm: body.confirm === true, combinations: body.combinations || [] }), ""));
  } catch (err) {
    fail(res, err, "Failed to approve variant SKUs");
  }
});

giniConnectionRouter.post("/platforms/gini/variant-sync/approve-owner", async (_req, res) => {
  res.status(410).json(await approveParentOwner());
});

giniConnectionRouter.get("/platforms/gini/variant-test/read-back", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await verifyXiaomiVariantReadBack(), ""));
  } catch (err) {
    fail(res, err, "Failed to read the Xiaomi variants");
  }
});

giniConnectionRouter.post("/platforms/gini/sku-create/send", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      assertNoSecretLeak(
        await sendGiniSkuCreate({
          sku: body.sku,
          productId: body.productId,
          confirm: body.confirm === true,
          previewToken: body.previewToken,
          expectedCount: body.expectedCount,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to create the GINI product");
  }
});

giniConnectionRouter.get("/platforms/gini/resync", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await getLatestGiniResyncJob(), ""));
  } catch (err) {
    fail(res, err, "Failed to load GINI re-sync");
  }
});

giniConnectionRouter.post("/platforms/gini/resync/preview", async (_req, res) => {
  try {
    res.json(assertNoSecretLeak(await runGiniResyncPreview(), ""));
  } catch (err) {
    fail(res, err, "Failed to preview GINI re-sync");
  }
});

giniConnectionRouter.post("/platforms/gini/resync/start", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(
      assertNoSecretLeak(
        await startGiniResync({
          confirm: body.confirm === true,
          previewId: body.previewId,
          previewSignature: body.previewSignature,
          skus: body.skus,
          expectedCount: body.expectedCount,
          scope: body.scope,
          all: body.all === true,
          authorizeHistorical: body.authorizeHistorical === true,
        }),
        ""
      )
    );
  } catch (err) {
    fail(res, err, "Failed to re-sync GINI products");
  }
});

giniConnectionRouter.post("/platforms/gini/resync/reconcile", async (req, res) => {
  try {
    const body = req.body || {};
    res.json(assertNoSecretLeak(await reconcileGiniResync({ confirm: body.confirm === true, sku: body.sku }), ""));
  } catch (err) {
    fail(res, err, "Failed to reconcile GINI re-sync");
  }
});

giniConnectionRouter.post("/platforms/gini/connection/test", async (req, res) => {
  try {
    const body = req.body || {};
    const result = await testGiniConnection({
      baseUrl: body.baseUrl,
      clientId: body.clientId,
      clientSecret: body.clientSecret,
      timeoutMs: body.timeoutMs,
    });
    const payload = assertNoSecretLeak(
      {
        ...result,
        connection: await getGiniConnectionPublic(),
      },
      body.clientSecret
    );
    res.status(result.httpStatus === 400 ? 400 : 200).json(payload);
  } catch (err) {
    fail(res, err, "Failed to test GINI connection");
  }
});
