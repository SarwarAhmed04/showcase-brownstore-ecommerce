import mongoose from "mongoose";

/**
 * One Staging shipping-carton dimension rule for a BrownStore collection.
 * Eligible products inherit it at preview time. It is not copied onto products.
 * Production never reads this collection.
 */
const elryanCollectionDimensionSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
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
