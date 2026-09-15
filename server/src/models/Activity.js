import mongoose from "mongoose";

export const ACTIVITY_ACTIONS = [
  "commission.save",
  "commission.toggle",
  "commission.delete",
  "partner.api_key",
  "platform.create",
  "platform.update",
  "platform.delete",
  "platform.product",
  "account.create",
  "account.delete",
  "product.update",
  "catalog.sync",
  "category.update",
  "category.image",
  "settings.update",
  "enquiry.create",
];

export const ACTIVITY_GROUPS = {
  commission: [
    "commission.save",
    "commission.toggle",
    "commission.delete",
    "platform.create",
    "platform.update",
    "platform.delete",
    "platform.product",
  ],
  api: ["partner.api_key"],
  account: ["account.create", "account.delete"],
  product: ["product.update"],
  sync: ["catalog.sync"],
  category: ["category.update", "category.image", "settings.update"],
  enquiry: ["enquiry.create"],
};

const activitySchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    actorEmail: { type: String, default: "", index: true },
    action: { type: String, enum: ACTIVITY_ACTIONS, required: true, index: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

activitySchema.index({ createdAt: -1 });

export const Activity = mongoose.model("Activity", activitySchema);
