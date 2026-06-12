const mongoose = require("mongoose");

const LearningLevelSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, default: "", trim: true },
    classLevel: { type: String, default: "Beginner", trim: true },
    targetLanguage: { type: String, default: "kr", trim: true, lowercase: true },
    translationLanguage: { type: String, default: "kh", trim: true, lowercase: true },
    translationLanguages: [{ type: String, trim: true, lowercase: true }],
    accentColor: { type: String, default: "#0f766e", trim: true },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

LearningLevelSchema.index({ status: 1, order: 1, title: 1 });
LearningLevelSchema.index({ title: "text", description: "text", classLevel: "text" });

module.exports = mongoose.model("LearningLevel", LearningLevelSchema);
