import mongoose from "mongoose";

export const CATEGORY_LAYOUTS = ["pills", "circles", "cards", "posters", "rail"];

const siteSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "storefront" },
    categoryLayout: {
      type: String,
      enum: CATEGORY_LAYOUTS,
      default: "pills",
    },
    categoryLimit: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const SiteSettings = mongoose.model("SiteSettings", siteSettingsSchema);

export async function getSiteSettings() {
  let doc = await SiteSettings.findById("storefront");
  if (!doc) {
    doc = await SiteSettings.create({ _id: "storefront" });
  }
  return doc;
}
