const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast } = require("../middleware/rbac");
const BlogPost = require("../models/BlogPost");

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

const makePayload = (body = {}, user = {}) => {
  const title = String(body.title || "").trim();
  const status = body.status === "published" ? "published" : "draft";
  const publishedAt =
    status === "published"
      ? body.publishedAt
        ? new Date(body.publishedAt)
        : new Date()
      : null;
  return {
    title,
    slug: slugify(body.slug || title),
    excerpt: String(body.excerpt || "").trim(),
    content: String(body.content || ""),
    category: String(body.category || "Education").trim() || "Education",
    tags: normalizeTags(body.tags),
    coverImageUrl: String(body.coverImageUrl || "").trim(),
    coverImageAlt: String(body.coverImageAlt || "").trim(),
    links: normalizeLinks(body.links),
    status,
    featured: Boolean(body.featured),
    authorId: user.id,
    authorName: String(user.name || user.email || "").trim(),
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

router.get("/public", async (req, res) => {
  const { q, category, limit } = req.query || {};
  const filter = { status: "published" };
  if (category && category !== "All") filter.category = String(category);
  if (q && String(q).trim()) {
    filter.$text = { $search: String(q).trim() };
  }
  const max = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const posts = await BlogPost.find(filter)
    .sort({ featured: -1, publishedAt: -1, createdAt: -1 })
    .limit(max)
    .lean();
  res.json({ posts });
});

router.get("/public/:slug", async (req, res) => {
  const post = await BlogPost.findOne({ slug: req.params.slug, status: "published" }).lean();
  if (!post) return res.status(404).json({ message: "Post not found." });
  res.json({ post });
});

router.use(authRequired, requireRoleAtLeast("editor"));

router.get("/", async (req, res) => {
  const { q, status, category } = req.query || {};
  const filter = {};
  if (status && ["draft", "published"].includes(status)) filter.status = status;
  if (category && category !== "All") filter.category = String(category);
  if (q && String(q).trim()) filter.$text = { $search: String(q).trim() };
  const posts = await BlogPost.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ posts });
});

router.post("/", async (req, res) => {
  const payload = makePayload(req.body, req.user);
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
  const payload = makePayload(req.body, req.user);
  if (!assertValidPayload(payload, res)) return;
  try {
    const post = await BlogPost.findByIdAndUpdate(req.params.id, { $set: payload }, { new: true, runValidators: true });
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
  const deleted = await BlogPost.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ message: "Post not found." });
  res.json({ ok: true });
});

module.exports = router;
