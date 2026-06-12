const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast } = require("../middleware/rbac");
const LearningLevel = require("../models/LearningLevel");
const LearningLesson = require("../models/LearningLesson");

const router = express.Router();

const slugify = (value, fallback = "learning") =>
  String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || fallback;

const cleanStatus = (value) => (value === "published" ? "published" : "draft");
const cleanLang = (value, fallback) =>
  String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z-]/g, "")
    .slice(0, 12) || fallback;

const cleanLangList = (value, fallback = ["kh", "kr"]) => {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  const langs = Array.from(new Set(source.map((item) => cleanLang(item, "")).filter(Boolean).filter((code) => code !== "en")));
  return langs.length >= 2 ? langs.slice(0, 8) : fallback;
};

const normalizeTranslationMap = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value).reduce((acc, [rawCode, entry]) => {
    const code = cleanLang(rawCode, "");
    if (!code || code === "en") return acc;
    const item = entry && typeof entry === "object" ? entry : {};
    const examples = Array.isArray(item.examples)
      ? item.examples.map((example) => String(example || "").trim()).filter(Boolean).slice(0, 20)
      : [];
    acc[code] = {
      word: String(item.word || "").trim(),
      pronunciation: String(item.pronunciation || "").trim(),
      meaning: String(item.meaning || "").trim(),
      examples,
    };
    return acc;
  }, {});
};

const normalizeExamples = (examples) =>
  (Array.isArray(examples) ? examples : [])
    .map((example) => {
      const translations = example?.translations && typeof example.translations === "object" && !Array.isArray(example.translations)
        ? Object.entries(example.translations).reduce((acc, [rawCode, value]) => {
            const code = cleanLang(rawCode, "");
            const text = String(value || "").trim();
            if (code && code !== "en" && text) acc[code] = text;
            return acc;
          }, {})
        : {};
      return {
        selected: String(example?.selected || "").trim(),
        english: String(example?.english || "").trim(),
        meaning: String(example?.meaning || "").trim(),
        translations,
      };
    })
    .filter((example) => example.selected || example.english || example.meaning || Object.keys(example.translations).length)
    .slice(0, 8);

const normalizeWords = (words) =>
  (Array.isArray(words) ? words : [])
    .map((word) => ({
      word: String(word?.word || "").trim(),
      pronunciation: String(word?.pronunciation || "").trim(),
      english: String(word?.english || "").trim(),
      meaning: String(word?.meaning || "").trim(),
      imageUrl: String(word?.imageUrl || "").trim(),
      examples: normalizeExamples(word?.examples),
      translations: normalizeTranslationMap(word?.translations),
    }))
    .filter((word) => word.word)
    .slice(0, 80);

const normalizeQuiz = (quiz) =>
  (Array.isArray(quiz) ? quiz : [])
    .map((item) => ({
      type: ["choice", "fill", "image-choice"].includes(item?.type) ? item.type : "choice",
      prompt: String(item?.prompt || "").trim(),
      answer: String(item?.answer || "").trim(),
      helperText: String(item?.helperText || "").trim(),
      imageUrl: String(item?.imageUrl || "").trim(),
      options: (Array.isArray(item?.options) ? item.options : [])
        .map((option) => ({
          text: String(option?.text || "").trim(),
          meaning: String(option?.meaning || "").trim(),
        }))
        .filter((option) => option.text || option.meaning)
        .slice(0, 8),
      translations: item?.translations && typeof item.translations === "object" ? item.translations : {},
    }))
    .filter((item) => item.prompt || item.answer || item.options.length)
    .slice(0, 40);

const normalizeContentBlocks = (blocks) =>
  (Array.isArray(blocks) ? blocks : [])
    .map((block, index) => {
      const type = block?.type === "quiz" ? "quiz" : "word";
      const order = Number(block?.order) || index + 1;
      if (type === "quiz") {
        const quiz = normalizeQuiz([block?.quiz || block])[0];
        return quiz ? { type, order, quiz } : null;
      }
      const word = normalizeWords([block?.word || block])[0];
      return word ? { type, order, word } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .slice(0, 200);

const serialize = (doc = {}) => ({
  ...doc,
  id: String(doc._id || doc.id || ""),
  levelId: doc.levelId ? String(doc.levelId) : undefined,
  createdBy: doc.createdBy ? String(doc.createdBy?._id || doc.createdBy) : "",
  creatorName:
    (doc.createdBy && typeof doc.createdBy === "object"
      ? String(doc.createdBy.name || doc.createdBy.email || "").trim()
      : "") || String(doc.creatorName || "").trim(),
});

const withLessonCounts = async (levels) => {
  const ids = levels.map((level) => level._id);
  const lessons = await LearningLesson.find({ levelId: { $in: ids }, status: "published" })
    .select("_id levelId slug order title")
    .sort({ order: 1, title: 1 })
    .lean();
  const grouped = lessons.reduce((acc, lesson) => {
    const key = String(lesson.levelId || "");
    if (!acc[key]) acc[key] = [];
    acc[key].push(lesson);
    return acc;
  }, {});
  return levels.map((level) => {
    const levelLessons = grouped[String(level._id)] || [];
    return {
      ...serialize(level),
      lessonCount: levelLessons.length,
      firstLessonSlug: levelLessons[0]?.slug || "",
    };
  });
};

const staffFilter = (req, extra = {}) => {
  if (req.user?.role === "owner") return extra;
  return { ...extra, createdBy: req.user.id };
};

const levelPayload = (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  return {
    title,
    slug: slugify(body.slug || title, "level"),
    description: String(body.description || "").trim(),
    classLevel: String(body.classLevel || "Beginner").trim() || "Beginner",
    targetLanguage: cleanLang(body.targetLanguage, "kr"),
    translationLanguage: cleanLang(body.translationLanguage, "kh"),
    translationLanguages: cleanLangList(body.translationLanguages, [cleanLang(body.translationLanguage, "kh"), cleanLang(body.targetLanguage, "kr")]),
    accentColor: /^#[0-9a-f]{6}$/i.test(String(body.accentColor || "")) ? body.accentColor : "#0f766e",
    status: cleanStatus(body.status),
    order: Number(body.order) || 0,
    updatedBy: user.id,
  };
};

const lessonPayload = (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  const contentBlocks = normalizeContentBlocks(body.contentBlocks);
  const words = contentBlocks.length ? contentBlocks.filter((block) => block.type === "word").map((block) => block.word) : normalizeWords(body.words);
  const quiz = contentBlocks.length ? contentBlocks.filter((block) => block.type === "quiz").map((block) => block.quiz) : normalizeQuiz(body.quiz);
  return {
    title,
    slug: slugify(body.slug || title, "lesson"),
    summary: String(body.summary || "").trim(),
    difficulty: String(body.difficulty || "Beginner").trim() || "Beginner",
    estimatedMinutes: Math.min(Math.max(Number(body.estimatedMinutes) || 8, 1), 240),
    quizAfterWords: Math.min(Math.max(Number(body.quizAfterWords) || 0, 0), 1000),
    words,
    quiz,
    contentBlocks,
    status: cleanStatus(body.status),
    order: Number(body.order) || 0,
    updatedBy: user.id,
  };
};

const assertLevel = (payload, res) => {
  if (!payload.title) {
    res.status(400).json({ message: "Level title is required." });
    return false;
  }
  if (!payload.slug) {
    res.status(400).json({ message: "Level slug is required." });
    return false;
  }
  return true;
};

const assertLesson = (payload, res) => {
  if (!payload.title) {
    res.status(400).json({ message: "Lesson title is required." });
    return false;
  }
  if (!payload.slug) {
    res.status(400).json({ message: "Lesson slug is required." });
    return false;
  }
  if (payload.status === "published" && payload.words.length === 0) {
    res.status(400).json({ message: "Add at least one word before publishing this lesson." });
    return false;
  }
  return true;
};

router.get("/public/levels", async (_req, res) => {
  const levels = await LearningLevel.find({ status: "published" })
    .populate("createdBy", "name email")
    .sort({ order: 1, title: 1 })
    .lean();
  res.json({ levels: await withLessonCounts(levels) });
});

router.get("/public/levels/:levelSlug", async (req, res) => {
  const level = await LearningLevel.findOne({ slug: req.params.levelSlug, status: "published" })
    .populate("createdBy", "name email")
    .lean();
  if (!level) return res.status(404).json({ message: "Learning level not found." });
  const lessons = await LearningLesson.find({ levelId: level._id, status: "published" })
    .sort({ order: 1, title: 1 })
    .lean();
  res.json({ level: serialize(level), lessons: lessons.map(serialize) });
});

router.get("/public/levels/:levelSlug/lessons/:lessonSlug", async (req, res) => {
  const level = await LearningLevel.findOne({ slug: req.params.levelSlug, status: "published" })
    .populate("createdBy", "name email")
    .lean();
  if (!level) return res.status(404).json({ message: "Learning level not found." });
  const lessons = await LearningLesson.find({ levelId: level._id, status: "published" })
    .sort({ order: 1, title: 1 })
    .lean();
  const lesson = lessons.find((entry) => entry.slug === req.params.lessonSlug) || lessons[0];
  if (!lesson) return res.status(404).json({ message: "Learning lesson not found." });
  res.json({ level: serialize(level), lesson: serialize(lesson), lessons: lessons.map(serialize) });
});

router.use(authRequired, requireRoleAtLeast("editor"));

router.get("/levels", async (req, res) => {
  const { q, status } = req.query || {};
  const filter = staffFilter(req);
  if (status && ["draft", "published"].includes(status)) filter.status = status;
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim() };
  const levels = await LearningLevel.find(filter)
    .populate("createdBy", "name email")
    .sort({ order: 1, updatedAt: -1 })
    .limit(300)
    .lean();
  res.json({ levels: await withLessonCounts(levels) });
});

router.post("/levels", async (req, res) => {
  const payload = { ...levelPayload(req.body, req.user), createdBy: req.user.id };
  if (!assertLevel(payload, res)) return;
  try {
    const level = await LearningLevel.create(payload);
    res.json({ level: serialize(level.toObject()) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A learning level with this slug already exists." });
    throw err;
  }
});

router.patch("/levels/:id", async (req, res) => {
  const payload = levelPayload(req.body, req.user);
  if (!assertLevel(payload, res)) return;
  try {
    const level = await LearningLevel.findOneAndUpdate(staffFilter(req, { _id: req.params.id }), { $set: payload }, { new: true, runValidators: true }).lean();
    if (!level) return res.status(404).json({ message: "Learning level not found." });
    res.json({ level: serialize(level) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A learning level with this slug already exists." });
    throw err;
  }
});

router.delete("/levels/:id", async (req, res) => {
  const deleted = await LearningLevel.findOneAndDelete(staffFilter(req, { _id: req.params.id })).lean();
  if (!deleted) return res.status(404).json({ message: "Learning level not found." });
  await LearningLesson.deleteMany({ levelId: deleted._id });
  res.json({ ok: true });
});

router.get("/levels/:levelId/lessons", async (req, res) => {
  const level = await LearningLevel.findOne(staffFilter(req, { _id: req.params.levelId })).lean();
  if (!level) return res.status(404).json({ message: "Learning level not found." });
  const lessons = await LearningLesson.find(staffFilter(req, { levelId: level._id }))
    .populate("createdBy", "name email")
    .sort({ order: 1, updatedAt: -1 })
    .lean();
  res.json({ lessons: lessons.map(serialize) });
});

router.post("/levels/:levelId/lessons", async (req, res) => {
  const level = await LearningLevel.findOne(staffFilter(req, { _id: req.params.levelId })).lean();
  if (!level) return res.status(404).json({ message: "Learning level not found." });
  const payload = { ...lessonPayload(req.body, req.user), levelId: level._id, createdBy: req.user.id };
  if (!assertLesson(payload, res)) return;
  try {
    const lesson = await LearningLesson.create(payload);
    res.json({ lesson: serialize(lesson.toObject()) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A lesson with this slug already exists for this level." });
    throw err;
  }
});

router.patch("/lessons/:id", async (req, res) => {
  const existing = await LearningLesson.findOne(staffFilter(req, { _id: req.params.id })).lean();
  if (!existing) return res.status(404).json({ message: "Learning lesson not found." });
  const level = await LearningLevel.findOne(staffFilter(req, { _id: existing.levelId })).lean();
  if (!level) return res.status(404).json({ message: "Learning level not found." });
  const payload = lessonPayload(req.body, req.user);
  if (!assertLesson(payload, res)) return;
  try {
    const lesson = await LearningLesson.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).lean();
    res.json({ lesson: serialize(lesson) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A lesson with this slug already exists for this level." });
    throw err;
  }
});

router.delete("/lessons/:id", async (req, res) => {
  const deleted = await LearningLesson.findOneAndDelete(staffFilter(req, { _id: req.params.id })).lean();
  if (!deleted) return res.status(404).json({ message: "Learning lesson not found." });
  res.json({ ok: true });
});

module.exports = router;
