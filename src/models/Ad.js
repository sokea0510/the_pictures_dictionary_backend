// backend/src/models/Ad.js

const mongoose = require("mongoose");

const AdSchema = new mongoose.Schema(
  {
    placement: { type: String, enum: ["home_banner", "category_banner", "item_modal"], required: true },
    provider: { type: String, enum: ["manual", "adsense", "other"], default: "manual" },
    isEnabled: { type: Boolean, default: true },

    // manual
    title: String,
    imageUrl: String,
    linkUrl: String,

    // adsense/other scripts
    script: String
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ad", AdSchema);
