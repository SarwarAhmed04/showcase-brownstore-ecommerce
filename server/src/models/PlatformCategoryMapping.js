import mongoose from "mongoose";

export const MAPPING_STATUSES = ["auto_mapped", "verified", "needs_review", "unmapped"];

const localized = { en: String, ar: String, ku: String };

const platformCategoryMappingSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    brownCategoryId: { type: String, default: "" },
    brownCategoryName: localized,
    brownSubCategoryId: { type: String, default: "" },
    brownSubCategoryName: localized,
    brownCollectionId: { type: String, required: true },
    brownCollectionName: localized,
    externalCategoryId: { type: String, default: "" },
    externalCategoryName: { type: String, default: "" },
    externalPath: { type: String, default: "" },
    confidence: { type: Number, default: 0 },
    status: { type: String, enum: MAPPING_STATUSES, default: "unmapped", index: true },
    matchMethod: { type: String, default: "" },
    verifiedAt: { type: Date },
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
