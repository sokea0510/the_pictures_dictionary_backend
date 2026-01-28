// backend/src/models/TranslationUsage.js

const mongoose = require("mongoose");

const TranslationUsageSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true },
    yearMonth: { type: String, required: true },
    chars: { type: Number, default: 0 },
  },
  { timestamps: true }
);

TranslationUsageSchema.index({ provider: 1, yearMonth: 1 }, { unique: true });

module.exports = mongoose.model("TranslationUsage", TranslationUsageSchema);
