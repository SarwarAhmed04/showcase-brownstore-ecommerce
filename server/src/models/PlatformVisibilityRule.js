import mongoose from "mongoose";

export const VISIBILITY_SCOPES = [
  "category",
  "subcategory",
  "collection",
  "brand",
  "vendor",
  "product",
];

const platformVisibilityRuleSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, index: true },
    scope: { type: String, enum: VISIBILITY_SCOPES, required: true },
    targetId: { type: String, required: true },
    isActive: { type: Boolean, required: true },
  },
  { timestamps: true }
);

platformVisibilityRuleSchema.index(
  { partner: 1, scope: 1, targetId: 1 },
  { unique: true }
);
platformVisibilityRuleSchema.index({ partner: 1, scope: 1, isActive: 1 });

export const PlatformVisibilityRule = mongoose.model(
  "PlatformVisibilityRule",
  platformVisibilityRuleSchema
);
