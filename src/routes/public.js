// backend/src/routes/public.js

const express = require("express");
const mongoose = require("mongoose");
const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const Translation = require("../models/Translation");
const { translateText } = require("../utils/translate");
const router = express.Router();

const setCache = (res, seconds) => {
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds}`);
};

const decodeKey = (key) => String(key || "").replace(/__dot__/g, ".").replace(/__dollar__/g, "$");
const decodeMessages = (obj = {}) => {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    out[decodeKey(k)] = v;
  });
  return out;
};

router.get("/languages", async (_req, res) => {
  setCache(res, 300);
  const languages = await Language.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  }).sort({ name: 1 }).lean();
  res.json({ languages });
});

router.get("/categories", async (_req, res) => {
  setCache(res, 300);
  const categories = await Category.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  })
    .select("_id label coverUrl isEnabled")
    .sort({ label: 1 })
    .lean();
  const normalized = categories.map((cat) => {
    const coverUrl = String(cat.coverUrl || "");
    return {
      ...cat,
      coverUrl: coverUrl.startsWith("data:image") ? "" : coverUrl,
    };
  });
  res.json({ categories: normalized });
});

router.get("/stats", async (_req, res) => {
  setCache(res, 60);
  const enabledFilter = { $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] };
  const [itemsCount, categoriesCount] = await Promise.all([
    Item.countDocuments(enabledFilter),
    Category.countDocuments(enabledFilter),
  ]);
  res.json({ itemsCount, categoriesCount });
});

router.get("/items", async (req, res) => {
  setCache(res, 60);
  const { categoryId, q } = req.query;
  const filter = { $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] };
  if (categoryId && mongoose.Types.ObjectId.isValid(String(categoryId))) {
    filter.categoryId = categoryId;
  }

  // Simple search (extend with Atlas Search later)
  if (q && String(q).trim()) {
    const s = String(q).trim();
    const regex = { $regex: s, $options: "i" };
    filter.$or = [
      { description: regex },
      {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $objectToArray: "$translations" },
                  as: "t",
                  cond: { $regexMatch: { input: "$$t.v", regex: s, options: "i" } }
                }
              }
            },
            0
          ]
        }
      }
    ];
  }

  const items = await Item.find(filter).sort({ createdAt: -1 }).limit(500).lean();
  res.json({ items });
});

router.get("/ads", async (req, res) => {
  setCache(res, 300);
  const { placement } = req.query;
  const filter = { isEnabled: true };
  if (placement) filter.placement = placement;
  const ads = await Ad.find(filter).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ ads });
});

router.get("/translations/languages", async (_req, res) => {
  setCache(res, 300);
  const list = await Translation.find({ $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] })
    .select("lang fontFamily messages isEnabled")
    .sort({ lang: 1 })
    .lean();
  const languages = list.map((row) => ({
    lang: row.lang,
    fontFamily: row.fontFamily || "",
    numKeys: Object.keys(row.messages || {}).length,
    isEnabled: row.isEnabled !== false,
  }));
  res.json({ languages });
});

router.get("/translations/:lang", async (req, res) => {
  setCache(res, 300);
  const lang = String(req.params.lang || "").trim().toLowerCase();
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  const doc = await Translation.findOne({ lang }).lean();
  if (!doc || doc.isEnabled === false) return res.status(404).json({ message: "Language not found." });
  res.json({
    lang: doc.lang,
    messages: decodeMessages(doc.messages || {}),
    fontFamily: doc.fontFamily || "",
    fontOverrides: decodeMessages(doc.fontOverrides || {}),
    isEnabled: doc.isEnabled !== false,
  });
});

router.post("/translate", async (req, res) => {
  const { q, source, target } = req.body || {};
  const text = String(q || "").trim();
  if (!text) return res.status(400).json({ message: "Text is required." });
  if (!target) return res.status(400).json({ message: "Target language is required." });
  try {
    const result = await translateText({
      text,
      source: source || "auto",
      target,
    });
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ message: err?.message || "Translation failed." });
  }
});

module.exports = router;
