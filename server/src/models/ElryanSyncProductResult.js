import mongoose from "mongoose";

const elryanSyncProductResultSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    environment: { type: String, required: true, enum: ["staging", "production"] },
    productId: { type: String, required: true },
    sku: { type: String, default: "" },
    status: { type: String, enum: ["READY", "SKIPPED", "INACTIVE", "FAILED"], required: true },
    changeType: { type: String, enum: ["", "new", "changed", "unchanged"], default: "" },
    reason: { type: String, default: "" },
    blockerCodes: { type: [String], default: [] },
    payloadHash: { type: String, default: "" },
    readiness: { type: String, default: "" },
  },
  { timestamps: true }
);

elryanSyncProductResultSchema.index({ jobId: 1, productId: 1 }, { unique: true });

export const ElryanSyncProductResult = mongoose.model(
  "ElryanSyncProductResult",
  elryanSyncProductResultSchema
);
