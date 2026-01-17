// backend/src/routes/public.js

const express = require("express");
const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");

const router = express.Router();

router.get("/languages", async (_req, res) => {
  const languages = await Language.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  }).sort({ name: 1 });
  res.json({ languages });
});

router.get("/categories", async (_req, res) => {
  const categories = await Category.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  }).sort({ label: 1 });
  res.json({ categories });
});

router.get("/items", async (req, res) => {
  const { categoryId, q } = req.query;
  const filter = { $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] };
  if (categoryId) filter.categoryId = categoryId;

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
