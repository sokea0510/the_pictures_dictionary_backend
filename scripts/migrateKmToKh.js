// Migrate language code from km -> kh across collections.
// Usage: node scripts/migrateKmToKh.js

require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../src/db");
const Translation = require("../src/models/Translation");
const Language = require("../src/models/Language");
const Item = require("../src/models/Item");
const ChangeRequest = require("../src/models/ChangeRequest");
const User = require("../src/models/User");

const FROM = "km";
const TO = "kh";

const mapToObj = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value.entries());
  return { ...value };
};

const mergeMaps = (target, source) => {
  const out = { ...(target || {}) };
  Object.entries(source || {}).forEach(([k, v]) => {
    if (out[k] === undefined) out[k] = v;
  });
  return out;
};

const migrateTranslationDocs = async () => {
  const kmDoc = await Translation.findOne({ lang: FROM });
  const khDoc = await Translation.findOne({ lang: TO });

  if (kmDoc && khDoc) {
    const kmMessages = mapToObj(kmDoc.messages);
    const kmOverrides = mapToObj(kmDoc.fontOverrides);
    const khMessages = mapToObj(khDoc.messages);
    const khOverrides = mapToObj(khDoc.fontOverrides);

    khDoc.messages = mergeMaps(khMessages, kmMessages);
    khDoc.fontOverrides = mergeMaps(khOverrides, kmOverrides);
    if (!khDoc.fontFamily && kmDoc.fontFamily) {
      khDoc.fontFamily = kmDoc.fontFamily;
    }
    await khDoc.save();
    await Translation.deleteOne({ _id: kmDoc._id });
    return;
  }

  if (kmDoc && !khDoc) {
    kmDoc.lang = TO;
    await kmDoc.save();
  }
};

const migrateLanguages = async () => {
  const kmLang = await Language.findOne({ code: FROM });
  const khLang = await Language.findOne({ code: TO });
  if (kmLang && khLang) {
    await Language.deleteOne({ _id: kmLang._id });
    return;
  }
  if (kmLang && !khLang) {
    kmLang.code = TO;
    if (!kmLang.name || kmLang.name.toLowerCase() === "khmer") {
      kmLang.name = "Khmer";
    }
    await kmLang.save();
  }
};

const migrateItems = async () => {
  const cursor = Item.find({ $or: [{ "translations.km": { $exists: true } }, { "translations.kh": { $exists: true } }] }).cursor();
  for await (const item of cursor) {
    const translations = mapToObj(item.translations);
    let changed = false;
    if (translations[FROM] !== undefined) {
      if (translations[TO] === undefined) {
        translations[TO] = translations[FROM];
      }
      delete translations[FROM];
      changed = true;
    }
    if (changed) {
      item.translations = translations;
      item.markModified("translations");
      await item.save();
    }
  }
};

const migrateChangeRequests = async () => {
  const cursor = ChangeRequest.find({ "payload.translations.km": { $exists: true } }).cursor();
  for await (const req of cursor) {
    const payload = { ...(req.payload || {}) };
    const translations = mapToObj(payload.translations);
    if (translations[FROM] !== undefined) {
      if (translations[TO] === undefined) {
        translations[TO] = translations[FROM];
      }
      delete translations[FROM];
      payload.translations = translations;
      req.payload = payload;
      req.markModified("payload");
      await req.save();
    }
  }
};

const migrateUsers = async () => {
  await User.updateMany({ uiLanguage: FROM }, { $set: { uiLanguage: TO } });
  const cursor = User.find({ $or: [{ "history.fromLang": FROM }, { "history.toLang": FROM }] }).cursor();
  for await (const user of cursor) {
    const history = (user.history || []).map((h) => ({
      ...h.toObject?.() || h,
      fromLang: h.fromLang === FROM ? TO : h.fromLang,
      toLang: h.toLang === FROM ? TO : h.toLang,
    }));
    user.history = history;
    user.markModified("history");
    await user.save();
  }
};

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI in backend/.env");
    process.exit(1);
  }
  await connectDB(process.env.MONGO_URI);

  await migrateTranslationDocs();
  await migrateLanguages();
  await migrateItems();
  await migrateChangeRequests();
  await migrateUsers();

  console.log("[migrate] km -> kh complete");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[migrate] failed", err);
  process.exit(1);
});
