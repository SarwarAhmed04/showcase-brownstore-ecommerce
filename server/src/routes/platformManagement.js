import { Router } from "express";
import { Product } from "../models/Product.js";
import { Partner } from "../models/Partner.js";
import { isPartnerSlug } from "../utils/partnerAuth.js";
import { fetchGiniCategoryTree } from "../services/giniConnection.js";
import {
  applyAvailability,
  listAvailability,
  listCategorySetup,
  platformDashboard,
  productEligibility,
  saveCategorySetup,
} from "../utils/platformTaxonomy.js";
import { giniMappingValues } from "../utils/giniCategoryTree.js";
import { listOpenTaxonomyNotices } from "../utils/taxonomyNotices.js";

export const platformManagementRouter = Router();

async function loadPartnerOr404(slug, res) {
  const value = String(slug || "").toLowerCase();
  if (!isPartnerSlug(value)) {
    res.status(400).json({ message: "Unknown partner" });
    return null;
  }
  const partner = await Partner.findOne({ slug: value });
  if (!partner) {
    res.status(404).json({ message: "Partner not found" });
    return null;
  }
  return partner;
}

function sendError(res, err, fallback) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    message: status >= 500 ? fallback : err.message || fallback,
    ...(err.details ? { details: err.details } : {}),
  });
}

function pageQuery(query, fallbackLimit = 20, maxLimit = 100) {
  return {
    page: Math.max(1, Number(query.page) || 1),
    limit: Math.min(maxLimit, Math.max(1, Number(query.limit) || fallbackLimit)),
    q: String(query.q || ""),
    status: String(query.status || "all"),
  };
}

platformManagementRouter.get("/platforms/:slug/dashboard", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    res.json(await platformDashboard(partner));
  } catch (err) {
    sendError(res, err, "Failed to load platform dashboard");
  }
});

platformManagementRouter.get("/platforms/:slug/availability", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const paging = pageQuery(req.query);
    res.json(
      await listAvailability({
        partner: partner.slug,
        scope: String(req.query.scope || "category"),
        ...paging,
      })
    );
  } catch (err) {
    sendError(res, err, "Failed to load availability");
  }
});

platformManagementRouter.post("/platforms/:slug/availability", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    const body = req.body || {};
    const targetIds = Array.isArray(body.targetIds)
      ? body.targetIds
      : body.targetId
        ? [body.targetId]
        : [];
    const result = await applyAvailability({
      partner: partner.slug,
      scope: String(body.scope || ""),
      targetIds,
      isActive: Boolean(body.isActive),
      confirm: body.confirm === true,
      allMatching: body.allMatching === true,
      q: String(body.q || ""),
      status: String(body.status || "all"),
    });
    if (body.scope === "product" && !body.allMatching && targetIds.length === 1) {
      const product = await Product.findById(targetIds[0]);
      if (product) {
        const extra = await productEligibility(partner.slug, product);
        return res.json({ ...result, ...extra });
      }
    }
    res.json(result);
  } catch (err) {
    sendError(res, err, "Failed to update availability");
  }
});

platformManagementRouter.get("/platforms/:slug/category-setup", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    res.json(await listCategorySetup({ partner: partner.slug, ...pageQuery(req.query, 20, 1000) }));
  } catch (err) {
    sendError(res, err, "Failed to load category setup");
  }
});

platformManagementRouter.put("/platforms/:slug/category-setup/:brownCollectionId", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    let input = req.body?.values || req.body;
    if (partner.slug === "gini") {
      let live;
      try {
        live = await fetchGiniCategoryTree();
      } catch (err) {
        return sendError(res, err, "Failed to load GINI categories");
      }
      if (live.connectionRequired) {
        return res.status(409).json({
          code: "connection_required",
          message: "Connect GINI API first",
        });
      }
      input = giniMappingValues(live.categories, input);
    }
    const setup = await saveCategorySetup(partner.slug, req.params.brownCollectionId, input);
    res.json({ setup });
  } catch (err) {
    sendError(res, err, "Failed to save category setup");
  }
});

platformManagementRouter.get("/platforms/:slug/taxonomy-notices", async (req, res) => {
  try {
    const partner = await loadPartnerOr404(req.params.slug, res);
    if (!partner) return;
    res.json(await listOpenTaxonomyNotices(partner.slug));
  } catch (err) {
    sendError(res, err, "Failed to load taxonomy notices");
  }
});
