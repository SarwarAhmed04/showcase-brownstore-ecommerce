import mongoose from "mongoose";

const platformTaxonomyNoticeSchema = new mongoose.Schema(
  {
    partner: { type: String, required: true },
    scope: {
      type: String,
      enum: ["category", "subcategory", "collection"],
      required: true,
    },
    targetId: { type: String, required: true },
    name: { type: String, default: "" },
    path: { type: String, default: "" },
    firstSeenAt: { type: Date, default: Date.now },
    status: { type: String, enum: ["open", "resolved"], default: "open" },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

platformTaxonomyNoticeSchema.index({ partner: 1, scope: 1, targetId: 1 }, { unique: true });
platformTaxonomyNoticeSchema.index({ partner: 1, status: 1 });

export const PlatformTaxonomyNotice = mongoose.model(
  "PlatformTaxonomyNotice",
  platformTaxonomyNoticeSchema
);
