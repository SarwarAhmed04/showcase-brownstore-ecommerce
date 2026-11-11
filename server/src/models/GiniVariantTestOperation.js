import mongoose from "mongoose";

const giniVariantTestOperationSchema = new mongoose.Schema(
  {
    operationKey: { type: String, required: true, unique: true },
    productId: { type: String, required: true },
    parentSku: { type: String, required: true },
    status: {
      type: String,
      required: true,
      enum: [
        "parent_in_progress",
        "parent_uncertain",
        "parent_rejected",
        "parent_stopped",
        "parent_verified",
        "variants_in_progress",
        "variants_uncertain",
        "variants_verified",
      ],
    },
    lastCode: { type: String, default: "" },
    httpStatus: { type: Number, default: 0 },
    sanitizedSnippet: { type: String, default: "", maxlength: 300 },
    requestId: { type: String, default: "", maxlength: 64 },
    parentQuantity: { type: Number, default: null },
    parentVisibility: { type: String, default: "" },
  },
  { timestamps: true, autoIndex: false, autoCreate: false }
);

export const GiniVariantTestOperation = mongoose.model("GiniVariantTestOperation", giniVariantTestOperationSchema);
