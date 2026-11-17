import mongoose from "mongoose";

const giniUnifiedSyncItemSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    productId: { type: String, required: true },
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "" },
    flow: { type: String, enum: ["simple", "variant", "blocked"], default: "blocked" },
    action: { type: String, enum: ["CREATE", "UPDATE", "UNCHANGED", "BLOCKED"], required: true },
    reasons: { type: [String], default: () => [] },
    messages: { type: [String], default: () => [] },
    stage: { type: String, default: "pending" },
    operationStatus: { type: String, default: "idle" },
    fingerprint: { type: String, default: "" },
    giniProductId: { type: String, default: "" },
    visibility: { type: String, default: "" },
    price: { type: Number, default: null },
    quantity: { type: Number, default: null },
    children: { type: [mongoose.Schema.Types.Mixed], default: () => [] },
    retryable: { type: Boolean, default: false },
    httpStatus: { type: Number, default: 0 },
    errorCode: { type: String, default: "" },
  },
  { timestamps: true }
);

giniUnifiedSyncItemSchema.index({ jobId: 1, productId: 1 }, { unique: true });

export const GiniUnifiedSyncItem = mongoose.model("GiniUnifiedSyncItem", giniUnifiedSyncItemSchema);
