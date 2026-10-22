import mongoose from "mongoose";

const miswagSyncProductResultSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    partner: { type: String, required: true, default: "miswag", index: true },
    productId: { type: String, required: true, index: true },
    ibsherId: { type: String, default: "", index: true },
    externalId: { type: String, default: "" },
    sku: { type: String, default: "" },
    status: {
      type: String,
      enum: ["SYNCED", "SKIPPED", "FAILED", "INACTIVE", "READY"],
      required: true,
      index: true,
    },
    changeType: { type: String, enum: ["new", "changed", "unchanged"] },
    httpStatus: { type: Number, default: 0 },
    reason: { type: String, default: "" },
    miswagProductId: { type: String, default: "" },
  },
  { timestamps: true }
);

miswagSyncProductResultSchema.index({ jobId: 1, productId: 1 }, { unique: true });

export const MiswagSyncProductResult = mongoose.model(
  "MiswagSyncProductResult",
  miswagSyncProductResultSchema
);
