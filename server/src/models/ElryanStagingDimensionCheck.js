import mongoose from "mongoose";

/**
 * Explicit Staging confirmation of dimension unit and axes for one product.
 * Incomplete rows are not treated as confirmed.
 */
const elryanStagingDimensionCheckSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
    productId: { type: String, required: true },
    sku: { type: String, required: true },
    unit: { type: String, default: "" },
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    depth: { type: Number, default: null },
    axesConfirmed: { type: Boolean, default: false },
    confirmedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

elryanStagingDimensionCheckSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanStagingDimensionCheck = mongoose.model(
  "ElryanStagingDimensionCheck",
  elryanStagingDimensionCheckSchema
);
