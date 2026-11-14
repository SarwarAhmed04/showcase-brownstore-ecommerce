import mongoose from "mongoose";

const catalogSyncAuditSchema = new mongoose.Schema(
  {
    mode: { type: String, required: true },
    removed: { type: Number, default: 0 },
    quarantined: { type: Number, default: 0 },
    cleared: { type: Number, default: 0 },
    missingCount: { type: Number, default: 0 },
    remoteTotal: { type: Number, default: 0 },
    localTotal: { type: Number, default: 0 },
    deleteIds: { type: [String], default: [] },
    quarantineIds: { type: [String], default: [] },
    at: { type: Date, required: true },
  },
  { timestamps: false }
);

export const CatalogSyncAudit = mongoose.models.CatalogSyncAudit
  || mongoose.model("CatalogSyncAudit", catalogSyncAuditSchema);
