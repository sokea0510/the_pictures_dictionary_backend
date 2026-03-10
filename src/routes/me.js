// backend/src/routes/me.js

const express = require("express");
const crypto = require("crypto");
const { uploadImageDataUrl } = require("../utils/storage");
const { authRequired } = require("../middleware/auth");
const { requireAnyRole } = require("../middleware/rbac");
const User = require("../models/User");
const Language = require("../models/Language");
const Notification = require("../models/Notification");
const { notifyUser } = require("../utils/notifications");

const router = express.Router();

const normalizeLangCode = (value, fallback = "") => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const key = raw.split(/[-_]/)[0];
  if (["km", "kh", "khmer"].includes(key)) return "kh";
  if (["kr", "ko", "korean"].includes(key)) return "kr";
  if (["en", "eng", "english"].includes(key)) return "en";
  return key;
};

const USER_SELECT =
  "email role favorites history name company phone phoneCountryCode avatarUrl emailVerified marketingOptIn uiLanguage authProvider googleId";

router.get("/", authRequired, async (req, res) => {
  const user = await User.findById(req.user.id).select(USER_SELECT);
  res.json({ user });
});

router.patch("/", authRequired, async (req, res) => {
  const { name, company, phone, phoneCountryCode, marketingOptIn, uiLanguage } = req.body || {};
  const update = {};
  if (typeof name === "string") update.name = name;
  if (typeof company === "string") update.company = company;
  if (typeof phone === "string") update.phone = phone;
  if (typeof phoneCountryCode === "string") update.phoneCountryCode = phoneCountryCode;
  if (typeof marketingOptIn === "boolean") update.marketingOptIn = marketingOptIn;
  if (typeof uiLanguage === "string") update.uiLanguage = normalizeLangCode(uiLanguage, "en");

  const user = await User.findByIdAndUpdate(req.user.id, { $set: update }, { new: true }).select(
    USER_SELECT
  );
  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Profile updated",
    body: "Your account details were updated successfully.",
    link: "/settings/profile",
  });
  res.json({ user });
});

router.post("/avatar", authRequired, async (req, res) => {
  const { imageData } = req.body || {};
  if (!imageData || typeof imageData !== "string") {
    return res.status(400).json({ message: "Missing image data" });
  }

  let avatarUrl;
  try {
    const uploaded = await uploadImageDataUrl({
      dataUrl: imageData,
      keyPrefix: `avatars/${req.user.id}`,
    });
    avatarUrl = uploaded.url;
  } catch (err) {
    return res.status(400).json({ message: err?.message || "Image upload failed" });
  }

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: { avatarUrl } },
    { new: true }
  ).select(USER_SELECT);
  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Avatar updated",
    body: "Your profile photo was updated.",
    link: "/settings/profile",
  });
  res.json({ user });
});

router.delete("/avatar", authRequired, async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: { avatarUrl: "" } },
    { new: true }
  ).select(USER_SELECT);
  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Avatar removed",
    body: "Your profile photo was removed.",
    link: "/settings/profile",
  });
  res.json({ user });
});

router.post("/email/verify", authRequired, async (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).trim()) {
    return res.status(400).json({ message: "Email required" });
  }
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: { email: String(email).trim().toLowerCase(), emailVerified: false } },
    { new: true }
  ).select(USER_SELECT);
  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Email updated",
    body: "Your email address was updated. Please verify it.",
    link: "/settings/profile",
  });
  res.json({ ok: true, user });
});

router.post("/google/disconnect", authRequired, async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  if (!user.googleId && user.authProvider !== "google") {
    const safeUser = await User.findById(req.user.id).select(USER_SELECT);
    return res.json({ ok: true, user: safeUser });
  }

  user.googleId = "";
  if (user.authProvider === "google") {
    user.authProvider = "local";
  }
  await user.save();

  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Google account disconnected",
    body: "Google sign-in was removed from your account.",
    link: "/settings/security",
  });

  const updated = await User.findById(req.user.id).select(USER_SELECT);
  res.json({ ok: true, user: updated });
});

router.post("/google/link", authRequired, async (req, res) => {
  const { credential } = req.body || {};
  if (!credential || typeof credential !== "string") {
    return res.status(400).json({ message: "Missing Google credential" });
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ message: "Google client ID not configured" });

  const { OAuth2Client } = require("google-auth-library");
  const client = new OAuth2Client(clientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: credential,
      audience: clientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ message: "Invalid Google token" });
  }

  const email = String(payload?.email || "").toLowerCase();
  if (!email) return res.status(400).json({ message: "Google account email missing" });

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  if (email !== String(user.email || "").toLowerCase()) {
    return res.status(400).json({ message: "Google account email must match your profile email" });
  }

  const existing = await User.findOne({ googleId: payload?.sub || "" });
  if (existing && String(existing._id) !== String(user._id)) {
    return res.status(409).json({ message: "Google account already linked to another user" });
  }

  user.googleId = payload?.sub || user.googleId;
  user.authProvider = "google";
  if (!user.avatarUrl && payload?.picture) user.avatarUrl = payload.picture;
  if (payload?.email_verified) user.emailVerified = true;
  await user.save();

  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "Google account connected",
    body: "Google sign-in was linked to your account.",
    link: "/settings/security",
  });

  const updated = await User.findById(req.user.id).select(USER_SELECT);
  res.json({ ok: true, user: updated });
});

router.post("/password/forgot", authRequired, async (_req, res) => {
  const { email } = _req.body || {};
  const user = await User.findById(_req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  if (email && String(email).trim().toLowerCase() !== user.email) {
    return res.status(400).json({ message: "Email does not match this account" });
  }

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  user.resetPasswordTokenHash = tokenHash;
  user.resetPasswordExpiresAt = expiresAt;
  await user.save();

  const baseUrl = process.env.FRONTEND_URL || process.env.APP_BASE_URL || "http://localhost:5173";
  const resetLink = `${baseUrl}/reset-password?token=${token}`;

  await notifyUser(user, "securityAlerts", {
    type: "security_alert",
    title: "Password reset requested",
    body: "A password reset link was requested for your account.",
    link: "/settings/security",
  });

  res.json({ ok: true, resetLink });
});

router.post("/password/change", authRequired, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: "Missing password fields" });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ message: "Password must be at least 6 characters" });
  }

  const user = await User.findById(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });

  const bcrypt = require("bcryptjs");
  const ok = await bcrypt.compare(String(currentPassword), user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Current password is incorrect" });

  user.passwordHash = await bcrypt.hash(String(newPassword), 10);
  user.resetPasswordTokenHash = "";
  user.resetPasswordExpiresAt = null;
  await user.save();

  await notifyUser(user, "securityAlerts", {
    type: "security_alert",
    title: "Password updated",
    body: "Your password was changed successfully.",
    link: "/settings/security",
  });

  res.json({ ok: true });
});

router.post("/marketing/test", authRequired, async (_req, res) => {
  res.json({ ok: true });
});

router.get("/languages", authRequired, requireAnyRole(["editor", "admin", "owner"]), async (_req, res) => {
  const list = await Language.find({})
    .select("_id code name isEnabled")
    .sort({ name: 1 })
    .lean();
  const languages = list.map((lang) => ({
    ...lang,
    code: normalizeLangCode(lang.code),
  }));
  res.json({ languages });
});

router.patch(
  "/languages/:id/enabled",
  authRequired,
  requireAnyRole(["editor", "admin", "owner"]),
  async (req, res) => {
    const { isEnabled } = req.body || {};
    if (typeof isEnabled !== "boolean") {
      return res.status(400).json({ message: "isEnabled must be boolean." });
    }
    const language = await Language.findByIdAndUpdate(
      req.params.id,
      { $set: { isEnabled } },
      { new: true }
    ).select("_id code name isEnabled");
    if (!language) return res.status(404).json({ message: "Language not found." });
    res.json({ language });
  }
);

const NOTIFICATION_KEYS = [
  "securityAlerts",
  "accountUpdates",
  "learningReminders",
  "weeklyProgress",
  "dailyChallenge",
  "favoritesUpdates",
  "productTips",
  "editorRequestStatus",
  "reviewNotes",
  "approvalQueue",
  "categoryHealth",
  "systemAlerts",
  "adsReview",
];

router.get("/notifications", authRequired, async (req, res) => {
  const user = await User.findById(req.user.id).select("notificationPreferences");
  res.json({ preferences: user?.notificationPreferences || {} });
});

router.put("/notifications", authRequired, async (req, res) => {
  const incoming = req.body || {};
  const update = {};
  NOTIFICATION_KEYS.forEach((key) => {
    if (typeof incoming[key] === "boolean") {
      update[`notificationPreferences.${key}`] = incoming[key];
    }
  });

  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: update },
    { new: true }
  ).select("notificationPreferences");
  res.json({ preferences: user?.notificationPreferences || {} });
});

const DAY_MS = 24 * 60 * 60 * 1000;

const latestHistoryAt = (history = []) => {
  const times = history.map((h) => new Date(h.at || h.createdAt || 0).getTime()).filter(Boolean);
  if (!times.length) return 0;
  return Math.max(...times);
};

const ensureRecurringNotifications = async (user) => {
  const prefs = user.notificationPreferences || {};
  const userId = user._id;
  const now = Date.now();

  const ensureType = async (type, minAgeMs, builder) => {
    const last = await Notification.findOne({ userId, type }).sort({ createdAt: -1 });
    if (last) {
      const age = now - new Date(last.createdAt).getTime();
      if (age < minAgeMs) return;
    }
    await Notification.create({ userId, type, ...builder() });
  };

  if (prefs.learningReminders) {
    const lastLearn = latestHistoryAt(user.history || []);
    if (!lastLearn || now - lastLearn > 3 * DAY_MS) {
      await ensureType("learning_reminder", 2 * DAY_MS, () => ({
        title: "Keep learning",
        body: "Come back to review saved words and continue learning.",
        link: "/dictionary",
      }));
    }
  }

  if (prefs.dailyChallenge) {
    await ensureType("daily_challenge", DAY_MS, () => ({
      title: "Daily picture challenge",
      body: "Your daily challenge is ready. Keep your streak going!",
      link: "/dictionary",
    }));
  }

  if (prefs.weeklyProgress) {
    await ensureType("weekly_progress", 7 * DAY_MS, () => ({
      title: "Weekly progress summary",
      body: "Check your weekly learning progress and new achievements.",
      link: "/dictionary",
    }));
  }

  if (prefs.productTips) {
    await ensureType("product_tips", 14 * DAY_MS, () => ({
      title: "Tips & new features",
      body: "Discover new features and tips to learn faster.",
      link: "/dictionary",
    }));
  }
};

router.get("/notifications/feed", authRequired, async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 20), 50);
  const user = await User.findById(req.user.id).select("notificationPreferences history");
  if (user) {
    await ensureRecurringNotifications(user);
  }
  const notifications = await Notification.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ notifications });
});

router.post("/notifications/read", authRequired, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json({ ok: true });
  await Notification.updateMany(
    { userId: req.user.id, _id: { $in: ids } },
    { $set: { readAt: new Date() } }
  );
  res.json({ ok: true });
});

router.post("/history", authRequired, async (req, res) => {
  const { itemId, fromLang, toLang } = req.body || {};
  if (!itemId) return res.status(400).json({ message: "Missing itemId" });

  const normalizedFrom = normalizeLangCode(fromLang);
  const normalizedTo = normalizeLangCode(toLang);
  await User.findByIdAndUpdate(req.user.id, {
    $push: { history: { itemId, fromLang: normalizedFrom, toLang: normalizedTo, at: new Date() } }
  });
  res.json({ ok: true });
});

router.post("/history/clear", authRequired, async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.user.id,
    { $set: { history: [] } },
    { new: true }
  ).select("history");
  await notifyUser(user, "accountUpdates", {
    type: "account_update",
    title: "History cleared",
    body: "Your history was cleared.",
    link: "/history",
  });
  res.json({ ok: true, history: user?.history || [] });
});

router.post("/favorites/toggle", authRequired, async (req, res) => {
  const { itemId } = req.body || {};
  if (!itemId) return res.status(400).json({ message: "Missing itemId" });

  const user = await User.findById(req.user.id);
  const exists = user.favorites.some((id) => String(id) === String(itemId));
  user.favorites = exists
    ? user.favorites.filter((id) => String(id) !== String(itemId))
    : [...user.favorites, itemId];

  await user.save();
  res.json({ ok: true, favorites: user.favorites });
});

module.exports = router;
