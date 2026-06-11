const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireAnyRole } = require("../middleware/rbac");
const TutorialSubject = require("../models/TutorialSubject");
const TutorialLesson = require("../models/TutorialLesson");

const router = express.Router();

const slugify = (value, fallback = "tutorial") =>
  String(value || fallback)
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90) || fallback;

const cleanStatus = (value) => (value === "draft" ? "draft" : "published");
const cleanSourceFormat = (value) => (["text", "html", "runnable-html"].includes(value) ? value : "text");

const subjectPayload = (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  return {
    title,
    slug: slugify(body.slug || title, "tutorial"),
    description: String(body.description || "").trim(),
    iconKey: String(body.iconKey || "book").trim() || "book",
    level: String(body.level || "Beginner").trim() || "Beginner",
    status: cleanStatus(body.status),
    order: Number(body.order) || 0,
    updatedBy: user.id,
  };
};

const lessonPayload = (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  const sections = Array.isArray(body.sections)
    ? body.sections
        .map((section) => ({
          title: String(section?.title || "").trim(),
          content: String(section?.content || ""),
          contentHtml: String(section?.contentHtml || ""),
        }))
        .filter((section) => section.title || section.content.trim() || section.contentHtml.trim())
        .slice(0, 40)
    : [];
  return {
    title,
    slug: slugify(body.slug || title, "lesson"),
    summary: String(body.summary || "").trim(),
    content: String(body.content || ""),
    contentHtml: String(body.contentHtml || ""),
    sourceFormat: cleanSourceFormat(body.sourceFormat),
    fontFamily: String(body.fontFamily || "Inter").trim() || "Inter",
    sections,
    status: cleanStatus(body.status),
    order: Number(body.order) || 0,
    updatedBy: user.id,
  };
};

const subjectFields = "_id title slug description iconKey level status order createdAt updatedAt";
const lessonFields = "_id subjectId title slug summary content contentHtml sourceFormat fontFamily sections status order createdAt updatedAt";

const serializeLesson = (lesson = {}) => ({
  ...lesson,
  id: String(lesson._id || lesson.id || ""),
  subjectId: String(lesson.subjectId || ""),
});

const serializeSubject = (subject = {}, lessons = []) => ({
  ...subject,
  id: String(subject._id || subject.id || ""),
  lessonCount: lessons.length,
  firstLessonSlug: lessons[0]?.slug || "",
});

const assertSubject = (payload, res) => {
  if (!payload.title) {
    res.status(400).json({ message: "Subject title is required." });
    return false;
  }
  if (!payload.slug) {
    res.status(400).json({ message: "Subject slug is required." });
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
  return true;
};

router.get("/public/subjects", async (_req, res) => {
  const subjects = await TutorialSubject.find({ status: "published" })
    .select(subjectFields)
    .sort({ order: 1, title: 1 })
    .lean();
  const subjectIds = subjects.map((subject) => subject._id);
  const lessons = await TutorialLesson.find({ subjectId: { $in: subjectIds }, status: "published" })
    .select("_id subjectId slug order")
    .sort({ order: 1, title: 1 })
    .lean();
  const lessonsBySubject = lessons.reduce((acc, lesson) => {
    const key = String(lesson.subjectId || "");
    if (!acc[key]) acc[key] = [];
    acc[key].push(lesson);
    return acc;
  }, {});
  res.json({
    subjects: subjects.map((subject) => serializeSubject(subject, lessonsBySubject[String(subject._id)] || [])),
  });
});

router.get("/public/subjects/:subjectSlug", async (req, res) => {
  const subject = await TutorialSubject.findOne({ slug: req.params.subjectSlug, status: "published" })
    .select(subjectFields)
    .lean();
  if (!subject) return res.status(404).json({ message: "Tutorial subject not found." });
  const lessons = await TutorialLesson.find({ subjectId: subject._id, status: "published" })
    .select(lessonFields)
    .sort({ order: 1, title: 1 })
    .lean();
  res.json({
    subject: serializeSubject(subject, lessons),
    lessons: lessons.map(serializeLesson),
  });
});

router.get("/public/subjects/:subjectSlug/lessons/:lessonSlug", async (req, res) => {
  const subject = await TutorialSubject.findOne({ slug: req.params.subjectSlug, status: "published" })
    .select(subjectFields)
    .lean();
  if (!subject) return res.status(404).json({ message: "Tutorial subject not found." });
  const lessons = await TutorialLesson.find({ subjectId: subject._id, status: "published" })
    .select(lessonFields)
    .sort({ order: 1, title: 1 })
    .lean();
  const lesson = lessons.find((entry) => entry.slug === req.params.lessonSlug) || lessons[0];
  if (!lesson) return res.status(404).json({ message: "Tutorial lesson not found." });
  res.json({
    subject: serializeSubject(subject, lessons),
    lesson: serializeLesson(lesson),
    lessons: lessons.map(serializeLesson),
  });
});

router.use(authRequired, requireAnyRole(["admin", "owner"]));

router.get("/subjects", async (_req, res) => {
  const subjects = await TutorialSubject.find({})
    .select(subjectFields)
    .sort({ order: 1, title: 1 })
    .lean();
  const lessons = await TutorialLesson.find({ subjectId: { $in: subjects.map((subject) => subject._id) } })
    .select("_id subjectId slug order")
    .sort({ order: 1, title: 1 })
    .lean();
  const lessonsBySubject = lessons.reduce((acc, lesson) => {
    const key = String(lesson.subjectId || "");
    if (!acc[key]) acc[key] = [];
    acc[key].push(lesson);
    return acc;
  }, {});
  res.json({
    subjects: subjects.map((subject) => serializeSubject(subject, lessonsBySubject[String(subject._id)] || [])),
  });
});

router.post("/subjects", async (req, res) => {
  const payload = { ...subjectPayload(req.body, req.user), createdBy: req.user.id };
  if (!assertSubject(payload, res)) return;
  try {
    const subject = await TutorialSubject.create(payload);
    res.json({ subject: serializeSubject(subject.toObject(), []) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A subject with this slug already exists." });
    throw err;
  }
});

router.patch("/subjects/:id", async (req, res) => {
  const payload = subjectPayload(req.body, req.user);
  if (!assertSubject(payload, res)) return;
  try {
    const subject = await TutorialSubject.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).lean();
    if (!subject) return res.status(404).json({ message: "Tutorial subject not found." });
    res.json({ subject: serializeSubject(subject, []) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A subject with this slug already exists." });
    throw err;
  }
});

router.delete("/subjects/:id", async (req, res) => {
  const deleted = await TutorialSubject.findByIdAndDelete(req.params.id).lean();
  if (!deleted) return res.status(404).json({ message: "Tutorial subject not found." });
  await TutorialLesson.deleteMany({ subjectId: req.params.id });
  res.json({ ok: true });
});

router.get("/subjects/:subjectId/lessons", async (req, res) => {
  const lessons = await TutorialLesson.find({ subjectId: req.params.subjectId })
    .select(lessonFields)
    .sort({ order: 1, title: 1 })
    .lean();
  res.json({ lessons: lessons.map(serializeLesson) });
});

router.post("/subjects/:subjectId/lessons", async (req, res) => {
  const subject = await TutorialSubject.findById(req.params.subjectId).select("_id").lean();
  if (!subject) return res.status(404).json({ message: "Tutorial subject not found." });
  const payload = { ...lessonPayload(req.body, req.user), subjectId: subject._id, createdBy: req.user.id };
  if (!assertLesson(payload, res)) return;
  try {
    const lesson = await TutorialLesson.create(payload);
    res.json({ lesson: serializeLesson(lesson.toObject()) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A lesson with this slug already exists for this subject." });
    throw err;
  }
});

router.patch("/lessons/:id", async (req, res) => {
  const payload = lessonPayload(req.body, req.user);
  if (!assertLesson(payload, res)) return;
  try {
    const lesson = await TutorialLesson.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true }).lean();
    if (!lesson) return res.status(404).json({ message: "Tutorial lesson not found." });
    res.json({ lesson: serializeLesson(lesson) });
  } catch (err) {
    if (Number(err?.code) === 11000) return res.status(409).json({ message: "A lesson with this slug already exists for this subject." });
    throw err;
  }
});

router.delete("/lessons/:id", async (req, res) => {
  const deleted = await TutorialLesson.findByIdAndDelete(req.params.id).lean();
  if (!deleted) return res.status(404).json({ message: "Tutorial lesson not found." });
  res.json({ ok: true });
});

module.exports = router;
