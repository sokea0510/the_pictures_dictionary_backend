// backend/src/models/ChangeRequest.js

const mongoose = require("mongoose");

const ChangeRequestSchema = new mongoose.Schema(
  {
    entityType: { type: String, enum: ["language", "category", "item", "ad", "user"], required: true },
    action: { type: String, enum: ["create", "update", "delete"], required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    payload: { type: Object, default: {} },

    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    reviewNote: { type: String, default: "" }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ChangeRequest", ChangeRequestSchema);
