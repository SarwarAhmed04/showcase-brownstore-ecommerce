import mongoose from "mongoose";

const readSchema = new mongoose.Schema(
  {
    state: { type: String, default: "" },
    status: { type: Number, default: 0 },
  },
  { _id: false }
);

const rowSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "" },
    productId: { type: String, default: "" },
    name: { type: String, default: "" },
    classification: { type: String, default: "" },
    code: { type: String, default: "" },
    reason: { type: String, default: "" },
    blockers: { type: [String], default: () => [] },
    eligible: { type: Boolean, default: false },
    locallyEligible: { type: Boolean, default: false },
    historical: { type: Boolean, default: false },
    remoteState: { type: String, default: "" },
    identityMatched: { type: Boolean, default: false },
    savedGiniProductId: { type: String, default: "" },
    liveGiniProductId: { type: String, default: "" },
    savedPayloadHash: { type: String, default: "" },
    currentHash: { type: String, default: "" },
    savedJobId: { type: String, default: "" },
    savedConfirmedAt: { type: Date, default: null },
    giniPrice: { type: Number, default: null },
    quantity: { type: Number, default: null },
    imageCount: { type: Number, default: 0 },
    merchantId: { type: String, default: "" },
    reads: {
      sku: { type: readSchema, default: () => ({}) },
      id: { type: readSchema, default: () => ({}) },
      search: { type: readSchema, default: () => ({}) },
    },
  },
  { _id: false }
);

const giniResyncPreviewSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    signature: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    account: {
      clientId: { type: String, default: "" },
      baseHost: { type: String, default: "" },
      status: { type: String, default: "" },
    },
    rows: { type: [rowSchema], default: () => [] },
  },
  { timestamps: true, collection: "giniresyncpreviews", autoIndex: false, autoCreate: false }
);

export const GiniResyncPreview = mongoose.model("GiniResyncPreview", giniResyncPreviewSchema);
