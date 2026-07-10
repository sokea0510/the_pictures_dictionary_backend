const mongoose = require("mongoose");

const HandwritingLanguageSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    name: { type: String, required: true, trim: true },
    script: { type: String, default: "", trim: true },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

HandwritingLanguageSchema.index({ status: 1, order: 1, name: 1 });
HandwritingLanguageSchema.index({ name: "text", script: "text", code: "text" });

module.exports = mongoose.model("HandwritingLanguage", HandwritingLanguageSchema);
