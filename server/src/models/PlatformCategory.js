import mongoose from "mongoose";

const platformCategorySchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    externalId: { type: String, required: true },
    alias: { type: String, default: "" },
    nameEn: { type: String, default: "" },
    nameAr: { type: String, default: "" },
    description: { type: String, default: "" },
    path: { type: String, default: "" },
    active: { type: Boolean, default: true },
    lastSyncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

platformCategorySchema.index({ partner: 1, externalId: 1 }, { unique: true });

export const PlatformCategory = mongoose.model("PlatformCategory", platformCategorySchema);
