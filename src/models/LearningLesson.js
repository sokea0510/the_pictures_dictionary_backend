const mongoose = require("mongoose");

const LearningExampleSchema = new mongoose.Schema(
  {
    selected: { type: String, default: "", trim: true },
    english: { type: String, default: "", trim: true },
    meaning: { type: String, default: "", trim: true },
    translations: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const LearningWordSchema = new mongoose.Schema(
  {
    word: { type: String, required: true, trim: true },
    pronunciation: { type: String, default: "", trim: true },
    english: { type: String, default: "", trim: true },
    meaning: { type: String, default: "", trim: true },
    imageUrl: { type: String, default: "", trim: true },
    examples: { type: [LearningExampleSchema], default: [] },
    translations: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const LearningQuizOptionSchema = new mongoose.Schema(
  {
    text: { type: String, default: "", trim: true },
    meaning: { type: String, default: "", trim: true },
  },
  { _id: true }
);

const LearningQuizSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ["choice", "fill", "image-choice"], default: "choice" },
    prompt: { type: String, default: "", trim: true },
    answer: { type: String, default: "", trim: true },
    helperText: { type: String, default: "", trim: true },
    imageUrl: { type: String, default: "", trim: true },
    options: { type: [LearningQuizOptionSchema], default: [] },
    translations: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { _id: true }
);

const LearningLessonSchema = new mongoose.Schema(
  {
    levelId: { type: mongoose.Schema.Types.ObjectId, ref: "LearningLevel", required: true, index: true },
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    summary: { type: String, default: "", trim: true },
    difficulty: { type: String, default: "Beginner", trim: true },
    estimatedMinutes: { type: Number, default: 8, min: 1, max: 240 },
    quizAfterWords: { type: Number, default: 0, min: 0, max: 1000 },
    words: { type: [LearningWordSchema], default: [] },
    quiz: { type: [LearningQuizSchema], default: [] },
    contentBlocks: { type: [mongoose.Schema.Types.Mixed], default: [] },
    status: { type: String, enum: ["draft", "published"], default: "draft" },
    order: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

LearningLessonSchema.index({ levelId: 1, slug: 1 }, { unique: true });
LearningLessonSchema.index({ levelId: 1, status: 1, order: 1 });
LearningLessonSchema.index({ title: "text", summary: "text", "words.word": "text", "words.english": "text", "words.meaning": "text" });

module.exports = mongoose.model("LearningLesson", LearningLessonSchema);
