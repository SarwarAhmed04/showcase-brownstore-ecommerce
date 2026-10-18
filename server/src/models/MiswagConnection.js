import mongoose from "mongoose";

const miswagConnectionSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: "default" },
    baseUrl: { type: String, default: "" },
    apiKeyEnc: { type: String, default: "", select: false },
    apiSecretEnc: { type: String, default: "", select: false },
    apiKeyPrefix: { type: String, default: "" },
    hasApiKey: { type: Boolean, default: false },
    hasApiSecret: { type: Boolean, default: false },
    lastStatus: { type: String, default: "not_configured" },
    lastHttpStatus: { type: Number, default: 0 },
    lastEndpoint: { type: String, default: "" },
    lastBaseUrl: { type: String, default: "" },
    lastResponseMs: { type: Number, default: 0 },
    lastAuthOk: { type: Boolean, default: false },
    lastError: { type: String, default: "" },
    lastTestedAt: { type: Date, default: null },
    connectedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const MiswagConnection = mongoose.model("MiswagConnection", miswagConnectionSchema);
