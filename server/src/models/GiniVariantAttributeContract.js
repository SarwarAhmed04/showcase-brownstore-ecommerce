import mongoose from "mongoose";

const giniVariantAttributeContractSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    attributeId: { type: String, required: true },
    name: { type: String, required: true },
    values: { type: [String], default: () => [] },
    source: { type: String, default: "" },
    verifiedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const GiniVariantAttributeContract = mongoose.model(
  "GiniVariantAttributeContract",
  giniVariantAttributeContractSchema
);
