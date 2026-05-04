// Seed English translations from frontend t("key","default") usages into MongoDB.
// Usage: node scripts/seedTranslationsFromFrontend.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDB } = require("../src/db");
const Translation = require("../src/models/Translation");

const FRONTEND_SRC = path.resolve(__dirname, "..", "..", "frontend", "src");

const isCodeFile = (file) => /\.(jsx?|tsx?)$/i.test(file);

const readAllFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      files.push(...readAllFiles(full));
    } else if (ent.isFile() && isCodeFile(ent.name)) {
      files.push(full);
    }
  }
  return files;
};

const unescapeString = (raw, quote) => {
  if (quote === "`") return raw;
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");
};

const extractTranslations = (content) => {
  const results = [];
  const re = /t\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\)/g;
  let m;
  while ((m = re.exec(content))) {
    const key = unescapeString(m[2], m[1]).trim();
    const value = unescapeString(m[4], m[3]);
    if (key) results.push([key, value]);
  }
  return results;
};

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI in backend/.env");
    process.exit(1);
  }
  await connectDB(process.env.MONGO_URI);

  const files = readAllFiles(FRONTEND_SRC);
  const messages = {};

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const entries = extractTranslations(content);
    for (const [key, value] of entries) {
      if (!messages[key]) messages[key] = value;
    }
  }

  const encodeKey = (key) => String(key || "").replace(/\./g, "__dot__").replace(/\$/g, "__dollar__");
  const existing = await Translation.findOne({ lang: "en" }).lean();
  const existingDecoded = existing?.messages instanceof Map
    ? Object.fromEntries(existing.messages.entries())
    : { ...(existing?.messages || {}) };
  const encodedMessages = {};
  Object.entries(messages || {}).forEach(([k, v]) => {
    encodedMessages[encodeKey(k)] = v;
  });
  const merged = { ...(existingDecoded || {}), ...(encodedMessages || {}) };

  const doc = await Translation.findOneAndUpdate(
    { lang: "en" },
    { $set: { messages: merged } },
    { new: true, upsert: true }
  );

  console.log(`[seed] extracted keys: ${Object.keys(messages).length}`);
  const enKeyCount = doc.messages instanceof Map
    ? doc.messages.size
    : Object.keys(doc.messages || {}).length;
  console.log(`[seed] total en keys after merge: ${enKeyCount}`);

  // Ensure other languages have all keys (fill missing only)
  const otherLangs = await Translation.find({ lang: { $ne: "en" } });
  for (const langDoc of otherLangs) {
    const existingMap = langDoc.messages instanceof Map
      ? Object.fromEntries(langDoc.messages.entries())
      : { ...(langDoc.messages || {}) };
    let changed = false;
    Object.entries(encodedMessages).forEach(([k, v]) => {
      if (existingMap[k] === undefined) {
        existingMap[k] = v;
        changed = true;
      }
    });
    if (changed) {
      langDoc.messages = existingMap;
      await langDoc.save();
    }
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[seed] failed", err);
  process.exit(1);
});
