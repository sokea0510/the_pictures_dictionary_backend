// backend/src/models/Item.js

const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    imageUrl: { type: String, required: true },
    translations: { type: Map, of: String, default: {} },
    description: { type: String, required: true, trim: true },
    isEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Item", ItemSchema);
