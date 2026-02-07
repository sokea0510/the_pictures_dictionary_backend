// backend/src/models/Category.js

const mongoose = require("mongoose");

const CategorySchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    coverUrl: { type: String, default: "" },
    isEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

CategorySchema.index({ label: 1 });
CategorySchema.index({ isEnabled: 1, label: 1 });

module.exports = mongoose.model("Category", CategorySchema);
