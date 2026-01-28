// backend/src/routes/admin.js

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireAnyRole, requireRoleAtLeast } = require("../middleware/rbac");

const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const User = require("../models/User");
const TranslationSettings = require("../models/TranslationSettings");
const TranslationUsage = require("../models/TranslationUsage");
const bcrypt = require("bcryptjs");
const { notifyCategoryFollowers } = require("../utils/notifications");

const router = express.Router();

// Admin + Owner can manage dictionary + ads
router.use(authRequired, requireAnyRole(["admin", "owner"]));

/* Languages */
router.post("/languages", async (req, res) => {
  const doc = await Language.create(req.body);
  res.json({ language: doc });
});
router.patch("/languages/:id", async (req, res) => {
  const doc = await Language.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  res.json({ language: doc });
});
router.delete("/languages/:id", async (req, res) => {
  await Language.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Categories */
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
  const items = await Item.find().sort({ createdAt: -1 }).limit(500);
  res.json({ items });
});
router.post("/items", async (req, res) => {
  const doc = await Item.create(req.body);
  await notifyCategoryFollowers(doc, {
    title: "New content added",
    body: (doc.translations?.en || Object.values(doc.translations || {})[0] || "New item"),
  });
  res.json({ item: doc });
});
router.patch("/items/:id", async (req, res) => {
  const doc = await Item.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
  res.json({ item: doc });
});
router.delete("/items/:id", async (req, res) => {
  await Item.findByIdAndDelete(req.params.id);
  res.json({ ok: true });
});

/* Ads */
router.get("/ads", async (_req, res) => {
  const ads = await Ad.find().sort({ updatedAt: -1 }).limit(200);
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

/* Owner-only user management */
router.get("/users", requireRoleAtLeast("owner"), async (_req, res) => {
  const users = await User.find()
    .select("email role isActive createdAt planType planStartsAt planEndsAt")
    .sort({ createdAt: -1 })
    .limit(500);
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

/* Owner-only translation settings */
router.get("/translation-settings", requireRoleAtLeast("owner"), async (_req, res) => {
  const doc = await TranslationSettings.findOne().lean();
  const providers = doc?.providers || {};
  const mask = (value) => (value ? `${String(value).slice(0, 2)}••••${String(value).slice(-2)}` : "");
  res.json({
    providers: {
      azure: {
        configured: !!(providers.azure?.key && providers.azure?.region),
        region: providers.azure?.region || "",
        endpoint: providers.azure?.endpoint || "",
        keyHint: mask(providers.azure?.key),
      },
      google: {
        configured: !!providers.google?.key,
        keyHint: mask(providers.google?.key),
      },
      aws: {
        configured: !!(providers.aws?.accessKeyId && providers.aws?.secretAccessKey && providers.aws?.region),
        region: providers.aws?.region || "",
        accessKeyIdHint: mask(providers.aws?.accessKeyId),
        secretAccessKeyHint: mask(providers.aws?.secretAccessKey),
      },
      libre: {
        configured: !!(providers.libre?.url || providers.libre?.apiKey),
        url: providers.libre?.url || "",
        apiKeyHint: mask(providers.libre?.apiKey),
      },
    },
    updatedAt: doc?.updatedAt || null,
  });
});

router.put("/translation-settings", requireRoleAtLeast("owner"), async (req, res) => {
  const body = req.body || {};
  const update = {};
  const setIfProvided = (path, value) => {
    if (value === undefined) return;
    update[`providers.${path}`] = value === null ? "" : value;
  };

  setIfProvided("azure.key", body.azure?.key);
  setIfProvided("azure.region", body.azure?.region);
  setIfProvided("azure.endpoint", body.azure?.endpoint);
  setIfProvided("google.key", body.google?.key);
  setIfProvided("aws.accessKeyId", body.aws?.accessKeyId);
  setIfProvided("aws.secretAccessKey", body.aws?.secretAccessKey);
  setIfProvided("aws.region", body.aws?.region);
  setIfProvided("aws.sessionToken", body.aws?.sessionToken);
  setIfProvided("libre.url", body.libre?.url);
  setIfProvided("libre.apiKey", body.libre?.apiKey);

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ message: "No settings provided." });
  }

  const doc = await TranslationSettings.findOneAndUpdate(
    {},
    { $set: update, updatedBy: req.user.id },
    { upsert: true, new: true }
  );
  res.json({ ok: true, updatedAt: doc.updatedAt });
});

router.get("/translation-usage", requireRoleAtLeast("owner"), async (_req, res) => {
  const limits = {
    azure: 2000000,
    google: 500000,
    aws: 2000000,
    libre: null,
  };
  const yearMonth = new Date().toISOString().slice(0, 7);
  const usage = await TranslationUsage.find({ yearMonth }).lean();
  res.json({ yearMonth, usage, limits });
});

module.exports = router;
