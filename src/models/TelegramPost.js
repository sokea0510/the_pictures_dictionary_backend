const mongoose = require("mongoose");

const TelegramPostSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    scheduledDate: { type: String, required: true },
    channelId: { type: String, default: "" },
    caption: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    shareUrl: { type: String, default: "" },
    status: { type: String, enum: ["pending", "published", "failed", "rejected", "deleted"], default: "pending", index: true },
    messageId: { type: Number, default: null },
    error: { type: String, default: "" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

TelegramPostSchema.index({ scheduledDate: 1, status: 1 });
TelegramPostSchema.index({ itemId: 1, status: 1 });
TelegramPostSchema.index({ publishedAt: -1 });

module.exports = mongoose.model("TelegramPost", TelegramPostSchema);
