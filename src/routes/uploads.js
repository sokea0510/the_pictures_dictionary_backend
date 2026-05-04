// backend/src/routes/uploads.js

const express = require("express");
const { authRequired } = require("../middleware/auth");
const { requireRoleAtLeast } = require("../middleware/rbac");
const { uploadImageDataUrl } = require("../utils/storage");

const router = express.Router();

const ALLOWED_TYPES = new Set(["item", "category", "ad", "avatar", "blog", "misc"]);

const buildPrefix = (type, userId) => {
  const date = new Date();
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${type}/${yyyy}/${mm}/${dd}/${userId}`;
};

router.post("/", authRequired, requireRoleAtLeast("editor"), async (req, res) => {
  const { imageData, type } = req.body || {};
  if (!imageData || typeof imageData !== "string") {
    return res.status(400).json({ message: "Missing image data" });
  }

  const safeType = ALLOWED_TYPES.has(type) ? type : "misc";

  try {
    const uploaded = await uploadImageDataUrl({
      dataUrl: imageData,
      keyPrefix: buildPrefix(safeType, req.user.id || "unknown"),
    });
    return res.json({ url: uploaded.url, key: uploaded.key });
  } catch (err) {
    return res.status(400).json({ message: err?.message || "Image upload failed" });
  }
});

module.exports = router;
