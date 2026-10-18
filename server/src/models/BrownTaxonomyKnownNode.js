import mongoose from "mongoose";

const brownTaxonomyKnownNodeSchema = new mongoose.Schema(
  {
    scope: {
      type: String,
      enum: ["category", "subcategory", "collection"],
      required: true,
    },
    targetId: { type: String, required: true },
    name: { type: String, default: "" },
    path: { type: String, default: "" },
    firstSeenAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

brownTaxonomyKnownNodeSchema.index({ scope: 1, targetId: 1 }, { unique: true });

export const BrownTaxonomyKnownNode = mongoose.model(
  "BrownTaxonomyKnownNode",
  brownTaxonomyKnownNodeSchema
);
