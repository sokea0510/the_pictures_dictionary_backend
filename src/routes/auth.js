// backend/src/routes/auth.js

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { OAuth2Client } = require("google-auth-library");
const User = require("../models/User");
const { signToken } = require("../utils/jwt");
const { notifyUser } = require("../utils/notifications");
const { sendLoginOtpEmail } = require("../utils/email");

const router = express.Router();
const socialPasswordHash = async (provider, id) => bcrypt.hash(`${provider}:${id}:${Date.now()}`, 10);

const publicAuthUser = (user) => ({ id: user._id, email: user.email, role: user.role });

const sendLoginResponse = async (res, user) => {
  user.loginOtpHash = "";
  user.loginOtpExpiresAt = null;
  user.loginOtpLastSentAt = null;
  await user.save();
  const token = signToken({ id: user._id.toString(), role: user.role });
  await notifyUser(user, "securityAlerts", {
    type: "security_alert",
    title: "New sign-in",
    body: "A new sign-in was detected on your account.",
    link: "/settings/security",
  });
  res.json({ token, user: publicAuthUser(user) });
};

const getOtpConfig = () => ({
  expiresMinutes: Math.max(1, Number(process.env.LOGIN_OTP_EXPIRES_MINUTES || 10)),
  resendSeconds: Math.max(15, Number(process.env.LOGIN_OTP_RESEND_SECONDS || 60)),
});

const createOtp = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const hashOtp = (code) => crypto.createHash("sha256").update(String(code)).digest("hex");

let telegramBotUsernameCache = "";
async function getTelegramBotUsername() {
  const configured = process.env.TELEGRAM_BOT_USERNAME || process.env.TELEGRAM_BOT_NAME || "";
  if (configured) return configured.replace(/^@/, "");
  if (telegramBotUsernameCache) return telegramBotUsernameCache;
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token || typeof fetch !== "function") return "";
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = await response.json();
    telegramBotUsernameCache = String(data?.result?.username || "").replace(/^@/, "");
    return telegramBotUsernameCache;
  } catch {
    return "";
  }
}

router.get("/config", async (_req, res) => {
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN || "";
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || "",
    facebookClientId: process.env.FACEBOOK_CLIENT_ID || "",
    telegramBotId: telegramToken.includes(":") ? telegramToken.split(":")[0] : "",
    telegramBotUsername: await getTelegramBotUsername(),
    enabled: {
      google: !!process.env.GOOGLE_CLIENT_ID,
      facebook: !!(process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET),
      telegram: !!telegramToken,
    },
  });
});

router.post("/register", async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).max(80),
    email: z.string().email(),
    password: z.string().min(6),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const { name, email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();
  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) return res.status(409).json({ message: "Email already exists" });

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await User.create({ name, email: normalizedEmail, passwordHash, role: "user", authProvider: "local" });

  const { expiresMinutes } = getOtpConfig();
  const code = createOtp();
  user.loginOtpHash = hashOtp(code);
  user.loginOtpExpiresAt = new Date(Date.now() + expiresMinutes * 60 * 1000);
  user.loginOtpLastSentAt = new Date();
  await user.save();

  try {
    await sendLoginOtpEmail({ to: user.email, code, expiresMinutes });
  } catch (err) {
    await User.findByIdAndDelete(user._id);
    return res.status(500).json({ message: err?.message || "Failed to send account verification code." });
  }

  res.json({
    otpRequired: true,
    email: user.email,
    expiresMinutes,
    message: "Verification code sent to your email.",
  });
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

  const { expiresMinutes, resendSeconds } = getOtpConfig();
  const now = Date.now();
  const lastSent = user.loginOtpLastSentAt ? new Date(user.loginOtpLastSentAt).getTime() : 0;
  if (lastSent && now - lastSent < resendSeconds * 1000) {
    return res.status(429).json({
      message: `Please wait ${Math.ceil((resendSeconds * 1000 - (now - lastSent)) / 1000)} seconds before requesting another code.`,
      otpRequired: true,
      email: user.email,
    });
  }

  const code = createOtp();
  user.loginOtpHash = hashOtp(code);
  user.loginOtpExpiresAt = new Date(now + expiresMinutes * 60 * 1000);
  user.loginOtpLastSentAt = new Date(now);
  await user.save();

  try {
    await sendLoginOtpEmail({ to: user.email, code, expiresMinutes });
  } catch (err) {
    user.loginOtpHash = "";
    user.loginOtpExpiresAt = null;
    user.loginOtpLastSentAt = null;
    await user.save();
    return res.status(500).json({ message: err?.message || "Failed to send login verification code." });
  }

  res.json({
    otpRequired: true,
    email: user.email,
    expiresMinutes,
    message: "Verification code sent to your email.",
  });
});

router.post("/login/verify", async (req, res) => {
  const schema = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const email = parsed.data.email.toLowerCase();
  const user = await User.findOne({ email, isActive: true });
  if (!user || !user.loginOtpHash || !user.loginOtpExpiresAt) {
    return res.status(400).json({ message: "No verification code pending. Please sign in again." });
  }
  if (new Date(user.loginOtpExpiresAt).getTime() < Date.now()) {
    user.loginOtpHash = "";
    user.loginOtpExpiresAt = null;
    await user.save();
    return res.status(400).json({ message: "Verification code expired. Please sign in again." });
  }

  const expected = Buffer.from(user.loginOtpHash, "hex");
  const received = Buffer.from(hashOtp(parsed.data.code), "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return res.status(401).json({ message: "Invalid verification code." });
  }

  await sendLoginResponse(res, user);
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
  const schema = z.object({
    credential: z.string().min(1).optional(),
    accessToken: z.string().min(1).optional(),
  }).refine((value) => value.credential || value.accessToken, { message: "Google token required" });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.status(500).json({ message: "Google client ID not configured" });

  const client = new OAuth2Client(clientId);
  let payload;
  try {
    if (parsed.data.credential) {
      const ticket = await client.verifyIdToken({
        idToken: parsed.data.credential,
        audience: clientId,
      });
      payload = ticket.getPayload();
    } else {
      const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${parsed.data.accessToken}` },
      });
      if (!response.ok) throw new Error("Invalid Google access token");
      payload = await response.json();
    }
  } catch {
    return res.status(401).json({ message: "Invalid Google token" });
  }

  const email = String(payload?.email || "").toLowerCase();
  if (!email) return res.status(400).json({ message: "Google account email missing" });

  let user = await User.findOne({ email });
  if (!user) {
    const passwordHash = await socialPasswordHash("google", payload?.sub || email);
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

  await sendLoginResponse(res, user);
});

router.post("/facebook", async (req, res) => {
  const schema = z.object({ accessToken: z.string().min(1) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const appId = process.env.FACEBOOK_CLIENT_ID;
  const appSecret = process.env.FACEBOOK_CLIENT_SECRET;
  if (!appId || !appSecret) return res.status(500).json({ message: "Facebook login is not configured" });

  let profile;
  try {
    const appAccessToken = `${appId}|${appSecret}`;
    const debugUrl = new URL("https://graph.facebook.com/debug_token");
    debugUrl.searchParams.set("input_token", parsed.data.accessToken);
    debugUrl.searchParams.set("access_token", appAccessToken);
    const debugResponse = await fetch(debugUrl);
    const debugData = await debugResponse.json();
    if (!debugResponse.ok || !debugData?.data?.is_valid || String(debugData.data.app_id) !== String(appId)) {
      return res.status(401).json({ message: "Invalid Facebook token" });
    }

    const profileUrl = new URL("https://graph.facebook.com/me");
    profileUrl.searchParams.set("fields", "id,name,email,picture.type(large)");
    profileUrl.searchParams.set("access_token", parsed.data.accessToken);
    const profileResponse = await fetch(profileUrl);
    profile = await profileResponse.json();
    if (!profileResponse.ok || !profile?.id) return res.status(401).json({ message: "Invalid Facebook profile" });
  } catch {
    return res.status(401).json({ message: "Facebook login failed" });
  }

  const email = String(profile.email || `facebook_${profile.id}@facebook.local`).toLowerCase();
  let user = await User.findOne({ $or: [{ facebookId: String(profile.id) }, { email }] });
  if (!user) {
    user = await User.create({
      name: profile.name || "",
      email,
      passwordHash: await socialPasswordHash("facebook", profile.id),
      role: "user",
      authProvider: "facebook",
      facebookId: String(profile.id),
      avatarUrl: profile?.picture?.data?.url || "",
      emailVerified: !!profile.email,
    });
  } else {
    const updates = {};
    if (!user.facebookId) updates.facebookId = String(profile.id);
    if (!user.authProvider || user.authProvider === "local") updates.authProvider = "facebook";
    if (!user.avatarUrl && profile?.picture?.data?.url) updates.avatarUrl = profile.picture.data.url;
    if (profile.email) updates.emailVerified = true;
    if (Object.keys(updates).length) {
      user = await User.findByIdAndUpdate(user._id, { $set: updates }, { new: true });
    }
  }

  await sendLoginResponse(res, user);
});

router.post("/telegram", async (req, res) => {
  const schema = z.object({
    id: z.union([z.string(), z.number()]),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    photo_url: z.string().url().optional(),
    auth_date: z.union([z.string(), z.number()]),
    hash: z.string().min(1),
  }).passthrough();
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: "Invalid input" });

  const botToken = process.env.TELEGRAM_BOT_TOKEN || "";
  if (!botToken) return res.status(500).json({ message: "Telegram login is not configured" });

  const data = parsed.data;
  const ageSeconds = Math.floor(Date.now() / 1000) - Number(data.auth_date);
  if (!Number.isFinite(ageSeconds) || ageSeconds > 86400) {
    return res.status(401).json({ message: "Telegram login expired" });
  }

  const checkString = Object.keys(data)
    .filter((key) => key !== "hash" && data[key] !== undefined && data[key] !== null && data[key] !== "")
    .sort()
    .map((key) => `${key}=${data[key]}`)
    .join("\n");
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const expectedHash = crypto.createHmac("sha256", secret).update(checkString).digest("hex");
  const receivedHash = String(data.hash || "");
  if (
    receivedHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedHash, "hex"), Buffer.from(receivedHash, "hex"))
  ) {
    return res.status(401).json({ message: "Invalid Telegram login" });
  }

  const telegramId = String(data.id);
  const username = String(data.username || "").replace(/^@/, "");
  const email = `telegram_${telegramId}@telegram.local`;
  let user = await User.findOne({ $or: [{ telegramId }, { email }] });
  if (!user) {
    user = await User.create({
      name: [data.first_name, data.last_name].filter(Boolean).join(" ") || username || `Telegram ${telegramId}`,
      email,
      passwordHash: await socialPasswordHash("telegram", telegramId),
      role: "user",
      authProvider: "telegram",
      telegramId,
      avatarUrl: data.photo_url || "",
      emailVerified: false,
    });
  } else {
    const updates = {};
    if (!user.telegramId) updates.telegramId = telegramId;
    if (!user.authProvider || user.authProvider === "local") updates.authProvider = "telegram";
    if (!user.avatarUrl && data.photo_url) updates.avatarUrl = data.photo_url;
    if (Object.keys(updates).length) {
      user = await User.findByIdAndUpdate(user._id, { $set: updates }, { new: true });
    }
  }

  await sendLoginResponse(res, user);
});

module.exports = router;
