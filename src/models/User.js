// backend/src/models/User.js

const mongoose = require("mongoose");

const UserSchema = new mongoose.Schema(
  {
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["user", "editor", "admin", "owner"], default: "user" },
    isActive: { type: Boolean, default: true },
    authProvider: { type: String, enum: ["local", "google"], default: "local" },
    googleId: { type: String, default: "" },
    planType: { type: String, enum: ["free", "premium"], default: "free" },
    planStartsAt: { type: Date, default: null },
    planEndsAt: { type: Date, default: null },

    name: { type: String, default: "" },
    company: { type: String, default: "" },
    phone: { type: String, default: "" },
    phoneCountryCode: { type: String, default: "" },
    avatarUrl: { type: String, default: "" },
    emailVerified: { type: Boolean, default: false },
    marketingOptIn: { type: Boolean, default: false },
    uiLanguage: { type: String, default: "en" },
    resetPasswordTokenHash: { type: String, default: "" },
    resetPasswordExpiresAt: { type: Date, default: null },
    notificationPreferences: {
      type: Object,
      default: {
        securityAlerts: true,
        accountUpdates: true,
        learningReminders: true,
        weeklyProgress: true,
        dailyChallenge: true,
        favoritesUpdates: true,
        productTips: false,
        editorRequestStatus: true,
        reviewNotes: true,
        approvalQueue: true,
        categoryHealth: true,
        systemAlerts: true,
        adsReview: true,
      }
    },

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
