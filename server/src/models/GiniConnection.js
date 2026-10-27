import mongoose from "mongoose";

const giniConnectionSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: "default" },
    baseUrl: { type: String, default: "" },
    clientId: { type: String, default: "" },
    clientSecretEnc: { type: String, default: "", select: false },
    hasSecret: { type: Boolean, default: false },
    lastStatus: { type: String, default: "not_configured" },
    lastHttpStatus: { type: Number, default: 0 },
    lastEndpoint: { type: String, default: "" },
    lastError: { type: String, default: "" },
    lastAuthOk: { type: Boolean, default: false },
    lastTestedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastCategoriesOk: { type: Boolean, default: false },
    lastCategoriesCount: { type: Number, default: 0 },
    lastCategoriesError: { type: String, default: "" },
  },
  { timestamps: true }
);

export const GiniConnection = mongoose.model("GiniConnection", giniConnectionSchema);
