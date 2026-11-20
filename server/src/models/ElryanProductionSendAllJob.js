import mongoose from "mongoose";

const elryanProductionSendAllJobSchema = new mongoose.Schema(
  {
    previewId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    environment: { type: String, required: true, enum: ["production"], default: "production" },
    status: { type: String, enum: ["running", "completed", "blocked"], default: "running", index: true },
    expectedCount: { type: Number, required: true },
    total: { type: Number, default: 0 },
    processed: { type: Number, default: 0 },
    sent: { type: Number, default: 0 },
    skipped: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    uncertain: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

elryanProductionSendAllJobSchema.index({ previewId: 1, createdAt: -1 });

export const ElryanProductionSendAllJob = mongoose.model(
  "ElryanProductionSendAllJob",
  elryanProductionSendAllJobSchema
);
