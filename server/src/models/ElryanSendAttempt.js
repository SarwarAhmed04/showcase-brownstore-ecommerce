import mongoose from "mongoose";

/** One Staging create attempt per product. Uncertain and in-progress rows stay blocked until a separate reconciliation release. */
const elryanSendAttemptSchema = new mongoose.Schema(
  {
    environment: { type: String, required: true, enum: ["staging"] },
    productId: { type: String, required: true },
    sku: { type: String, default: "" },
    status: {
      type: String,
      required: true,
      enum: ["in_progress", "succeeded", "failed", "uncertain"],
    },
    payloadHash: { type: String, default: "" },
    elryanProductId: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    published: { type: Boolean, default: false },
    errorCode: { type: String, default: "" },
    errorMessage: { type: String, default: "" },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

elryanSendAttemptSchema.index({ environment: 1, productId: 1 }, { unique: true });

export const ElryanSendAttempt = mongoose.model("ElryanSendAttempt", elryanSendAttemptSchema);
