// backend/src/models/Notification.js

const mongoose = require("mongoose");

const NotificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    type: { type: String, default: "general", index: true },
    title: { type: String, default: "" },
    body: { type: String, default: "" },
    link: { type: String, default: "" },
    imageUrl: { type: String, default: "" },
    status: { type: String, default: "" },
    meta: { type: Object, default: {} },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Notification", NotificationSchema);
