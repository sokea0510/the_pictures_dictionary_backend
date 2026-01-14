// backend/src/models/User.js

const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "editor", "admin", "owner"], default: "user" },
    isActive: { type: Boolean, default: true },

    favorites: [{ type: mongoose.Schema.Types.ObjectId, ref: "Item" }],
    history: [
      {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "Item" },
        fromLang: String,
        toLang: String,
        at: { type: Date, default: Date.now }
      }
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", UserSchema);
