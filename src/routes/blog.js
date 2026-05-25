const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast } = require("../middleware/rbac");
const BlogPost = require("../models/BlogPost");
const User = require("../models/User");

const router = express.Router();

const slugify = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 12);
  return String(tags || "")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 12);
};

const normalizeLinks = (links) => {
  if (!Array.isArray(links)) return [];
  return links
    .map((link) => ({
      label: String(link?.label || "").trim(),
      url: String(link?.url || "").trim(),
    }))
    .filter((link) => link.label && /^https?:\/\//i.test(link.url))
    .slice(0, 10);
};

const normalizeLangCode = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  const key = raw.split(/[-_]/)[0];
  if (["km", "kh", "khmer"].includes(key)) return "kh";
  if (["kr", "ko", "korean"].includes(key)) return "kr";
  if (["en", "eng", "english"].includes(key)) return "en";
  return key;
};

const normalizeBlogTranslations = (translations = {}) => {
  const source = translations && typeof translations === "object" ? translations : {};
  return Object.entries(source).reduce((acc, [rawCode, value]) => {
    const code = normalizeLangCode(rawCode);
    if (!code) return acc;
    const entry = value && typeof value === "object" ? value : {};
    const title = String(entry.title || "").trim();
    const excerpt = String(entry.excerpt || "").trim();
    const content = String(entry.content || "");
    if (title || excerpt || content.trim()) {
      acc[code] = { title, excerpt, content };
    }
    return acc;
  }, {});
};

const resolveAuthor = async (user = {}) => {
  if (!user?.id) return { id: undefined, name: "" };
  const found = await User.findById(user.id).select("name email").lean();
  return {
    id: user.id,
    name: String(found?.name || found?.email || "").trim(),
  };
};

const makePayload = async (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  const status = body.status === "published" ? "published" : "draft";
  const publishedAt =
    status === "published"
      ? body.publishedAt
        ? new Date(body.publishedAt)
        : new Date()
      : null;
  const author = await resolveAuthor(user);
  const originalLanguage = normalizeLangCode(body.originalLanguage || body.language || "en") || "en";
  return {
    title,
    slug: slugify(body.slug || title),
    excerpt: String(body.excerpt || "").trim(),
    content: String(body.content || ""),
    originalLanguage,
    translations: normalizeBlogTranslations(body.translations),
    category: String(body.category || "Education").trim() || "Education",
    tags: normalizeTags(body.tags),
    coverImageUrl: String(body.coverImageUrl || "").trim(),
    coverImageAlt: String(body.coverImageAlt || "").trim(),
    links: normalizeLinks(body.links),
    status,
    featured: Boolean(body.featured),
    authorId: author.id,
    authorName: author.name,
    publishedAt,
  };
};

const assertValidPayload = (payload, res) => {
  if (!payload.title) {
    res.status(400).json({ message: "Title is required." });
    return false;
  }
  if (!payload.slug) {
    res.status(400).json({ message: "Slug is required." });
    return false;
  }
  if (payload.status === "published" && !payload.content.trim()) {
    res.status(400).json({ message: "Content is required before publishing." });
    return false;
  }
  return true;
};

const withResolvedAuthorName = (post = {}) => {
  const authorUser = post.authorId && typeof post.authorId === "object" ? post.authorId : null;
  const authorName = String(authorUser?.name || authorUser?.email || post.authorName || "").trim();
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const metrics = post.metrics || {};
  return {
    ...post,
    authorName: authorName || "Picture Dictionary Team",
    clapCount: Number(metrics.claps) || 0,
    shareCount: Number(metrics.shares) || 0,
    viewCount: Number(metrics.views) || 0,
    readMs: Number(metrics.readMs) || 0,
    readEvents: Number(metrics.readEvents) || 0,
    engagedReadCount: Number(metrics.engagedReads) || 0,
    maxScrollPercent: Number(metrics.maxScrollPercent) || 0,
    avgReadSeconds: metrics.readEvents ? Math.round((Number(metrics.readMs) || 0) / Number(metrics.readEvents) / 1000) : 0,
    commentCount: comments.length,
  };
};

const userInitials = (user = {}, fallback = "") => {
  const name = String(user.name || user.email || fallback || "U").trim();
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
};

const serializeComment = (comment = {}) => ({
  id: String(comment._id || comment.id || ""),
  authorId: String(comment.authorId || ""),
  authorName: String(comment.authorName || "").trim() || "Reader",
  authorInitials: String(comment.authorInitials || "").trim() || "R",
  text: String(comment.text || ""),
  edited: Boolean(comment.edited),
  date: comment.createdAt
    ? new Date(comment.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "",
});

router.get("/public", async (req, res) => {
  const { q, category, limit } = req.query || {};
  const filter = { status: "published" };
  if (category && category !== "All") filter.category = String(category);
  if (q && String(q).trim()) {
    filter.$text = { $search: String(q).trim() };
  }
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const posts = await BlogPost.find(filter)
    .populate("authorId", "name email")
    .sort({ featured: -1, publishedAt: -1, createdAt: -1 })
    .limit(max)
    .lean();
  res.json({ posts: posts.map(withResolvedAuthorName) });
});

router.get("/public/:slug", async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" })
    .populate("authorId", "name email")
    .lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  res.json({ post: withResolvedAuthorName(post) });
});

router.get("/public/:slug/comments", async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" }).select("comments").lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  res.json({ comments: (post.comments || []).map(serializeComment) });
});

router.post("/public/:slug/view", async (req, res) => {
  const post = await BlogPost.findOneAndUpdate(
    { slug: req.params.slug, status: "published" },
    { $inc: { "metrics.views": 1 } },
    { new: true }
  ).lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  res.json({ viewCount: Number(post.metrics?.views) || 0 });
});

router.post("/public/:slug/share", async (req, res) => {
  const post = await BlogPost.findOneAndUpdate(
    { slug: req.params.slug, status: "published" },
    { $inc: { "metrics.shares": 1 } },
    { new: true }
  ).lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  res.json({ shareCount: Number(post.metrics?.shares) || 0 });
});

router.post("/public/:slug/read", async (req, res) => {
  const durationMs = Math.min(Math.max(Number(req.body?.durationMs) || 0, 0), 30 * 60 * 1000);
  const scrollPercent = Math.min(Math.max(Number(req.body?.scrollPercent) || 0, 0), 100);
  if (durationMs < 1000 && scrollPercent < 5) {
    return res.json({ ok: true });
  }
  const engaged = durationMs >= 30000 || scrollPercent >= 60;
  const update = {
    $inc: {
      "metrics.readMs": durationMs,
      "metrics.readEvents": 1,
      ...(engaged ? { "metrics.engagedReads": 1 } : {}),
    },
    $max: { "metrics.maxScrollPercent": scrollPercent },
  };
  const post = await BlogPost.findOneAndUpdate(
    { slug: req.params.slug, status: "published" },
    update,
    { new: true }
  ).lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  const metrics = post.metrics || {};
  res.json({
    readMs: Number(metrics.readMs) || 0,
    readEvents: Number(metrics.readEvents) || 0,
    engagedReadCount: Number(metrics.engagedReads) || 0,
    maxScrollPercent: Number(metrics.maxScrollPercent) || 0,
    avgReadSeconds: metrics.readEvents ? Math.round((Number(metrics.readMs) || 0) / Number(metrics.readEvents) / 1000) : 0,
  });
});

router.post("/public/:slug/clap", authRequired, async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" }).select("metrics clappedBy");
  if (!post) return res.status(404).json({ message: "Post not found." });
  const userId = String(req.user?.id || "");
  const alreadyClapped = (post.clappedBy || []).some((id) => String(id) === userId);
  if (alreadyClapped) {
    post.clappedBy = post.clappedBy.filter((id) => String(id) !== userId);
    post.metrics.claps = Math.max(0, (Number(post.metrics?.claps) || 0) - 1);
  } else {
    post.clappedBy.push(req.user.id);
    post.metrics.claps = (Number(post.metrics?.claps) || 0) + 1;
  }
  await post.save();
  res.json({ clapped: !alreadyClapped, clapCount: Number(post.metrics?.claps) || 0 });
});

router.post("/public/:slug/comments", authRequired, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ message: "Comment is required." });
  const user = await User.findById(req.user.id).select("name email").lean();
  const authorName = String(user?.name || user?.email || "").trim() || "Reader";
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" });
  if (!post) return res.status(404).json({ message: "Post not found." });
  post.comments.push({
    authorId: req.user.id,
    authorName,
    authorInitials: userInitials(user, authorName),
    text,
  });
  await post.save();
  const comment = post.comments[post.comments.length - 1];
  res.json({ comment: serializeComment(comment), commentCount: post.comments.length });
});

router.patch("/public/:slug/comments/:commentId", authRequired, async (req, res) => {
  const text = String(req.body?.text || "").trim();
  if (!text) return res.status(400).json({ message: "Comment is required." });
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" });
  if (!post) return res.status(404).json({ message: "Post not found." });
  const comment = post.comments.id(req.params.commentId);
  if (!comment) return res.status(404).json({ message: "Comment not found." });
  if (String(comment.authorId || "") !== String(req.user.id || "")) {
    return res.status(403).json({ message: "You can only edit your own comment." });
  }
  comment.text = text;
  comment.edited = true;
  comment.updatedAt = new Date();
  await post.save();
  res.json({ comment: serializeComment(comment), commentCount: post.comments.length });
});

router.use(authRequired, requireRoleAtLeast("editor"));

router.get("/", async (req, res) => {
  const { q, status, category } = req.query || {};
  const filter = { authorId: req.user.id };
  if (status && ["draft", "published"].includes(status)) filter.status = status;
  if (category && category !== "All") filter.category = String(category);
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim() };
  const posts = await BlogPost.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ posts: posts.map(withResolvedAuthorName) });
});

router.post("/", async (req, res) => {
  const payload = await makePayload(req.body, req.user);
  if (!assertValidPayload(payload, res)) return;
  try {
    const post = await BlogPost.create(payload);
    res.json({ post });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      return res.status(409).json({ message: "A blog post with this slug already exists." });
    }
    throw err;
  }
});

router.patch("/:id", async (req, res) => {
  const payload = await makePayload(req.body, req.user);
  if (!assertValidPayload(payload, res)) return;
  try {
    const post = await BlogPost.findOneAndUpdate(
      { _id: req.params.id, authorId: req.user.id },
      { $set: payload },
      { new: true, runValidators: true }
    );
    if (!post) return res.status(404).json({ message: "Post not found." });
    res.json({ post });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      return res.status(409).json({ message: "A blog post with this slug already exists." });
    }
    throw err;
  }
});

router.delete("/:id", async (req, res) => {
  const deleted = await BlogPost.findOneAndDelete({ _id: req.params.id, authorId: req.user.id });
  if (!deleted) return res.status(404).json({ message: "Post not found." });
  res.json({ ok: true });
});

module.exports = router;
