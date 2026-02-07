// backend/src/models/Translation.js
const mongoose = require("mongoose");

const TranslationSchema = new mongoose.Schema(
  {
    lang: { type: String, required: true, unique: true, lowercase: true, trim: true },
    messages: { type: Map, of: String, default: {} },
    fontFamily: { type: String, default: "" },
    fontOverrides: { type: Map, of: String, default: {} },
    isEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Translation", TranslationSchema);
