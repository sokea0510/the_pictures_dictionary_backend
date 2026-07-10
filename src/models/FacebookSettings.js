const mongoose = require("mongoose");

const FacebookSettingsSchema = new mongoose.Schema(
  {
    pageId: { type: String, default: "" },
    pageAccessToken: { type: String, default: "" },
    publicApiBaseUrl: { type: String, default: "" },
    postsPerDay: { type: Number, default: 1, min: 1, max: 20 },
    isEnabled: { type: Boolean, default: true },
    postTime: { type: String, default: "08:00" },
    timeZone: { type: String, default: "Asia/Phnom_Penh" },
    fromLang: { type: String, default: "en" },
    toLang: { type: String, default: "kh" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FacebookSettings", FacebookSettingsSchema);
