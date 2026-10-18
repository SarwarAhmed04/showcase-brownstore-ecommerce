import mongoose from "mongoose";

const taxonomyBaselineSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    initializedAt: { type: Date, default: Date.now },
    nodeCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const TaxonomyBaseline = mongoose.model("TaxonomyBaseline", taxonomyBaselineSchema);
