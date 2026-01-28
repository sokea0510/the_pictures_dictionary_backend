// backend/src/models/TranslationSettings.js

const mongoose = require("mongoose");

const ProviderSchema = new mongoose.Schema(
  {
    azure: {
      key: { type: String, default: "" },
      region: { type: String, default: "" },
      endpoint: { type: String, default: "" },
    },
    google: {
      key: { type: String, default: "" },
    },
    aws: {
      accessKeyId: { type: String, default: "" },
      secretAccessKey: { type: String, default: "" },
      region: { type: String, default: "" },
      sessionToken: { type: String, default: "" },
    },
    libre: {
      url: { type: String, default: "" },
      apiKey: { type: String, default: "" },
    },
  },
  { _id: false }
);

const TranslationSettingsSchema = new mongoose.Schema(
  {
    providers: { type: ProviderSchema, default: () => ({}) },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TranslationSettings", TranslationSettingsSchema);
