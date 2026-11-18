import mongoose from "mongoose";

/**
 * One shipping-carton dimension rule for a BrownStore collection.
 * Staging and Production each have their own rule. Eligible products inherit
 * the rule for the active environment at preview time. It is not copied onto products.
 */
const elryanCollectionDimensionSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging", "production"] },
    brownCollectionId: { type: String, required: true },
    width: { type: Number, required: true },
    height: { type: Number, required: true },
    depth: { type: Number, required: true },
    unit: { type: String, required: true, enum: ["cm"], default: "cm" },
    applyMode: {
      type: String,
      required: true,
      enum: ["AUTO_APPLY", "SUGGEST_REVIEW", "DISABLED"],
    },
    enabled: { type: Boolean, default: false },
    verifiedForCollection: { type: Boolean, default: false },
    verificationSource: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: String, default: "" },
  },
  { timestamps: true }
);

elryanCollectionDimensionSchema.index({ environment: 1, brownCollectionId: 1 }, { unique: true });

export const ElryanCollectionDimension = mongoose.model(
  "ElryanCollectionDimension",
  elryanCollectionDimensionSchema
);
