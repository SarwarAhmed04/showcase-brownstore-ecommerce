import mongoose from "mongoose";

/**
 * Explicit Staging approval for one product payload.
 * A different price or payload hash does not match.
 */
const elryanStagingPriceApprovalSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
    productId: { type: String, required: true },
    sku: { type: String, required: true },
    price: { type: Number, required: true },
    currency: { type: String, required: true },
    commissionRate: { type: Number, required: true },
    sendPriceOnly: { type: Boolean, required: true },
    costOmitted: { type: Boolean, required: true },
    payoutUnknownAccepted: { type: Boolean, required: true },
    payloadHash: { type: String, required: true },
    approvedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

elryanStagingPriceApprovalSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanStagingPriceApproval = mongoose.model(
  "ElryanStagingPriceApproval",
  elryanStagingPriceApprovalSchema
);
