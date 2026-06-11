const mongoose = require("mongoose");

const TutorialSubjectSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    description: { type: String, default: "", trim: true },
    iconKey: { type: String, default: "book", trim: true },
    level: { type: String, default: "Beginner", trim: true },
    status: { type: String, enum: ["draft", "published"], default: "published" },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

TutorialSubjectSchema.index({ status: 1, order: 1, title: 1 });
TutorialSubjectSchema.index({ title: "text", description: "text" });

module.exports = mongoose.model("TutorialSubject", TutorialSubjectSchema);
