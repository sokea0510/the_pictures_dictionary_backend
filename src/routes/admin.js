// backend/src/routes/admin.js

const express = require("express");
const fs = require("fs");
const path = require("path");
const { authRequired } = require("../middleware/auth");
const { requireAnyRole, requireRoleAtLeast } = require("../middleware/rbac");

const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const User = require("../models/User");
const Translation = require("../models/Translation");
const TranslationSettings = require("../models/TranslationSettings");
const { resetSettingsCache, translateText } = require("../utils/translate");
const TranslationUsage = require("../models/TranslationUsage");
const bcrypt = require("bcryptjs");
const { notifyCategoryFollowers } = require("../utils/notifications");
const TelegramPost = require("../models/TelegramPost");
const FacebookPost = require("../models/FacebookPost");
const {
  createPendingTelegramPosts,
  deletePublishedTelegramPost,
  getTelegramSettings,
  postDailyTelegramItem,
  publishTelegramPost,
  publicTelegramSettings,
  serializeTelegramPost,
  updateTelegramSettings,
} = require("../utils/telegramDailyPost");
const {
  createPendingFacebookPosts,
  deletePublishedFacebookPost,
  getFacebookSettings,
  publishFacebookPost,
  publicFacebookSettings,
  serializeFacebookPost,
  updateFacebookSettings,
} = require("../utils/facebookDailyPost");

const router = express.Router();

const encodeKey = (key) => String(key || "").replace(/\./g, "__dot__").replace(/\$/g, "__dollar__");
const decodeKey = (key) => String(key || "").replace(/__dot__/g, ".").replace(/__dollar__/g, "$");
const encodeMessages = (obj = {}) => {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    out[encodeKey(k)] = v;
  });
  return out;
};
const decodeMessages = (obj = {}) => {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    out[decodeKey(k)] = v;
  });
  return out;
};


const protectTranslationPlaceholders = (value = "") => {
  const placeholders = [];
  const text = String(value || "").replace(/\{\{\s*[^{}]+\s*\}\}/g, (match) => {
    const token = `__PD_PLACEHOLDER_${placeholders.length}__`;
    placeholders.push({ token, value: match });
    return token;
  });
  return { text, placeholders };
};

const restoreTranslationPlaceholders = (value = "", placeholders = []) => {
  let next = String(value || "");
  placeholders.forEach(({ token, value: original }) => {
    next = next.split(token).join(original);
    next = next.split(token.toLowerCase()).join(original);
  });
  return next;
};

const escapeCsvCell = (value) => {
  const text = String(value ?? "");
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
};
const toCsv = (rows = []) => rows.map((row) => row.map(escapeCsvCell).join(",")).join("\n");

function normalizeLocalizedStringMap(value) {
  if (!value || typeof value !== "object") return {};
  const normalized = {};
  Object.entries(value).forEach(([code, text]) => {
    const key = String(code || "").trim().toLowerCase();
    const clean = String(text || "").trim();
    if (!key || !clean) return;
    normalized[key] = clean;
  });
  return normalized;
}

function normalizeLocalizedStringArrayMap(value, maxItems = 5) {
  if (!value || typeof value !== "object") return {};
  const normalized = {};
  Object.entries(value).forEach(([code, entries]) => {
    const key = String(code || "").trim().toLowerCase();
    if (!key) return;
    const list = Array.isArray(entries) ? entries : String(entries || "").split(/\n|,/);
    const clean = list
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, maxItems);
    if (clean.length) normalized[key] = clean;
  });
  return normalized;
}

function normalizeLearningFields(payload) {
  if (payload.examples !== undefined) payload.examples = normalizeLocalizedStringArrayMap(payload.examples, 3);
  if (payload.relatedWords !== undefined) payload.relatedWords = normalizeLocalizedStringArrayMap(payload.relatedWords, 5);
  if (payload.funFacts !== undefined) payload.funFacts = normalizeLocalizedStringMap(payload.funFacts);
  if (payload.categoryExplanations !== undefined) payload.categoryExplanations = normalizeLocalizedStringMap(payload.categoryExplanations);
}

const parseCsv = (input = "") => {
  const text = String(input || "");
  const rows = [];
  let row = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (text[i + 1] === "\"") {
          cell += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  row.push(cell);
  if (row.some((value) => String(value).trim() !== "") || rows.length === 0) {
    rows.push(row);
  }
  return rows;
};

const normalizePhoneticPronunciations = (value) => {
  if (!value || typeof value !== "object") return {};
  const normalized = {};
  Object.entries(value).forEach(([code, text]) => {
    const key = String(code || "").trim().toLowerCase();
    const pronunciation = String(text || "").trim();
    if (!key || !pronunciation) return;
    normalized[key] = pronunciation;
  });
  return normalized;
};

const normalizeLanguageCode = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  const key = raw.split(/[-_]/)[0];
  if (["km", "kh", "khmer"].includes(key)) return "kh";
  if (["kr", "ko", "korean"].includes(key)) return "kr";
  if (["en", "eng", "english"].includes(key)) return "en";
  return key;
};
const normalizeLanguageName = (value) => String(value || "").trim();
const languageAliases = (code) => {
  if (code === "kh") return ["km", "khmer"];
  if (code === "kr") return ["ko", "korean"];
  if (code === "en") return ["eng", "english"];
  return [];
};

// Admin + Owner can manage dictionary + ads
router.use(authRequired, requireAnyRole(["admin", "owner"]));

router.get("/telegram/settings", requireRoleAtLeast("owner"), async (_req, res) => {
  const settings = await getTelegramSettings();
  res.json({ settings: publicTelegramSettings(settings) });
});

router.put("/telegram/settings", requireRoleAtLeast("owner"), async (req, res) => {
  const settings = await updateTelegramSettings(req.body || {});
  res.json({ settings: publicTelegramSettings(settings) });
});

router.get("/telegram/posts", requireRoleAtLeast("owner"), async (req, res) => {
  const status = String(req.query.status || "pending").trim().toLowerCase();
  const filter = {};
  if (["pending", "published", "failed", "rejected"].includes(status)) filter.status = status;

  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  if (status === "published") {
    if (from || to) {
      filter.publishedAt = {};
      if (from) filter.publishedAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) filter.publishedAt.$lte = new Date(`${to}T23:59:59.999Z`);
    } else {
      filter.publishedAt = { $gte: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) };
    }
  } else if (from || to) {
    filter.scheduledDate = {};
    if (from) filter.scheduledDate.$gte = from;
    if (to) filter.scheduledDate.$lte = to;
  }

  const posts = await TelegramPost.find(filter)
    .populate("itemId", "translations imageUrl imageThumbUrl")
    .sort(status === "published" ? { publishedAt: -1, createdAt: -1 } : { scheduledDate: 1, createdAt: 1 })
    .limit(200)
    .lean();
  res.json({ posts: posts.map(serializeTelegramPost) });
});

router.post("/telegram/posts/generate", requireRoleAtLeast("owner"), async (req, res) => {
  const result = await createPendingTelegramPosts({ count: req.body?.count, scheduledDate: req.body?.scheduledDate });
  res.json(result);
});

router.patch("/telegram/posts/:id", requireRoleAtLeast("owner"), async (req, res) => {
  const patch = {};
  if (req.body?.caption !== undefined) patch.caption = String(req.body.caption || "").slice(0, 1024);
  if (req.body?.scheduledDate !== undefined) patch.scheduledDate = String(req.body.scheduledDate || "").slice(0, 10);
  const post = await TelegramPost.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true })
    .populate("itemId", "translations imageUrl imageThumbUrl");
  if (!post) return res.status(404).json({ message: "Telegram post not found" });
  res.json({ post: serializeTelegramPost(post) });
});

router.post("/telegram/posts/:id/approve", requireRoleAtLeast("owner"), async (req, res) => {
  try {
    const post = await publishTelegramPost(req.params.id, req.user?.id || null);
    res.json({ post });
  } catch (err) {
    console.error("telegram post approval failed", err);
    res.status(500).json({ message: err?.message || "Telegram post approval failed" });
  }
});


router.post("/telegram/posts/:id/delete", requireRoleAtLeast("owner"), async (req, res) => {
  try {
    const post = await deletePublishedTelegramPost(req.params.id);
    res.json({ post });
  } catch (err) {
    console.error("telegram post delete failed", err);
    const status = Number(err?.statusCode || 500);
    res.status(status >= 400 && status < 500 ? status : 500).json({ message: err?.message || "Telegram post delete failed" });
  }
});

router.post("/telegram/posts/:id/reject", requireRoleAtLeast("owner"), async (req, res) => {
  const post = await TelegramPost.findByIdAndUpdate(
    req.params.id,
    { $set: { status: "rejected", error: String(req.body?.reason || "Rejected by owner").slice(0, 500) } },
    { new: true }
  ).populate("itemId", "translations imageUrl imageThumbUrl");
  if (!post) return res.status(404).json({ message: "Telegram post not found" });
  res.json({ post: serializeTelegramPost(post) });
});

router.post("/telegram/daily-post", async (req, res) => {
  try {
    const result = await postDailyTelegramItem({ force: req.body?.force === true });
    res.json(result);
  } catch (err) {
    console.error("telegram daily post failed", err);
    res.status(500).json({ message: err?.message || "Telegram daily post failed" });
  }
});

router.get("/facebook/settings", requireRoleAtLeast("owner"), async (_req, res) => {
  const settings = await getFacebookSettings();
  res.json({ settings: publicFacebookSettings(settings) });
});

router.put("/facebook/settings", requireRoleAtLeast("owner"), async (req, res) => {
  const settings = await updateFacebookSettings(req.body || {});
  res.json({ settings: publicFacebookSettings(settings) });
});

router.get("/facebook/posts", requireRoleAtLeast("owner"), async (req, res) => {
  const status = String(req.query.status || "pending").trim().toLowerCase();
  const filter = {};
  if (["pending", "published", "failed", "rejected"].includes(status)) filter.status = status;

  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  if (status === "published") {
    if (from || to) {
      filter.publishedAt = {};
      if (from) filter.publishedAt.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) filter.publishedAt.$lte = new Date(`${to}T23:59:59.999Z`);
    } else {
      filter.publishedAt = { $gte: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) };
    }
  } else if (from || to) {
    filter.scheduledDate = {};
    if (from) filter.scheduledDate.$gte = from;
    if (to) filter.scheduledDate.$lte = to;
  }

  const posts = await FacebookPost.find(filter)
    .populate("itemId", "translations imageUrl imageThumbUrl")
    .sort(status === "published" ? { publishedAt: -1, createdAt: -1 } : { scheduledDate: 1, createdAt: 1 })
    .limit(200)
    .lean();
  res.json({ posts: posts.map(serializeFacebookPost) });
});

router.post("/facebook/posts/generate", requireRoleAtLeast("owner"), async (req, res) => {
  const result = await createPendingFacebookPosts({ count: req.body?.count, scheduledDate: req.body?.scheduledDate });
  res.json(result);
});

router.patch("/facebook/posts/:id", requireRoleAtLeast("owner"), async (req, res) => {
  const patch = {};
  if (req.body?.caption !== undefined) patch.caption = String(req.body.caption || "").slice(0, 5000);
  if (req.body?.scheduledDate !== undefined) patch.scheduledDate = String(req.body.scheduledDate || "").slice(0, 10);
  const post = await FacebookPost.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true })
    .populate("itemId", "translations imageUrl imageThumbUrl");
  if (!post) return res.status(404).json({ message: "Facebook post not found" });
  res.json({ post: serializeFacebookPost(post) });
});

router.post("/facebook/posts/:id/approve", requireRoleAtLeast("owner"), async (req, res) => {
  try {
    const post = await publishFacebookPost(req.params.id, req.user?.id || null);
    res.json({ post });
  } catch (err) {
    console.error("facebook post approval failed", err);
    res.status(500).json({ message: err?.message || "Facebook post approval failed" });
  }
});

router.post("/facebook/posts/:id/delete", requireRoleAtLeast("owner"), async (req, res) => {
  try {
    const post = await deletePublishedFacebookPost(req.params.id);
    res.json({ post });
  } catch (err) {
    console.error("facebook post delete failed", err);
    const status = Number(err?.statusCode || 500);
    res.status(status >= 400 && status < 500 ? status : 500).json({ message: err?.message || "Facebook post delete failed" });
  }
});

router.post("/facebook/posts/:id/reject", requireRoleAtLeast("owner"), async (req, res) => {
  const post = await FacebookPost.findByIdAndUpdate(
    req.params.id,
    { $set: { status: "rejected", error: String(req.body?.reason || "Rejected by owner").slice(0, 500) } },
    { new: true }
  ).populate("itemId", "translations imageUrl imageThumbUrl");
  if (!post) return res.status(404).json({ message: "Facebook post not found" });
  res.json({ post: serializeFacebookPost(post) });
});

/* Languages */
router.post("/languages", async (req, res) => {
  const payload = req.body || {};
  const code = normalizeLanguageCode(payload.code);
  const name = normalizeLanguageName(payload.name);

  if (!code || !name) {
    return res.status(400).json({ message: "Language code and name are required." });
  }

  const exists = await Language.findOne({ code }).lean();
  if (exists) {
    return res.status(409).json({ message: "Language code already exists." });
  }

  try {
    const doc = await Language.create({
      code,
      name,
      isEnabled: payload.isEnabled !== false,
    });
    return res.json({ language: doc });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      return res.status(409).json({ message: "Language code already exists." });
    }
    throw err;
  }
});
router.patch("/languages/:id", async (req, res) => {
  const payload = { ...(req.body || {}) };
  if (payload.code !== undefined) {
    payload.code = normalizeLanguageCode(payload.code);
    if (!payload.code) {
      return res.status(400).json({ message: "Language code cannot be empty." });
    }
    const exists = await Language.findOne({ code: payload.code, _id: { $ne: req.params.id } }).lean();
    if (exists) {
      return res.status(409).json({ message: "Language code already exists." });
    }
  }
  if (payload.name !== undefined) {
    payload.name = normalizeLanguageName(payload.name);
    if (!payload.name) {
      return res.status(400).json({ message: "Language name cannot be empty." });
    }
  }
  if (payload.isEnabled !== undefined) {
    payload.isEnabled = payload.isEnabled !== false;
  }

  try {
    const doc = await Language.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true }
    );
    if (!doc) return res.status(404).json({ message: "Language not found." });
    return res.json({ language: doc });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      return res.status(409).json({ message: "Language code already exists." });
    }
    throw err;
  }
});
router.delete("/languages/:id", async (req, res) => {
  const deleted = await Language.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ message: "Language not found." });
  return res.json({ ok: true });
});

/* Categories */
router.get("/categories", async (_req, res) => {
  const categories = await Category.find({})
    .select("_id label coverUrl isEnabled createdAt updatedAt")
    .sort({ label: 1 })
    .lean();
  res.json({ categories });
});
router.post("/categories", async (req, res) => {
  const doc = await Category.create(req.body);
  res.json({ category: doc });
});
router.patch("/categories/:id", async (req, res) => {
  const doc = await Category.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  res.json({ category: doc });
});
router.delete("/categories/:id", async (req, res) => {
  await Category.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Items */
router.get("/items", async (_req, res) => {
  const items = await Item.find()
    .populate("editorId", "name email")
    .populate("approvedBy", "name email")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ items });
});
router.post("/items", async (req, res) => {
  const payload = { ...(req.body || {}) };
  payload.description = String(payload.description || "").trim() || "No description";
  payload.imageThumbUrl = String(payload.imageThumbUrl || payload.imageUrl || "").trim();
  payload.phoneticPronunciations = normalizePhoneticPronunciations(payload.phoneticPronunciations);
  normalizeLearningFields(payload);
  payload.editorId = req.user.id;
  payload.approvedBy = req.user.id;
  const doc = await Item.create(payload);
  await notifyCategoryFollowers(doc, {
    title: "New content added",
    body: (doc.translations?.en || Object.values(doc.translations || {})[0] || "New item"),
  });
  res.json({ item: doc });
});
router.patch("/items/:id", async (req, res) => {
  const payload = { ...(req.body || {}) };
  delete payload.editorId;
  delete payload.approvedBy;
  if (payload.description !== undefined) {
    payload.description = String(payload.description || "").trim() || "No description";
  }
  if (payload.imageUrl !== undefined || payload.imageThumbUrl !== undefined) {
    payload.imageThumbUrl = String(payload.imageThumbUrl || payload.imageUrl || "").trim();
  }
  if (payload.phoneticPronunciations !== undefined) {
    payload.phoneticPronunciations = normalizePhoneticPronunciations(payload.phoneticPronunciations);
  }
  normalizeLearningFields(payload);
  const changesContent = ["categoryId", "imageUrl", "imageThumbUrl", "translations", "phoneticPronunciations", "description", "examples", "relatedWords", "funFacts", "categoryExplanations"]
    .some((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (changesContent) {
    payload.editorId = req.user.id;
  }
  payload.approvedBy = req.user.id;
  const doc = await Item.findByIdAndUpdate(
    req.params.id,
    { $set: payload },
    { new: true, runValidators: true }
  );
  res.json({ item: doc });
});
router.delete("/items/:id", async (req, res) => {
  await Item.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Ads */
router.get("/ads", async (_req, res) => {
  const ads = await Ad.find().sort({ updatedAt: -1 }).limit(200).lean();
  res.json({ ads });
});
router.post("/ads", async (req, res) => {
  const doc = await Ad.create(req.body);
  res.json({ ad: doc });
});
router.patch("/ads/:id", async (req, res) => {
  const doc = await Ad.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  res.json({ ad: doc });
});
router.delete("/ads/:id", async (req, res) => {
  await Ad.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Admin/Owner user visibility; owner-only mutations below */
router.get("/users", requireAnyRole(["admin", "owner"]), async (_req, res) => {
  const users = await User.find()
    .select("name email role isActive authProvider googleId facebookId telegramId avatarUrl emailVerified createdAt updatedAt planType planStartsAt planEndsAt")
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ users });
});

router.post("/users", requireRoleAtLeast("owner"), async (req, res) => {
  const { email, password, role } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ message: "Missing fields" });

  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ message: "Email exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ email, passwordHash, role });
  res.json({ user: { id: user._id, email: user.email, role: user.role } });
});

router.patch("/users/:id", requireRoleAtLeast("owner"), async (req, res) => {
  const { role, isActive, password, planType, planStartsAt, planEndsAt } = req.body || {};
  const patch = {};
  if (role) patch.role = role;
  if (typeof isActive === "boolean") patch.isActive = isActive;
  if (planType) patch.planType = planType;

  const parseDate = (value, label) => {
    if (value === null || value === undefined || value === "") return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`Invalid ${label}`);
    }
    return date;
  };

  try {
    if (planType === "free" && planStartsAt === undefined && planEndsAt === undefined) {
      patch.planStartsAt = null;
      patch.planEndsAt = null;
    } else {
      if (planStartsAt !== undefined) patch.planStartsAt = parseDate(planStartsAt, "planStartsAt");
      if (planEndsAt !== undefined) patch.planEndsAt = parseDate(planEndsAt, "planEndsAt");
    }
  } catch (e) {
    return res.status(400).json({ message: e.message || "Invalid plan dates" });
  }

  if (password) {
    if (String(password).length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters" });
    }
    patch.passwordHash = await bcrypt.hash(String(password), 10);
  }

  const user = await User.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true })
    .select("email role isActive planType planStartsAt planEndsAt");
  res.json({ user });
});

router.delete("/users/:id", requireRoleAtLeast("owner"), async (req, res) => {
  if (String(req.user.id) === String(req.params.id)) {
    return res.status(400).json({ message: "Cannot delete your own account" });
  }
  const user = await User.findById(req.params.id).select("role");
  if (!user) return res.status(404).json({ message: "User not found" });
  if (user.role === "owner") {
    return res.status(400).json({ message: "Cannot delete an owner account" });
  }
  await User.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Admin/Owner translations */
router.get("/translations", requireAnyRole(["admin", "owner"]), async (_req, res) => {
  const list = await Translation.find({})
    .select("lang fontFamily messages isEnabled")
    .sort({ lang: 1 })
    .lean();
  const languages = list.map((row) => ({
    lang: normalizeLanguageCode(row.lang),
    fontFamily: row.fontFamily || "",
    numKeys: Object.keys(row.messages || {}).length,
    isEnabled: row.isEnabled !== false,
  }));
  res.json({ languages });
});

router.get("/translations/export/csv", requireRoleAtLeast("owner"), async (req, res) => {
  const requestedLangs = String(req.query?.langs || "")
    .split(",")
    .map(normalizeLanguageCode)
    .filter(Boolean);
  const requestedSet = requestedLangs.length ? new Set(requestedLangs) : null;

  const docs = await Translation.find({})
    .select("lang messages")
    .sort({ lang: 1 })
    .lean();

  const byLang = new Map();
  docs.forEach((doc) => {
    const lang = normalizeLanguageCode(doc.lang);
    if (!lang || byLang.has(lang)) return;
    if (requestedSet && !requestedSet.has(lang)) return;
    byLang.set(lang, decodeMessages(doc.messages || {}));
  });

  const languages = requestedSet
    ? requestedLangs.filter((lang, index) => requestedLangs.indexOf(lang) === index && byLang.has(lang))
    : Array.from(byLang.keys()).sort();
  const keysSet = new Set();
  languages.forEach((lang) => {
    Object.keys(byLang.get(lang) || {}).forEach((key) => keysSet.add(key));
  });
  const keys = Array.from(keysSet).sort();

  const rows = [["key", ...languages]];
  keys.forEach((key) => {
    const row = [key];
    languages.forEach((lang) => row.push((byLang.get(lang) || {})[key] || ""));
    rows.push(row);
  });

  const csv = toCsv(rows);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="translations-${stamp}.csv"`);
  res.send(`\uFEFF${csv}`);
});

router.post("/translations/import/csv", requireRoleAtLeast("owner"), async (req, res) => {
  const csv = String(req.body?.csv || "");
  if (!csv.trim()) return res.status(400).json({ message: "Missing CSV content." });

  const rows = parseCsv(csv.replace(/^\uFEFF/, ""));
  if (!rows.length) return res.status(400).json({ message: "CSV is empty." });

  const header = rows[0].map((col) => String(col || "").trim());
  if (String(header[0] || "").toLowerCase() !== "key") {
    return res.status(400).json({ message: "First CSV column must be 'key'." });
  }

  const seen = new Set();
  const languageColumns = [];
  for (let i = 1; i < header.length; i += 1) {
    const raw = String(header[i] || "").trim();
    if (!raw) continue;
    const lang = normalizeLanguageCode(raw);
    if (!lang) return res.status(400).json({ message: `Invalid language column: ${raw}` });
    if (seen.has(lang)) {
      return res.status(400).json({ message: `Duplicate language column after normalization: ${lang}` });
    }
    seen.add(lang);
    languageColumns.push({ index: i, lang });
  }
  if (!languageColumns.length) {
    return res.status(400).json({ message: "CSV must include at least one language column." });
  }

  const targetLangs = languageColumns.map((col) => col.lang);
  const aliases = targetLangs.flatMap((lang) => [lang, ...languageAliases(lang)]);
  const docs = await Translation.find({ lang: { $in: aliases } })
    .select("lang messages")
    .lean();
  const existingByLang = new Map();
  docs.forEach((doc) => {
    const lang = normalizeLanguageCode(doc.lang);
    if (!lang || existingByLang.has(lang)) return;
    existingByLang.set(lang, decodeMessages(doc.messages || {}));
  });

  const nextByLang = new Map();
  targetLangs.forEach((lang) => {
    nextByLang.set(lang, { ...(existingByLang.get(lang) || {}) });
  });

  let updatedKeys = 0;
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const key = String(row[0] || "").trim();
    if (!key) continue;
    languageColumns.forEach(({ index, lang }) => {
      const value = row[index];
      if (value === undefined || value === null || String(value) === "") return;
      const map = nextByLang.get(lang) || {};
      const nextVal = String(value);
      if (map[key] !== nextVal) {
        map[key] = nextVal;
        updatedKeys += 1;
      }
      nextByLang.set(lang, map);
    });
  }

  let updatedLanguages = 0;
  for (const lang of targetLangs) {
    await Translation.findOneAndUpdate(
      { lang: { $in: [lang, ...languageAliases(lang)] } },
      { $set: { lang, messages: encodeMessages(nextByLang.get(lang) || {}) } },
      { new: true, upsert: true }
    );
    updatedLanguages += 1;
  }

  res.json({
    ok: true,
    updatedLanguages,
    updatedKeys,
    message: `Imported CSV: updated ${updatedKeys} values across ${updatedLanguages} languages.`,
  });
});


router.post("/translations/translate-missing", requireRoleAtLeast("owner"), async (req, res) => {
  const sourceLang = normalizeLanguageCode(req.body?.sourceLang || "en") || "en";
  const sourceMessages = req.body?.sourceMessages && typeof req.body.sourceMessages === "object" ? req.body.sourceMessages : {};
  const requestedLangs = Array.isArray(req.body?.targetLangs)
    ? req.body.targetLangs.map(normalizeLanguageCode).filter(Boolean)
    : [];
  const requestedSet = requestedLangs.length ? new Set(requestedLangs) : null;
  const keys = Array.isArray(req.body?.keys)
    ? req.body.keys.map((key) => String(key || "").trim()).filter(Boolean)
    : Object.keys(sourceMessages || {});
  const overwrite = req.body?.overwrite === true;

  if (!Object.keys(sourceMessages).length) return res.status(400).json({ message: "Missing source messages." });
  if (!keys.length) return res.status(400).json({ message: "Missing translation keys." });

  const docs = await Translation.find({}).select("lang messages isEnabled");
  const targets = docs
    .map((doc) => ({ doc, lang: normalizeLanguageCode(doc.lang) }))
    .filter(({ lang, doc }) => lang && lang !== sourceLang && doc.isEnabled !== false && (!requestedSet || requestedSet.has(lang)));

  let updatedLanguages = 0;
  let updatedKeys = 0;
  const errors = [];

  for (const { doc, lang } of targets) {
    const messages = decodeMessages(doc.messages || {});
    let changed = false;

    for (const key of keys) {
      const sourceText = String(sourceMessages[key] || "").trim();
      if (!sourceText) continue;
      const current = String(messages[key] || "").trim();
      if (!overwrite && current && current !== sourceText) continue;

      try {
        const protectedSource = protectTranslationPlaceholders(sourceText);
        const result = await translateText({ text: protectedSource.text, source: sourceLang, target: lang });
        const translated = restoreTranslationPlaceholders(result?.translatedText || "", protectedSource.placeholders).trim();
        if (!translated) continue;
        messages[key] = translated;
        changed = true;
        updatedKeys += 1;
      } catch (err) {
        errors.push({ lang, key, message: err?.message || "Translation failed." });
      }
    }

    if (changed) {
      doc.messages = encodeMessages(messages);
      await doc.save();
      updatedLanguages += 1;
    }
  }

  res.json({
    ok: true,
    targetLanguages: targets.length,
    updatedLanguages,
    updatedKeys,
    errors: errors.slice(0, 20),
    errorCount: errors.length,
  });
});

router.get("/translations/:lang", requireAnyRole(["admin", "owner"]), async (req, res) => {
  const lang = normalizeLanguageCode(req.params.lang);
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  const doc = await Translation.findOne({ lang: { $in: [lang, ...languageAliases(lang)] } })
    .sort({ createdAt: -1 })
    .lean();
  if (!doc) return res.status(404).json({ message: "Language not found." });
  res.json({
    lang,
    messages: decodeMessages(doc.messages || {}),
    fontFamily: doc.fontFamily || "",
    fontOverrides: decodeMessages(doc.fontOverrides || {}),
    isEnabled: doc.isEnabled !== false,
  });
});

router.post("/translations", requireAnyRole(["admin", "owner"]), async (req, res) => {
  const lang = normalizeLanguageCode(req.body?.lang);
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  const exists = await Translation.findOne({ lang: { $in: [lang, ...languageAliases(lang)] } }).lean();
  if (exists) return res.status(409).json({ message: "Language already exists." });
  const doc = await Translation.create({ lang });
  res.json({
    lang: doc.lang,
    messages: doc.messages || {},
    fontFamily: doc.fontFamily || "",
    fontOverrides: doc.fontOverrides || {},
    isEnabled: doc.isEnabled !== false,
  });
});

router.put("/translations/:lang", requireAnyRole(["admin", "owner"]), async (req, res) => {
  const lang = normalizeLanguageCode(req.params.lang);
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  const { messages, fontFamily, fontOverrides } = req.body || {};
  const update = {};
  if (messages && typeof messages === "object") update.messages = encodeMessages(messages);
  if (typeof fontFamily === "string") update.fontFamily = fontFamily;
  if (fontOverrides && typeof fontOverrides === "object") update.fontOverrides = encodeMessages(fontOverrides);
  if (typeof req.body?.isEnabled === "boolean") update.isEnabled = req.body.isEnabled;
  const doc = await Translation.findOneAndUpdate(
    { lang: { $in: [lang, ...languageAliases(lang)] } },
    { $set: update },
    { new: true, upsert: true }
  );
  res.json({
    lang: doc.lang,
    messages: decodeMessages(doc.messages || {}),
    fontFamily: doc.fontFamily || "",
    fontOverrides: decodeMessages(doc.fontOverrides || {}),
    isEnabled: doc.isEnabled !== false,
  });
});

router.delete("/translations/:lang", requireAnyRole(["admin", "owner"]), async (req, res) => {
  const lang = normalizeLanguageCode(req.params.lang);
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  await Translation.findOneAndDelete({ lang: { $in: [lang, ...languageAliases(lang)] } });
  res.json({ ok: true });
});

/* Owner-only translation settings */
router.get("/translation-settings", requireRoleAtLeast("owner"), async (_req, res) => {
  const doc = await TranslationSettings.findOne().lean();
  const providers = doc?.providers || {};
  const features = doc?.features || {};
  const ttsProviders = doc?.ttsProviders || {};
  const mask = (value) => (value ? `${String(value).slice(0, 2)}••••${String(value).slice(-2)}` : "");
  res.json({
    providers: {
      azure: {
        configured: !!(providers.azure?.key && providers.azure?.region),
        enabled: providers.azure?.enabled !== false,
        region: providers.azure?.region || "",
        endpoint: providers.azure?.endpoint || "",
        keyHint: mask(providers.azure?.key),
      },
      google: {
        configured: !!(providers.google?.key || providers.google?.ttsKey),
        enabled: providers.google?.enabled !== false,
        keyHint: mask(providers.google?.key),
        ttsKeyHint: mask(providers.google?.ttsKey),
      },
      aws: {
        configured: !!(providers.aws?.accessKeyId && providers.aws?.secretAccessKey && providers.aws?.region),
        enabled: providers.aws?.enabled !== false,
        region: providers.aws?.region || "",
        accessKeyIdHint: mask(providers.aws?.accessKeyId),
        secretAccessKeyHint: mask(providers.aws?.secretAccessKey),
      },
      libre: {
        configured: !!(providers.libre?.url || providers.libre?.apiKey),
        enabled: providers.libre?.enabled !== false,
        url: providers.libre?.url || "",
        apiKeyHint: mask(providers.libre?.apiKey),
      },
    },
    features: {
      quickTranslateEnabled: features.quickTranslateEnabled !== false,
    },
    ttsProviders: {
      gemini: { enabled: ttsProviders?.gemini?.enabled !== false },
      googleCloud: { enabled: ttsProviders?.googleCloud?.enabled !== false },
      googleFallback: { enabled: ttsProviders?.googleFallback?.enabled !== false },
    },
    preferredProvider: doc?.preferredProvider || "",
    updatedAt: doc?.updatedAt || null,
  });
});

router.put("/translation-settings", requireRoleAtLeast("owner"), async (req, res) => {
  const body = req.body || {};
  const current = await TranslationSettings.findOne().select("preferredProvider providers.libre.enabled").lean();
  const update = {};
  const setIfProvided = (path, value) => {
    if (value === undefined) return;
    update[`providers.${path}`] = value === null ? "" : value;
  };

  setIfProvided("azure.key", body.azure?.key);
  setIfProvided("azure.region", body.azure?.region);
  setIfProvided("azure.endpoint", body.azure?.endpoint);
  setIfProvided("azure.enabled", body.azure?.enabled);
  setIfProvided("google.key", body.google?.key);
  setIfProvided("google.ttsKey", body.google?.ttsKey);
  setIfProvided("google.enabled", body.google?.enabled);
  setIfProvided("aws.accessKeyId", body.aws?.accessKeyId);
  setIfProvided("aws.secretAccessKey", body.aws?.secretAccessKey);
  setIfProvided("aws.region", body.aws?.region);
  setIfProvided("aws.sessionToken", body.aws?.sessionToken);
  setIfProvided("aws.enabled", body.aws?.enabled);
  setIfProvided("libre.url", body.libre?.url);
  setIfProvided("libre.apiKey", body.libre?.apiKey);
  setIfProvided("libre.enabled", body.libre?.enabled);
  if (body.features?.quickTranslateEnabled !== undefined) {
    update["features.quickTranslateEnabled"] = !!body.features.quickTranslateEnabled;
  }
  if (body.ttsProviders?.gemini?.enabled !== undefined) {
    update["ttsProviders.gemini.enabled"] = !!body.ttsProviders.gemini.enabled;
  }
  if (body.ttsProviders?.googleCloud?.enabled !== undefined) {
    update["ttsProviders.googleCloud.enabled"] = !!body.ttsProviders.googleCloud.enabled;
  }
  if (body.ttsProviders?.googleFallback?.enabled !== undefined) {
    update["ttsProviders.googleFallback.enabled"] = !!body.ttsProviders.googleFallback.enabled;
  }
  if (body.preferredProvider !== undefined) {
    const normalized = String(body.preferredProvider || "").trim().toLowerCase();
    const allowed = new Set(["", "libre"]);
    if (!allowed.has(normalized)) {
      return res.status(400).json({ message: "Only credit-free providers are allowed as preferred provider." });
    }
    update.preferredProvider = normalized;
  }

  const nextLibreEnabled = body.libre?.enabled !== undefined
    ? !!body.libre.enabled
    : current?.providers?.libre?.enabled !== false;
  const nextPreferred = String(
    update.preferredProvider !== undefined ? update.preferredProvider : current?.preferredProvider || ""
  ).toLowerCase();
  if (nextPreferred === "libre" && !nextLibreEnabled) {
    return res.status(400).json({ message: "Cannot set Libre as preferred while it is disabled." });
  }
  if (!nextLibreEnabled && update.preferredProvider === undefined && nextPreferred === "libre") {
    update.preferredProvider = "";
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ message: "No settings provided." });
  }

  const doc = await TranslationSettings.findOneAndUpdate(
    {},
    { $set: update, updatedBy: req.user.id },
    { upsert: true, new: true }
  );
  resetSettingsCache();
  res.json({ ok: true, updatedAt: doc.updatedAt });
});

router.get("/translation-usage", requireRoleAtLeast("owner"), async (_req, res) => {
  const providerList = ["azure", "google", "aws", "libre"];
  const creditFreeProviders = ["libre"];
  const limits = {
    azure: 2000000,
    google: 500000,
    aws: 2000000,
    libre: null,
  };
  const ttsLimits = {
    "tts:gemini_25_flash_preview": Number(process.env.TTS_GEMINI_MONTHLY_LIMIT || 4000000),
    "tts:google_cloud": Number(process.env.TTS_GOOGLE_CLOUD_MONTHLY_LIMIT || 4000000),
    "tts:google_fallback": Number(process.env.TTS_GOOGLE_FALLBACK_MONTHLY_LIMIT || 4000000),
  };
  const yearMonth = new Date().toISOString().slice(0, 7);
  const settings = await TranslationSettings.findOne().select("providers ttsProviders").lean();
  const usageRows = await TranslationUsage.find({ yearMonth }).lean();
  const usageMap = {};
  const ttsUsageMap = {};
  usageRows.forEach((row) => {
    const code = String(row.provider || "");
    if (code.startsWith("tts:")) {
      ttsUsageMap[code] = row.chars || 0;
      return;
    }
    usageMap[code] = row.chars || 0;
  });
  const usage = providerList.map((provider) => ({
    provider,
    chars: usageMap[provider] || 0,
    creditFree: creditFreeProviders.includes(provider),
    enabled: settings?.providers?.[provider]?.enabled !== false,
  }));
  const runtimeProviders = usage
    .filter((row) => row.creditFree && row.enabled)
    .map((row) => row.provider);
  const ttsProviders = [
    { provider: "tts:gemini_25_flash_preview", label: "Gemini 2.5 Flash Preview TTS", creditFree: true },
    { provider: "tts:google_cloud", label: "Google Cloud TTS", creditFree: false },
    { provider: "tts:google_fallback", label: "Google Translate TTS Fallback", creditFree: true },
  ];
  const ttsUsage = ttsProviders.map((item) => ({
    ...item,
    chars: ttsUsageMap[item.provider] || 0,
    limit: ttsLimits[item.provider] ?? null,
    remaining:
      ttsLimits[item.provider] == null
        ? null
        : Math.max((ttsLimits[item.provider] || 0) - (ttsUsageMap[item.provider] || 0), 0),
    enabled:
      item.provider === "tts:gemini_25_flash_preview"
        ? settings?.ttsProviders?.gemini?.enabled !== false
        : item.provider === "tts:google_cloud"
          ? settings?.ttsProviders?.googleCloud?.enabled !== false
          : settings?.ttsProviders?.googleFallback?.enabled !== false,
  }));
  res.json({
    yearMonth,
    usage,
    ttsUsage,
    limits,
    ttsLimits,
    providers: providerList,
    creditFreeProviders,
    runtimeProviders,
  });
});

router.post("/translation-usage/tts-cache/clear", requireRoleAtLeast("owner"), async (_req, res) => {
  const configured = String(process.env.TTS_CACHE_DIR || "").trim();
  const dir = configured || path.resolve(process.cwd(), "var", "tts-cache");
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch {}
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch {}
  await TranslationUsage.deleteMany({ provider: /^tts:/ });
  res.json({ ok: true, cacheDir: dir });
});

module.exports = router;
