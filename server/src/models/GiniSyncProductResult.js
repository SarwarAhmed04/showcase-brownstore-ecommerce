import mongoose from "mongoose";

const CLASSIFICATIONS = [
  "READY_CREATE",
  "ALREADY_EXISTS",
  "BLOCKED",
  "INACTIVE",
  "NEEDS_REVIEW",
  "LOOKUP_UNCERTAIN",
  "CREATED",
  "FAILED",
  "CREATE_UNCERTAIN",
  "RECONCILE",
  "UNCHANGED",
  "CHANGED",
  "UPDATED",
  "UPDATE_UNCERTAIN",
];

const giniSyncProductResultSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    partner: { type: String, required: true, default: "gini" },
    productId: { type: String, required: true },
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "" },
    classification: { type: String, enum: CLASSIFICATIONS, required: true, index: true },
    blockers: { type: [String], default: () => [] },
    reason: { type: String, default: "" },
    errorCode: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    giniProductId: { type: String, default: "" },
    giniPrice: { type: Number, default: null },
    quantity: { type: Number, default: null },
    imageCount: { type: Number, default: 0 },
    payloadHash: { type: String, default: "" },
    localFingerprint: { type: String, default: "" },
    policySignature: { type: String, default: "" },
    lookupOutcome: { type: String, default: "" },
    lookupSkuKey: { type: String, default: "" },
  },
  { timestamps: true }
);

giniSyncProductResultSchema.index({ jobId: 1, productId: 1 }, { unique: true });
giniSyncProductResultSchema.index({ jobId: 1, updatedAt: -1 });

export const GiniSyncProductResult = mongoose.model("GiniSyncProductResult", giniSyncProductResultSchema);
