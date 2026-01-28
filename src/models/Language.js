// backend/src/models/Language.js

const mongoose = require("mongoose");

const LanguageSchema = new mongoose.Schema(
  {
    code: { type: String, unique: true, required: true, lowercase: true, trim: true },
    name: { type: String, required: true },
    isEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Language", LanguageSchema);
