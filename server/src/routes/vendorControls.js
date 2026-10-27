import { Router } from "express";
import {
  listVendorControlRows,
  setVendorBlock,
  setVendorBrandBlock,
} from "../utils/catalogBlocks.js";

export const vendorControlsRouter = Router();

function sendError(res, err, fallback) {
  const status = Number(err?.status) || 500;
  res.status(status).json({
    message: err?.message || fallback,
    code: err?.code || "",
  });
}

vendorControlsRouter.get("/vendor-controls", async (req, res) => {
  try {
    res.json(await listVendorControlRows({ q: req.query.q }));
  } catch (err) {
    sendError(res, err, "Failed to load vendor controls");
  }
});

vendorControlsRouter.put("/vendor-controls/vendors/:vendorId", async (req, res) => {
  try {
    const active = req.body?.active !== false && req.body?.active !== "false";
    const result = await setVendorBlock(req.params.vendorId, active);
    res.json(result);
  } catch (err) {
    sendError(res, err, "Failed to update vendor");
  }
});

vendorControlsRouter.put("/vendor-controls/vendors/:vendorId/brands/:brandId", async (req, res) => {
  try {
    const active = req.body?.active !== false && req.body?.active !== "false";
    const result = await setVendorBrandBlock(req.params.vendorId, req.params.brandId, active);
    res.json(result);
  } catch (err) {
    sendError(res, err, "Failed to update vendor brand");
  }
});
