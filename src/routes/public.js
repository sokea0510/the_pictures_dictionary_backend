// backend/src/routes/public.js

const express = require("express");
const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");

const router = express.Router();

router.get("/languages", async (_req, res) => {
  const languages = await Language.find({ isEnabled: true }).sort({ name: 1 });
  res.json({ languages });
});

router.get("/categories", async (_req, res) => {
  const categories = await Category.find({ isEnabled: true }).sort({ label: 1 });
  res.json({ categories });
});

router.get("/items", async (req, res) => {
  const { categoryId, q } = req.query;
  const filter = {};
  if (categoryId) filter.categoryId = categoryId;

  // Simple search (extend with Atlas Search later)
  if (q && String(q).trim()) {
    const s = String(q).trim();
    filter.$or = [
      { tags: { $in: [s] } },
      { "translations.en": { $regex: s, $options: "i" } },
      { "translations.ko": { $regex: s, $options: "i" } },
      { "translations.km": { $regex: s, $options: "i" } }
    ];
  }

  const items = await Item.find(filter).sort({ createdAt: -1 }).limit(500);
  res.json({ items });
});

router.get("/ads", async (req, res) => {
  const { placement } = req.query;
  const filter = { isEnabled: true };
  if (placement) filter.placement = placement;
  const ads = await Ad.find(filter).sort({ updatedAt: -1 }).limit(50);
  res.json({ ads });
});

module.exports = router;
