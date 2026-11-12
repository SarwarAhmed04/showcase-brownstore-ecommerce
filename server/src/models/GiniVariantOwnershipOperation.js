import mongoose from "mongoose";

const giniVariantOwnershipOperationSchema = new mongoose.Schema(
  {
    operationKey: { type: String, required: true, unique: true },
    skuKey: { type: String, required: true },
    parentSku: { type: String, required: true },
    productId: { type: String, required: true },
    vendorId: { type: String, required: true },
    sourceItemId: { type: String, required: true },
    excludedProductIds: { type: [String], default: [] },
    administratorId: { type: String, default: "" },
    confirmedAt: { type: Date, default: null },
    previousOwnerProductId: { type: String, default: "" },
    status: { type: String, required: true, enum: ["recorded"] },
  },
  { timestamps: true, autoIndex: false, autoCreate: false }
);

export const GiniVariantOwnershipOperation = mongoose.model(
  "GiniVariantOwnershipOperation",
  giniVariantOwnershipOperationSchema
);
