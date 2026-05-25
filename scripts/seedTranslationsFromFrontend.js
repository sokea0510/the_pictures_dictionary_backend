// Seed English translations from frontend t("key","default") usages into MongoDB.
// Also discovers static frontend UI text so missing labels can be translated.
// Usage: node scripts/seedTranslationsFromFrontend.js
// Optional: node scripts/seedTranslationsFromFrontend.js --no-auto
// Optional: node scripts/seedTranslationsFromFrontend.js --dry-run

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { connectDB } = require("../src/db");
const Translation = require("../src/models/Translation");

const FRONTEND_SRC = path.resolve(__dirname, "..", "..", "frontend", "src");
const REPORT_PATH = path.resolve(__dirname, "..", "tmp", "untranslated-frontend-strings.json");
const AUTO_PREFIX = "auto";
const AUTO_ENABLED = !process.argv.includes("--no-auto");
const DRY_RUN = process.argv.includes("--dry-run");

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
  if (quote === "`") return raw.replace(/\\`/g, "`").replace(/\\\\/g, "\\");
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

const decodeHtmlEntities = (value) => String(value || "")
  .replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">");

const normalizeUiText = (value) => decodeHtmlEntities(value)
  .replace(/\s+/g, " ")
  .trim();

const isProbablyUserText = (value) => {
  const text = normalizeUiText(value);
  if (!text || text.length < 2 || text.length > 320) return false;
  if (!/[\p{L}\p{N}]/u.test(text)) return false;
  if (/\$\{/.test(text)) return false;
  if (/[{};]/.test(text)) return false;
  if (/=>|&&|\|\|/.test(text)) return false;
  if (/^[([{].*[?:].*/.test(text)) return false;
  if (/\b(children|props|state|return|useEffect|useMemo|useState)\b/.test(text)) return false;
  if (/^(https?:|mailto:|tel:|data:|\/|#)/i.test(text)) return false;
  if (/^[A-Z0-9_]+$/.test(text) && text.length > 3) return false;
  if (/^[.#]?[a-z0-9_-]+$/i.test(text) && text.length > 28) return false;
  if (/\.(png|jpe?g|webp|svg|gif|css|js|jsx|ts|tsx)$/i.test(text)) return false;
  if (/^(true|false|null|undefined|object|function|return|const|let|var)$/i.test(text)) return false;
  return true;
};

const lineForIndex = (content, index) => content.slice(0, index).split(/\r?\n/).length;

const slugify = (value, fallback = "text") => {
  const slug = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return slug || fallback;
};

const moduleKeyForFile = (file) => path.relative(FRONTEND_SRC, file)
  .replace(/\.[^.]+$/, "")
  .split(path.sep)
  .map((part) => slugify(part))
  .join(".");

const reserveAutoKey = (usedKeys, baseKey, value) => {
  if (!usedKeys.has(baseKey) || usedKeys.get(baseKey) === value) {
    usedKeys.set(baseKey, value);
    return baseKey;
  }

  let counter = 2;
  let key = `${baseKey}.${counter}`;
  while (usedKeys.has(key) && usedKeys.get(key) !== value) {
    counter += 1;
    key = `${baseKey}.${counter}`;
  }
  usedKeys.set(key, value);
  return key;
};

const extractStaticUiStrings = (content, file) => {
  const results = [];
  const seen = new Set();

  const add = (rawValue, index, source) => {
    const value = normalizeUiText(rawValue);
    if (!isProbablyUserText(value)) return;

    const dedupeKey = `${source}:${value}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);

    results.push({
      value,
      source,
      file: path.relative(path.resolve(__dirname, "..", ".."), file),
      line: lineForIndex(content, index),
    });
  };

  const jsxTextRe = />([^<>{}]+)</g;
  let match;
  while ((match = jsxTextRe.exec(content))) {
    add(match[1], match.index + 1, "jsx-text");
  }

  const attrNames = "placeholder|title|aria-label|ariaLabel|alt";
  const attrLiteralRe = new RegExp(`\\b(?:${attrNames})\\s*=\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1`, "g");
  while ((match = attrLiteralRe.exec(content))) {
    add(unescapeString(match[2], match[1]), match.index, "jsx-attribute");
  }

  const attrExpressionRe = new RegExp(`\\b(?:${attrNames})\\s*=\\s*\\{\\s*(['"\`])((?:\\\\.|(?!\\1).)*)\\1\\s*\\}`, "g");
  while ((match = attrExpressionRe.exec(content))) {
    add(unescapeString(match[2], match[1]), match.index, "jsx-attribute");
  }

  const objectFieldRe = /\b(label|title|description|subtitle|text|header|question|placeholder|emptyText|helperText)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  while ((match = objectFieldRe.exec(content))) {
    add(unescapeString(match[3], match[2]), match.index, `object-${match[1]}`);
  }

  return results;
};

async function main() {
  const files = readAllFiles(FRONTEND_SRC);
  const messages = {};
  const autoReport = [];
  const usedAutoKeys = new Map();

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const entries = extractTranslations(content);
    for (const [key, value] of entries) {
      if (!messages[key]) messages[key] = value;
      usedAutoKeys.set(key, value);
    }

    if (AUTO_ENABLED) {
      const staticEntries = extractStaticUiStrings(content, file);
      for (const entry of staticEntries) {
        const baseKey = `${AUTO_PREFIX}.${moduleKeyForFile(file)}.${slugify(entry.value)}`;
        const key = reserveAutoKey(usedAutoKeys, baseKey, entry.value);
        if (!messages[key]) messages[key] = entry.value;
        autoReport.push({ key, ...entry });
      }
    }
  }

  console.log(`[seed] extracted keys: ${Object.keys(messages).length}`);
  if (AUTO_ENABLED) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(autoReport, null, 2)}\n`, "utf8");
    console.log(`[seed] static UI strings discovered: ${autoReport.length}`);
    console.log(`[seed] static UI report: ${path.relative(process.cwd(), REPORT_PATH)}`);
  }

  if (DRY_RUN) {
    console.log("[seed] dry run complete; MongoDB was not changed.");
    return;
  }

  if (!process.env.MONGO_URI) {
    console.error("Missing MONGO_URI in backend/.env");
    process.exit(1);
  }
  await connectDB(process.env.MONGO_URI);

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
