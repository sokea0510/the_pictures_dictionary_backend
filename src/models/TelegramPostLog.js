const mongoose = require("mongoose");

const TelegramPostLogSchema = new mongoose.Schema(
  {
    postDate: { type: String, required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    channelId: { type: String, required: true },
    messageId: { type: Number, default: null },
    caption: { type: String, default: "" },
    status: { type: String, enum: ["sent", "failed"], required: true },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

TelegramPostLogSchema.index({ postDate: 1, channelId: 1 }, { unique: true });
TelegramPostLogSchema.index({ itemId: 1, createdAt: -1 });

module.exports = mongoose.model("TelegramPostLog", TelegramPostLogSchema);
