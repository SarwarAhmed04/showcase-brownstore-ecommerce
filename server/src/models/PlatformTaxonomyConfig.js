import mongoose from "mongoose";

const platformTaxonomyConfigSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true },
    brownCollectionId: { type: String, required: true },
    values: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

platformTaxonomyConfigSchema.index({ partner: 1, brownCollectionId: 1 }, { unique: true });

export const PlatformTaxonomyConfig = mongoose.model(
  "PlatformTaxonomyConfig",
  platformTaxonomyConfigSchema
);
