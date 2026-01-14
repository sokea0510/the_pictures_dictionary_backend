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

module.exports = mongoose.model("Category", CategorySchema);
