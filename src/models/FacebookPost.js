const mongoose = require("mongoose");

const FacebookPostSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item", required: true },
    scheduledDate: { type: String, required: true },
    pageId: { type: String, default: "" },
    caption: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    shareUrl: { type: String, default: "" },
    status: { type: String, enum: ["pending", "published", "failed", "rejected", "deleted"], default: "pending", index: true },
    facebookPostId: { type: String, default: "" },
    facebookPhotoId: { type: String, default: "" },
    error: { type: String, default: "" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

FacebookPostSchema.index({ scheduledDate: 1, status: 1 });
FacebookPostSchema.index({ itemId: 1, status: 1 });
FacebookPostSchema.index({ publishedAt: -1 });

module.exports = mongoose.model("FacebookPost", FacebookPostSchema);
