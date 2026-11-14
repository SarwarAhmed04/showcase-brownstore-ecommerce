import mongoose from "mongoose";

const categorySyncAuditSchema = new mongoose.Schema(
  {
    mode: { type: String, required: true },
    removed: { type: Number, default: 0 },
    quarantined: { type: Number, default: 0 },
    referenced: { type: Number, default: 0 },
    cleared: { type: Number, default: 0 },
    missingCount: { type: Number, default: 0 },
    remoteTotal: { type: Number, default: 0 },
    localTotal: { type: Number, default: 0 },
    deleteIds: { type: [String], default: [] },
    quarantineIds: { type: [String], default: [] },
    referencedIds: { type: [String], default: [] },
    at: { type: Date, required: true },
  },
  { timestamps: false, autoIndex: false, autoCreate: false }
);

export const CategorySyncAudit = mongoose.models.CategorySyncAudit
  || mongoose.model("CategorySyncAudit", categorySyncAuditSchema);
