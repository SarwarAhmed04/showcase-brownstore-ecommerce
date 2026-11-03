import mongoose from "mongoose";

const changeSchema = new mongoose.Schema(
  {
    field: { type: String, default: "" },
    old: { type: Number, default: null },
    new: { type: Number, default: null },
  },
  { _id: false }
);

const rowSchema = new mongoose.Schema(
  {
    sku: { type: String, default: "" },
    skuKey: { type: String, default: "" },
    productId: { type: String, default: "" },
    classification: { type: String, default: "" },
    code: { type: String, default: "" },
    giniProductId: { type: String, default: "" },
    liveGiniProductId: { type: String, default: "" },
    savedHash: { type: String, default: "" },
    currentHash: { type: String, default: "" },
    changes: { type: [changeSchema], default: () => [] },
    updateChanges: { type: [changeSchema], default: () => [] },
    updateEligible: { type: Boolean, default: false },
    updateBlocker: { type: String, default: "" },
    identityMatched: { type: Boolean, default: false },
    remoteImages: { type: [String], default: () => [] },
    sourceImages: { type: [String], default: () => [] },
    imageSelectionRequired: { type: Boolean, default: false },
  },
  { _id: false }
);

const giniChangedPreviewSnapshotSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true, default: "gini", index: true },
    signature: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    rows: { type: [rowSchema], default: () => [] },
  },
  { timestamps: true }
);

export const GiniChangedPreviewSnapshot = mongoose.model(
  "GiniChangedPreviewSnapshot",
  giniChangedPreviewSnapshotSchema
);
