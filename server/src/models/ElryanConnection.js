import mongoose from "mongoose";

const elryanConnectionSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, required: true, unique: true, default: "default" },
    environment: { type: String, default: "staging", enum: ["staging", "production"] },
    /** @deprecated Prefer stagingApiKeyEnc / productionApiKeyEnc. Kept for existing installs. */
    apiKeyEnc: { type: String, default: "", select: false },
    stagingApiKeyEnc: { type: String, default: "", select: false },
    productionApiKeyEnc: { type: String, default: "", select: false },
    /** Derived cache only — public status always re-checks decryptability. */
    hasApiKey: { type: Boolean, default: false },
    lastStatus: { type: String, default: "awaiting_access" },
    lastHttpStatus: { type: Number, default: 0 },
    lastEndpoint: { type: String, default: "" },
    lastError: { type: String, default: "" },
    lastAuthOk: { type: Boolean, default: false },
    lastReachable: { type: Boolean, default: false },
    lastTestedAt: { type: Date, default: null },
    lastSuccessAt: { type: Date, default: null },
    lastAuthVerifiedAt: { type: Date, default: null },
    lastClassification: { type: String, default: "" },
  },
  { timestamps: true }
);

export const ElryanConnection = mongoose.model("ElryanConnection", elryanConnectionSchema);
