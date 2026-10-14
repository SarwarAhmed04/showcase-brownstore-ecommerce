import mongoose from "mongoose";

export const MAPPING_STATUSES = ["auto_mapped", "verified", "needs_review", "unmapped"];

const platformCategoryMappingSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    brownCategoryId: { type: String, default: "" },
    // Stored as plain display strings by the current mapping workflow.
    // Mixed keeps older localized-object rows readable if any exist.
    brownCategoryName: { type: mongoose.Schema.Types.Mixed, default: "" },
    brownSubCategoryId: { type: String, default: "" },
    brownSubCategoryName: { type: mongoose.Schema.Types.Mixed, default: "" },
    brownCollectionId: { type: String, required: true },
    brownCollectionName: { type: mongoose.Schema.Types.Mixed, default: "" },
    externalCategoryId: { type: String, default: "" },
    externalCategoryName: { type: String, default: "" },
    externalPath: { type: String, default: "" },
    confidence: { type: Number, default: 0, min: 0, max: 100 },
    status: { type: String, enum: MAPPING_STATUSES, default: "unmapped", index: true },
    matchMethod: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
    verifiedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

platformCategoryMappingSchema.index({ partner: 1, brownCollectionId: 1 }, { unique: true });
platformCategoryMappingSchema.index({ partner: 1, status: 1 });

export const PlatformCategoryMapping = mongoose.model(
  "PlatformCategoryMapping",
  platformCategoryMappingSchema
);
