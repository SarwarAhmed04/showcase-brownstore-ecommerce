import mongoose from "mongoose";

/**
 * Elryan Staging attributes for one BrownStore product.
 * This collection is not the catalog product and is never read for Production.
 */
const elryanStagingProductOverrideSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
    productId: { type: String, required: true },
    sku: { type: String, required: true },
    attributes: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

elryanStagingProductOverrideSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanStagingProductOverride = mongoose.model(
  "ElryanStagingProductOverride",
  elryanStagingProductOverrideSchema
);
