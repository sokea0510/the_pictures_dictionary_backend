// backend/src/routes/me.js

const express = require("express");
const { authRequired } = require("../middleware/auth");
const User = require("../models/User");

const router = express.Router();

router.get("/", authRequired, async (req, res) => {
  const user = await User.findById(req.user.id).select("email role favorites history");
  res.json({ user });
});

router.post("/history", authRequired, async (req, res) => {
  const { itemId, fromLang, toLang } = req.body || {};
  if (!itemId) return res.status(400).json({ message: "Missing itemId" });

  await User.findByIdAndUpdate(req.user.id, {
    $push: { history: { itemId, fromLang, toLang, at: new Date() } }
  });
  res.json({ ok: true });
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
