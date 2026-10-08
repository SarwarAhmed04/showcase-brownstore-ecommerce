import mongoose from "mongoose";

export const MAPPING_STATUSES = ["auto_mapped", "verified", "needs_review", "unmapped"];

const platformCategoryMappingSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    brownCategoryId: { type: String, default: "" },
    brownCategoryName: { type: String, default: "" },
    brownSubCategoryId: { type: String, default: "" },
    brownSubCategoryName: { type: String, default: "" },
    brownCollectionId: { type: String, required: true },
    brownCollectionName: { type: String, default: "" },
    externalCategoryId: { type: String, default: "" },
    externalCategoryName: { type: String, default: "" },
    externalPath: { type: String, default: "" },
    confidence: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: MAPPING_STATUSES, default: "unmapped" },
    matchMethod: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

platformCategoryMappingSchema.index({ partner: 1, brownCollectionId: 1 }, { unique: true });

export const PlatformCategoryMapping = mongoose.model(
  "PlatformCategoryMapping",
  platformCategoryMappingSchema
);
