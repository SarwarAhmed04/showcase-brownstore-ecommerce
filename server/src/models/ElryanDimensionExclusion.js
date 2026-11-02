import mongoose from "mongoose";

/**
 * Staging product that must not inherit its collection dimension rule.
 * This is not a BrownStore catalog field and is never read for Production.
 */
const elryanDimensionExclusionSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
    productId: { type: String, required: true },
    sku: { type: String, required: true },
    excluded: { type: Boolean, default: true },
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

elryanDimensionExclusionSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanDimensionExclusion = mongoose.model(
  "ElryanDimensionExclusion",
  elryanDimensionExclusionSchema
);
