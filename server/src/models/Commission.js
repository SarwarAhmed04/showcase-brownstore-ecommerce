import mongoose from "mongoose";

export const COMMISSION_SCOPES = ["all", "category", "subcategory", "collection", "vendor"];
export const ALL_TARGET_ID = "*";

const localized = { en: String, ar: String, ku: String };

const commissionSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    scope: { type: String, enum: COMMISSION_SCOPES, required: true },
    targetId: { type: String, required: true },
    targetName: localized,
    categoryId: { type: String, default: "" },
    subCategoryId: { type: String, default: "" },
    percentage: { type: Number, required: true, min: -99, max: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

commissionSchema.index({ partner: 1, scope: 1, targetId: 1 }, { unique: true });

export const Commission = mongoose.model("Commission", commissionSchema);
