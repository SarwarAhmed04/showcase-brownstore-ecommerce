import { Router } from "express";
import { ensureBanners, toPublicBanner } from "../models/Banner.js";

export const bannersRouter = Router();

bannersRouter.get("/", async (_req, res) => {
  try {
    const docs = await ensureBanners();
    res.json({
      banners: docs.map(toPublicBanner).filter(Boolean),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load banners" });
  }
});
