// backend/src/models/Ad.js

const mongoose = require("mongoose");

const AdSchema = new mongoose.Schema(
  {
    placement: { type: String, enum: ["home_banner", "category_banner", "item_modal", "top_header", "item_list_banner"], required: true },
    provider: { type: String, enum: ["manual", "adsense", "other"], default: "manual" },
    isEnabled: { type: Boolean, default: true },

    // manual
    title: String,
    imageUrl: String,
    imageUrlLarge: String,
    imageUrlMedium: String,
    imageUrlSmall: String,
    imageUrlWide: String,
    linkUrl: String,

    // adsense/other scripts
    script: String
  },
  { timestamps: true }
);

module.exports = mongoose.model("Ad", AdSchema);
