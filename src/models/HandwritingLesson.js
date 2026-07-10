const mongoose = require("mongoose");

const HandwritingLessonSchema = new mongoose.Schema(
  {
    languageCode: { type: String, required: true, trim: true, lowercase: true, index: true },
    languageName: { type: String, required: true, trim: true },
    script: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    letter: { type: String, required: true, trim: true },
    sound: { type: String, default: "", trim: true },
    howToWrite: { type: String, default: "", trim: true },
    focusPoint: { type: String, default: "", trim: true },
    modelText: { type: String, default: "", trim: true },
    modelImageUrl: { type: String, default: "", trim: true },
    traceText: { type: String, default: "", trim: true },
    status: { type: String, enum: ["draft", "published"], default: "draft", index: true },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

HandwritingLessonSchema.index({ languageCode: 1, status: 1, order: 1 });
HandwritingLessonSchema.index({ languageCode: 1, order: 1, letter: 1 });
HandwritingLessonSchema.index({ languageName: "text", script: "text", category: "text", letter: "text", sound: "text" });

module.exports = mongoose.model("HandwritingLesson", HandwritingLessonSchema);
