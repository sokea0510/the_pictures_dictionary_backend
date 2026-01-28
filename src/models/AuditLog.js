// backend/src/models/AuditLog.js

const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    action: String,
    entityType: String,
    entityId: mongoose.Schema.Types.ObjectId,
    meta: { type: Object, default: {} }
  },
  { timestamps: true }
);

module.exports = mongoose.model("AuditLog", AuditLogSchema);
