import mongoose from "mongoose";
import { filterCommissionTargetId, filterIdsError, normalizeFilterIds } from "../utils/commissionIds.js";

export const COMMISSION_SCOPES = [
  "all",
  "category",
  "subcategory",
  "collection",
  "brand",
  "vendor",
  "filter",
];
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
    vendorId: { type: String },
    brandId: { type: String },
    collectionId: { type: String },
    filterPath: { type: mongoose.Schema.Types.Mixed },
    percentage: { type: Number, required: true, min: -99, max: 500 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

commissionSchema.pre("validate", function rejectIncompleteFilter(next) {
  if (this.scope !== "filter") return next();
  const error = filterIdsError(this);
  if (error) {
    const hasCollection = String(this.collectionId || "").trim();
    const hasSub = String(this.subCategoryId || "").trim();
    this.invalidate(hasCollection && !hasSub ? "collectionId" : "vendorId", error);
    return next();
  }
  const ids = normalizeFilterIds(this);
  if (String(this.targetId || "") !== filterCommissionTargetId(ids)) {
    this.invalidate("targetId", "Filter commission target does not match the selected path.");
  }
  next();
});

commissionSchema.index({ partner: 1, scope: 1, targetId: 1 }, { unique: true });

export const Commission = mongoose.model("Commission", commissionSchema);
