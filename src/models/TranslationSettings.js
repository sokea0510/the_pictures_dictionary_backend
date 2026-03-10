// backend/src/models/TranslationSettings.js

const mongoose = require("mongoose");

const ProviderSchema = new mongoose.Schema(
  {
    azure: {
      key: { type: String, default: "" },
      region: { type: String, default: "" },
      endpoint: { type: String, default: "" },
      enabled: { type: Boolean, default: true },
    },
    google: {
      key: { type: String, default: "" },
      ttsKey: { type: String, default: "" },
      enabled: { type: Boolean, default: true },
    },
    aws: {
      accessKeyId: { type: String, default: "" },
      secretAccessKey: { type: String, default: "" },
      region: { type: String, default: "" },
      sessionToken: { type: String, default: "" },
      enabled: { type: Boolean, default: true },
    },
    libre: {
      url: { type: String, default: "" },
      apiKey: { type: String, default: "" },
      enabled: { type: Boolean, default: true },
    },
  },
  { _id: false }
);

const FeatureSchema = new mongoose.Schema(
  {
    quickTranslateEnabled: { type: Boolean, default: true },
  },
  { _id: false }
);

const TtsProviderSchema = new mongoose.Schema(
  {
    gemini: { enabled: { type: Boolean, default: true } },
    googleCloud: { enabled: { type: Boolean, default: true } },
    googleFallback: { enabled: { type: Boolean, default: true } },
  },
  { _id: false }
);

const TranslationSettingsSchema = new mongoose.Schema(
  {
    providers: { type: ProviderSchema, default: () => ({}) },
    features: { type: FeatureSchema, default: () => ({}) },
    ttsProviders: { type: TtsProviderSchema, default: () => ({}) },
    preferredProvider: { type: String, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("TranslationSettings", TranslationSettingsSchema);
