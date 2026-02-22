// backend/src/models/Item.js

const mongoose = require("mongoose");

const ItemSchema = new mongoose.Schema(
  {
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true },
    imageUrl: { type: String, required: true },
    imageThumbUrl: { type: String, default: "" },
    translations: { type: Map, of: String, default: {} },
    phoneticPronunciations: { type: Map, of: String, default: {} },
    description: { type: String, default: "", trim: true },
    isEnabled: { type: Boolean, default: true }
  },
  { timestamps: true }
);

ItemSchema.index({ isEnabled: 1, categoryId: 1, createdAt: -1 });
ItemSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Item", ItemSchema);
