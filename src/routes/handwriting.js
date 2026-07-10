const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast } = require("../middleware/rbac");
const HandwritingLesson = require("../models/HandwritingLesson");
const HandwritingLanguage = require("../models/HandwritingLanguage");

const router = express.Router();

const cleanLang = (value, fallback = "") =>
  String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/[^a-z-]/g, "")
    .slice(0, 16) || fallback;

const cleanStatus = (value) => (value === "published" ? "published" : "draft");

const languagePayloadFromBody = (body = {}, user = {}) => ({
  code: cleanLang(body.code || body.languageCode, ""),
  name: String(body.name || body.languageName || "").trim(),
  script: String(body.script || "").trim(),
  status: cleanStatus(body.status),
  order: Number(body.order) || 0,
  updatedBy: user.id,
});

const assertLanguagePayload = (payload, res) => {
  if (!payload.code) {
    res.status(400).json({ message: "Language code is required." });
    return false;
  }
  if (!payload.name) {
    res.status(400).json({ message: "Language name is required." });
    return false;
  }
  return true;
};

const serializeLanguage = (doc = {}) => ({
  id: String(doc._id || doc.id || ""),
  code: doc.code || "",
  name: doc.name || "",
  script: doc.script || "",
  status: doc.status || "draft",
  order: Number(doc.order) || 0,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  createdBy: doc.createdBy ? String(doc.createdBy?._id || doc.createdBy) : "",
});

const serialize = (doc = {}) => ({
  id: String(doc._id || doc.id || ""),
  languageCode: doc.languageCode || "",
  languageName: doc.languageName || "",
  script: doc.script || "",
  category: doc.category || "",
  letter: doc.letter || "",
  sound: doc.sound || "",
  howToWrite: doc.howToWrite || "",
  focusPoint: doc.focusPoint || "",
  modelText: doc.modelText || "",
  modelImageUrl: doc.modelImageUrl || "",
  traceText: doc.traceText || "",
  status: doc.status || "draft",
  order: Number(doc.order) || 0,
  createdAt: doc.createdAt,
  updatedAt: doc.updatedAt,
  createdBy: doc.createdBy ? String(doc.createdBy?._id || doc.createdBy) : "",
  creatorName:
    (doc.createdBy && typeof doc.createdBy === "object"
      ? String(doc.createdBy.name || doc.createdBy.email || "").trim()
      : "") || "",
});

const payloadFromBody = (body = {}, user = {}) => ({
  languageCode: cleanLang(body.languageCode, "en"),
  languageName: String(body.languageName || "").trim(),
  script: String(body.script || "").trim(),
  category: String(body.category || "").trim(),
  letter: String(body.letter || "").trim(),
  sound: String(body.sound || body.pronunciation || "").trim(),
  howToWrite: String(body.howToWrite || body.steps || "").trim(),
  focusPoint: String(body.focusPoint || body.focus || "").trim(),
  modelText: String(body.modelText || body.glyph || body.letter || "").trim(),
  modelImageUrl: String(body.modelImageUrl || "").trim(),
  traceText: String(body.traceText || body.modelText || body.glyph || body.letter || "").trim(),
  status: cleanStatus(body.status),
  order: Number(body.order) || 0,
  updatedBy: user.id,
});

const assertPayload = (payload, res) => {
  if (!payload.languageCode) {
    res.status(400).json({ message: "Language code is required." });
    return false;
  }
  if (!payload.languageName) {
    res.status(400).json({ message: "Language name is required." });
    return false;
  }
  if (!payload.letter) {
    res.status(400).json({ message: "Letter is required." });
    return false;
  }
  if (payload.status === "published" && !payload.modelText && !payload.modelImageUrl && !payload.traceText) {
    res.status(400).json({ message: "Add model text, model image, or trace text before publishing." });
    return false;
  }
  return true;
};

const groupPublicLessons = (lessons = []) => {
  const byCode = new Map();
  lessons.forEach((lesson) => {
    const code = lesson.languageCode;
    if (!byCode.has(code)) {
      byCode.set(code, {
        code,
        name: lesson.languageName,
        script: lesson.script || "",
        lessons: [],
      });
    }
    const language = byCode.get(code);
    language.lessons.push({
      id: String(lesson._id),
      category: lesson.category || "",
      glyph: lesson.modelText || lesson.traceText || lesson.letter,
      label: lesson.letter,
      pronunciation: lesson.sound || "",
      steps: lesson.howToWrite || "",
      focus: lesson.focusPoint || "",
      modelText: lesson.modelText || "",
      modelImageUrl: lesson.modelImageUrl || "",
      traceText: lesson.traceText || lesson.modelText || lesson.letter,
    });
  });
  return Array.from(byCode.values()).filter((language) => language.lessons.length);
};

router.get("/public/languages", async (_req, res) => {
  const [allLanguages, lessons] = await Promise.all([
    HandwritingLanguage.find({}).sort({ order: 1, name: 1 }).lean(),
    HandwritingLesson.find({ status: "published" }).sort({ languageName: 1, order: 1, letter: 1 }).lean(),
  ]);
  const publishedLanguages = allLanguages.filter((language) => language.status === "published");
  const publishedCodes = new Set(publishedLanguages.map((language) => language.code));
  const languageMeta = new Map(publishedLanguages.map((language) => [language.code, language]));
  const hasManagedLanguages = allLanguages.length > 0;
  const visibleLessons = lessons
    .filter((lesson) => !hasManagedLanguages || publishedCodes.has(lesson.languageCode))
    .map((lesson) => {
      const meta = languageMeta.get(lesson.languageCode);
      return meta ? { ...lesson, languageName: meta.name, script: meta.script || lesson.script } : lesson;
    });
  res.json({ languages: groupPublicLessons(visibleLessons) });
});

router.use(authRequired, requireRoleAtLeast("editor"));

router.get("/languages", async (req, res) => {
  const { q, status } = req.query || {};
  const filter = {};
  if (status && ["draft", "published"].includes(status)) filter.status = status;
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim() };
  const languages = await HandwritingLanguage.find(filter)
    .sort({ order: 1, name: 1 })
    .limit(300)
    .lean();
  res.json({ languages: languages.map(serializeLanguage) });
});

router.post("/languages", async (req, res) => {
  const payload = { ...languagePayloadFromBody(req.body, req.user), createdBy: req.user.id };
  if (!assertLanguagePayload(payload, res)) return;
  try {
    const language = await HandwritingLanguage.create(payload);
    res.json({ language: serializeLanguage(language.toObject()) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A handwriting language with this code already exists." });
    throw err;
  }
});

router.patch("/languages/:id", async (req, res) => {
  const payload = languagePayloadFromBody(req.body, req.user);
  if (!assertLanguagePayload(payload, res)) return;
  const existing = await HandwritingLanguage.findById(req.params.id).lean();
  if (!existing) return res.status(404).json({ message: "Handwriting language not found." });
  try {
    const language = await HandwritingLanguage.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).lean();
    await HandwritingLesson.updateMany(
      { languageCode: existing.code },
      { $set: { languageCode: payload.code, languageName: payload.name, script: payload.script } }
    );
    res.json({ language: serializeLanguage(language) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A handwriting language with this code already exists." });
    throw err;
  }
});

router.delete("/languages/:id", async (req, res) => {
  const deleted = await HandwritingLanguage.findByIdAndDelete(req.params.id).lean();
  if (!deleted) return res.status(404).json({ message: "Handwriting language not found." });
  await HandwritingLesson.deleteMany({ languageCode: deleted.code });
  res.json({ ok: true });
});

router.get("/lessons", async (req, res) => {
  const { q, status, languageCode } = req.query || {};
  const filter = {};
  if (status && ["draft", "published"].includes(status)) filter.status = status;
  if (languageCode) filter.languageCode = cleanLang(languageCode, "");
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim() };
  const lessons = await HandwritingLesson.find(filter)
    .populate("createdBy", "name email")
    .sort({ languageName: 1, order: 1, updatedAt: -1 })
    .limit(500)
    .lean();
  res.json({ lessons: lessons.map(serialize) });
});

router.post("/lessons", async (req, res) => {
  const payload = { ...payloadFromBody(req.body, req.user), createdBy: req.user.id };
  if (!assertPayload(payload, res)) return;
  const lesson = await HandwritingLesson.create(payload);
  res.json({ lesson: serialize(lesson.toObject()) });
});

router.patch("/lessons/:id", async (req, res) => {
  const payload = payloadFromBody(req.body, req.user);
  if (!assertPayload(payload, res)) return;
  const lesson = await HandwritingLesson.findByIdAndUpdate(
    req.params.id,
    { $set: payload },
    { new: true, runValidators: true }
  ).lean();
  if (!lesson) return res.status(404).json({ message: "Handwriting lesson not found." });
  res.json({ lesson: serialize(lesson) });
});

router.delete("/lessons/:id", async (req, res) => {
  const deleted = await HandwritingLesson.findByIdAndDelete(req.params.id).lean();
  if (!deleted) return res.status(404).json({ message: "Handwriting lesson not found." });
  res.json({ ok: true });
});

module.exports = router;
