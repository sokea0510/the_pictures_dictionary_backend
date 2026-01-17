// backend/src/routes/auth.js

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { notifyUser } = require("../utils/notifications");

const router = express.Router();

router.post("/register", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(80),
    email: z.string().email(),
    password: z.string().min(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { name, email, password } = parsed.data;
  const exists = await User.findOne({ email });
  if (exists) return res.status(409).json({ message: "Email already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email, passwordHash, role: "user", authProvider: "local" });

  const token = signToken({ id: user._id.toString(), role: user.role });
  res.json({ token, user: { id: user._id, email: user.email, role: user.role } });
});

router.post("/login", async (req, res) => {
  const schema = z.object({ email: z.string().email(), password: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { email, password } = parsed.data;
  const user = await User.findOne({ email, isActive: true });
  if (!user) return res.status(401).json({ message: "Invalid credentials" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ message: "Invalid credentials" });

  const token = signToken({ id: user._id.toString(), role: user.role });
  await notifyUser(user, "securityAlerts", {
    type: "security_alert",
    title: "New sign-in",
    body: "A new sign-in was detected on your account.",
    link: "/settings/security",
  });
  res.json({ token, user: { id: user._id, email: user.email, role: user.role } });
});

router.post("/password/reset", async (req, res) => {
  const schema = z.object({
    token: z.string().min(20),
    password: z.string().min(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { token, password } = parsed.data;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const user = await User.findOne({
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpiresAt: { $gt: new Date() },
    isActive: true,
  });
  if (!user) return res.status(400).json({ message: "Invalid or expired reset token" });

  user.passwordHash = await bcrypt.hash(password, 10);
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

router.post("/google", async (req, res) => {
  const schema = z.object({ credential: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ message: "Google client ID not configured" });

  const client = new OAuth2Client(clientId);
  let payload;
  try {
    const ticket = await client.verifyIdToken({
      idToken: parsed.data.credential,
      audience: clientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ message: "Invalid Google token" });
  }

  const email = String(payload?.email || "").toLowerCase();
  if (!email) return res.status(400).json({ message: "Google account email missing" });

  let user = await User.findOne({ email });
  if (!user) {
    const passwordHash = await bcrypt.hash(String(payload?.sub || email) + Date.now(), 10);
    user = await User.create({
      name: payload?.name || "",
      email,
      passwordHash,
      role: "user",
      authProvider: "google",
      googleId: payload?.sub || "",
      avatarUrl: payload?.picture || "",
      emailVerified: !!payload?.email_verified,
    });
  } else {
    const updates = {};
    if (!user.googleId && payload?.sub) updates.googleId = payload.sub;
    if (!user.authProvider || user.authProvider === "local") updates.authProvider = "google";
    if (!user.avatarUrl && payload?.picture) updates.avatarUrl = payload.picture;
    if (payload?.email_verified) updates.emailVerified = true;
    if (Object.keys(updates).length) {
      user = await User.findByIdAndUpdate(user._id, { $set: updates }, { new: true });
    }
  }

  const token = signToken({ id: user._id.toString(), role: user.role });
  await notifyUser(user, "securityAlerts", {
    type: "security_alert",
    title: "New sign-in",
    body: "A new sign-in was detected on your account.",
    link: "/settings/security",
  });
  res.json({ token, user: { id: user._id, email: user.email, role: user.role } });
});

module.exports = router;
