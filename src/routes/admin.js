// backend/src/routes/admin.js

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireAnyRole, requireRoleAtLeast } = require("../middleware/rbac");

const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const User = require("../models/User");
const bcrypt = require("bcryptjs");

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
router.post("/items", async (req, res) => {
  const doc = await Item.create(req.body);
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
  const users = await User.find().select("email role isActive createdAt").sort({ createdAt: -1 }).limit(500);
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
  const { role, isActive } = req.body || {};
  const patch = {};
  if (role) patch.role = role;
  if (typeof isActive === "boolean") patch.isActive = isActive;

  const user = await User.findByIdAndUpdate(req.params.id, { $set: patch }, { new: true })
    .select("email role isActive");
  res.json({ user });
});

module.exports = router;
