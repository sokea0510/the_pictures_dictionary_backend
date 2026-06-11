const mongoose = require("mongoose");

const TutorialSectionSchema = new mongoose.Schema(
  {
    title: { type: String, default: "", trim: true },
    content: { type: String, default: "" },
    contentHtml: { type: String, default: "" },
  },
  { _id: true }
);

const TutorialLessonSchema = new mongoose.Schema(
  {
    subjectId: { type: mongoose.Schema.Types.ObjectId, ref: "TutorialSubject", required: true, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    summary: { type: String, default: "", trim: true },
    content: { type: String, default: "" },
    contentHtml: { type: String, default: "" },
    sourceFormat: { type: String, enum: ["text", "html", "runnable-html"], default: "text" },
    fontFamily: { type: String, default: "Inter", trim: true },
    sections: { type: [TutorialSectionSchema], default: [] },
    status: { type: String, enum: ["draft", "published"], default: "published" },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TutorialLessonSchema.index({ subjectId: 1, slug: 1 }, { unique: true });
TutorialLessonSchema.index({ subjectId: 1, status: 1, order: 1 });
TutorialLessonSchema.index({ title: "text", summary: "text", content: "text" });

module.exports = mongoose.model("TutorialLesson", TutorialLessonSchema);
