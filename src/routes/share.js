const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const mongoose = require("mongoose");
const Item = require("../models/Item");
const Category = require("../models/Category");
const BlogPost = require("../models/BlogPost");
const LearningLevel = require("../models/LearningLevel");
const LearningLesson = require("../models/LearningLesson");

const router = express.Router();
const BOT_UA_RE =
  /(facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|googlebot|bingbot)/i;
const FB_APP_ID = String(process.env.FB_APP_ID || "1330780272306011").trim();
const FB_PAGE_URL = String(process.env.FB_PAGE_URL || "https://facebook.com/61588266314748").trim();

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const stripText = (value) =>
  String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const imageTypeFromUrl = (url) => {
  const value = String(url || "").split("?")[0].toLowerCase();
  if (value.endsWith(".png")) return "image/png";
  if (value.endsWith(".webp")) return "image/webp";
  if (value.endsWith(".gif")) return "image/gif";
  if (value.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
};


const IMAGE_DIMENSION_CACHE = new Map();
const IMAGE_DIMENSION_CACHE_MS = 24 * 60 * 60 * 1000;
const IMAGE_DIMENSION_MAX_BYTES = 256 * 1024;
const IMAGE_DIMENSION_TIMEOUT_MS = 1200;

const validImageDimensions = (value) => {
  const width = Number(value?.width || 0);
  const height = Number(value?.height || 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  return { width: Math.round(width), height: Math.round(height) };
};

const parseImageDimensions = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;

  if (buffer.readUInt32BE(0) === 0x89504e47 && buffer.toString("ascii", 1, 4) === "PNG") {
    return validImageDimensions({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) });
  }

  const header = buffer.toString("ascii", 0, 6);
  if (header === "GIF87a" || header === "GIF89a") {
    return validImageDimensions({ width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) });
  }

  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      const width = 1 + buffer.readUIntLE(24, 3);
      const height = 1 + buffer.readUIntLE(27, 3);
      return validImageDimensions({ width, height });
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return validImageDimensions({
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      });
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const b0 = buffer[21];
      const b1 = buffer[22];
      const b2 = buffer[23];
      const b3 = buffer[24];
      return validImageDimensions({
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
      });
    }
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > buffer.length) break;
      const isStartOfFrame =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isStartOfFrame) {
        return validImageDimensions({
          width: buffer.readUInt16BE(offset + 7),
          height: buffer.readUInt16BE(offset + 5),
        });
      }
      offset += 2 + length;
    }
  }

  return null;
};

const fetchImageBytes = (url, redirects = 0) => new Promise((resolve) => {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    resolve(null);
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    resolve(null);
    return;
  }

  const client = parsed.protocol === "https:" ? https : http;
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    resolve(value);
  };

  const req = client.get(parsed, {
    headers: {
      Range: `bytes=0-${IMAGE_DIMENSION_MAX_BYTES - 1}`,
      "User-Agent": "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
    },
    timeout: IMAGE_DIMENSION_TIMEOUT_MS,
  }, (response) => {
    const location = response.headers.location;
    if ([301, 302, 303, 307, 308].includes(response.statusCode) && location && redirects < 3) {
      response.resume();
      try {
        finish(fetchImageBytes(new URL(location, parsed).toString(), redirects + 1));
      } catch {
        finish(null);
      }
      return;
    }

    if (!response.statusCode || response.statusCode >= 400) {
      response.resume();
      finish(null);
      return;
    }

    const chunks = [];
    let total = 0;
    response.on("data", (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total >= IMAGE_DIMENSION_MAX_BYTES) {
        req.destroy();
        finish(Buffer.concat(chunks, Math.min(total, IMAGE_DIMENSION_MAX_BYTES)));
      }
    });
    response.on("end", () => finish(Buffer.concat(chunks, total)));
  });

  req.on("timeout", () => {
    req.destroy();
    finish(null);
  });
  req.on("error", () => finish(null));
});

const getOgImageDimensions = async (url, fallback) => {
  const safeFallback = validImageDimensions(fallback) || { width: 1200, height: 630 };
  const value = String(url || "").trim();
  if (!/^https?:\/\//i.test(value)) return safeFallback;

  const cached = IMAGE_DIMENSION_CACHE.get(value);
  if (cached && Date.now() - cached.time < IMAGE_DIMENSION_CACHE_MS) return cached.dimensions;

  const buffer = await fetchImageBytes(value);
  const dimensions = validImageDimensions(parseImageDimensions(buffer)) || safeFallback;
  IMAGE_DIMENSION_CACHE.set(value, { time: Date.now(), dimensions });
  return dimensions;
};

const normalizeLang = (value, fallback) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const key = raw.split(/[-_]/)[0];
  if (["km", "kh", "khmer"].includes(key)) return "kh";
  if (["kr", "ko", "korean"].includes(key)) return "kr";
  if (["en", "eng", "english"].includes(key)) return "en";
  return key;
};


const getMapValue = (map, key) => {
  if (!map || !key) return undefined;
  if (typeof map.get === "function") return map.get(key);
  return map[key];
};

const getAliasedMapValue = (map, langCode) => {
  const key = normalizeLang(langCode, "");
  const altKeys =
    key === "kh" ? ["kh", "km", "khmer"] :
    key === "kr" ? ["kr", "ko", "korean"] :
    key === "en" ? ["en", "eng", "english"] :
    [key];
  return altKeys.map((candidate) => getMapValue(map, candidate)).find(Boolean);
};

const getLocalizedText = (map, langCode) => {
  const key = normalizeLang(langCode, "en");
  const get = (k) => {
    if (!map) return "";
    return typeof map.get === "function" ? map.get(k) : map[k];
  };
  const altKeys =
    key === "kh" ? ["km", "khmer"] :
    key === "kr" ? ["ko", "korean"] :
    key === "en" ? ["eng", "english"] :
    [];
  return String(get(key) || altKeys.map((k) => get(k)).find(Boolean) || get("en") || "").trim();
};

const getLocalizedList = (map, langCode, maxItems = 5) => {
  const text = getLocalizedText(map, langCode);
  if (text) {
    return text.split(/\n|,/).map((entry) => entry.trim()).filter(Boolean).slice(0, maxItems);
  }
  const key = normalizeLang(langCode, "en");
  const get = (k) => {
    if (!map) return [];
    return typeof map.get === "function" ? map.get(k) : map[k];
  };
  const altKeys =
    key === "kh" ? ["km", "khmer"] :
    key === "kr" ? ["ko", "korean"] :
    key === "en" ? ["eng", "english"] :
    [];
  const raw = get(key) || altKeys.map((k) => get(k)).find(Boolean) || get("en") || [];
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/\n|,/);
  return list.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, maxItems);
};

const getTranslation = (item, langCode) => {
  const key = normalizeLang(langCode, "en");
  const map = item?.translations || {};
  const get = (k) => (typeof map.get === "function" ? map.get(k) : map[k]);
  const altKeys =
    key === "kh"
      ? ["km", "khmer"]
      : key === "kr"
        ? ["ko", "korean"]
        : key === "en"
          ? ["eng", "english"]
          : [];
  return get(key) || altKeys.map((k) => get(k)).find(Boolean) || get("en") || "";
};

const frontEndBase = (req) => {
  const explicit = process.env.FRONTEND_URL || process.env.APP_BASE_URL || "";
  if (explicit) return explicit.replace(/\/+$/, "");
  const host = String(req.get("host") || "").toLowerCase();
  if (host === "api.picturedictionary.cloud" || host.startsWith("api.")) {
    return "https://picturedictionary.cloud";
  }
  const origin = `${req.protocol}://${req.get("host") || "localhost:4000"}`;
  return origin.replace(/\/+$/, "");
};

const requestPublicBase = (req) => {
  const proto = String(req.get("x-forwarded-proto") || req.protocol || "https")
    .split(",")[0]
    .trim();
  const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
  return `${proto || "https"}://${host || "localhost:4000"}`.replace(/\/+$/, "");
};

const absoluteImageUrl = (req, raw) => {
  const value = String(raw || "").trim();
  if (!value || value.startsWith("data:image")) return "";
  const encodePath = (url) => {
    try {
      const parsed = new URL(url);
      parsed.pathname = parsed.pathname
        .split("/")
        .map((part) => encodeURIComponent(decodeURIComponent(part)))
        .join("/");
      return parsed.toString();
    } catch {
      return url;
    }
  };
  if (/^https?:\/\//i.test(value)) return encodePath(value);
  if (value.startsWith("//")) return encodePath(`${req.protocol}:${value}`);
  const origin = `${req.protocol}://${req.get("host") || "localhost:4000"}`;
  return encodePath(`${origin}${value.startsWith("/") ? value : `/${value}`}`);
};

const getLearningWords = (lesson = {}) => {
  const blocks = Array.isArray(lesson.contentBlocks) ? lesson.contentBlocks : [];
  const blockWords = blocks
    .filter((block) => block?.type !== "quiz" && block?.word)
    .sort((a, b) => (Number(a?.order) || 0) - (Number(b?.order) || 0))
    .map((block) => block.word);
  return blockWords.length ? blockWords : (Array.isArray(lesson.words) ? lesson.words : []);
};

const getLearningTranslationEntry = (source, langCode) => {
  const code = normalizeLang(langCode, "");
  const map = source?.translations || source?.localized || {};
  const entry = getAliasedMapValue(map, code);
  return entry && typeof entry === "object" ? entry : {};
};

const getLearningWordValue = (word = {}, langCode, level = {}) => {
  const code = normalizeLang(langCode, "en");
  const target = normalizeLang(level.targetLanguage, "kr");
  const translation = normalizeLang(level.translationLanguage, "kh");
  if (code === "en") return String(word.english || "").trim();
  if (code === target) return String(word.word || getLearningTranslationEntry(word, code).word || "").trim();
  if (code === translation) return String(word.meaning || getLearningTranslationEntry(word, code).word || getLearningTranslationEntry(word, code).meaning || "").trim();
  const entry = getLearningTranslationEntry(word, code);
  return String(entry.word || entry.meaning || "").trim();
};

const getLearningWordNote = (word = {}, langCode) => {
  const code = normalizeLang(langCode, "");
  if (!code || code === "en") return "";
  return String(getLearningTranslationEntry(word, code).meaning || "").trim();
};

const getLearningExampleValue = (example = {}, langCode, level = {}) => {
  const code = normalizeLang(langCode, "en");
  const target = normalizeLang(level.targetLanguage, "kr");
  const translation = normalizeLang(level.translationLanguage, "kh");
  if (code === "en") return String(example.english || "").trim();
  if (code === target) return String(example.selected || getAliasedMapValue(example.translations, code) || "").trim();
  if (code === translation) return String(example.meaning || getAliasedMapValue(example.translations, code) || "").trim();
  const translated = getAliasedMapValue(example.translations || example.localized, code);
  if (translated && typeof translated === "object") return String(translated.text || translated.sentence || translated.value || "").trim();
  return String(translated || "").trim();
};

const learningLanguageName = (code) => {
  const key = normalizeLang(code, "en");
  return ({ en: "English", kh: "Khmer", kr: "Korean", ja: "Japanese", zh: "Chinese", th: "Thai", vi: "Vietnamese" })[key] || key.toUpperCase();
};

const learningShareFontFamily = (code) => {
  const key = normalizeLang(code, "en");
  if (key === "kh") return "Noto Sans Khmer, sans-serif";
  if (key === "kr") return "Noto Sans KR, Noto Sans Khmer, DejaVu Sans, sans-serif";
  return "DejaVu Sans, Noto Sans KR, Noto Sans Khmer, sans-serif";
};

const learningShareLang = (code) => {
  const key = normalizeLang(code, "en");
  return ({ kh: "km", kr: "ko", en: "en", ja: "ja", zh: "zh", th: "th", vi: "vi" })[key] || key;
};

const learningShareTextStyle = (code, weight = 800) => {
  const key = normalizeLang(code, "en");
  const resolvedWeight = key === "kh" && Number(weight) > 700 ? 700 : weight;
  const lang = escapeHtml(learningShareLang(key));
  return `font-family="${escapeHtml(learningShareFontFamily(key))}" font-weight="${resolvedWeight}" xml:lang="${lang}" lang="${lang}"`;
};

const splitGraphemes = (value) => {
  const text = String(value || "");
  if (!text) return [];
  try {
    const segmenter = new Intl.Segmenter("km", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (part) => part.segment);
  } catch {
    return Array.from(text);
  }
};

const truncateGraphemes = (value, max = 80, fallback = "-") => {
  const text = String(value || "").trim();
  if (!text) return fallback;
  return splitGraphemes(text).slice(0, max).join("");
};

const svgText = (value, max = 80, fallback = "-") => escapeHtml(truncateGraphemes(value, max, fallback));

const splitSvgLines = (value, maxPerLine = 45, maxLines = 2) => {
  const text = String(value || "").trim();
  if (!text) return [];
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  const pushGraphemeChunks = (chunk) => {
    const graphemes = splitGraphemes(chunk);
    for (let i = 0; i < graphemes.length && lines.length < maxLines; i += maxPerLine) {
      lines.push(graphemes.slice(i, i + maxPerLine).join(""));
    }
  };
  if (words.length <= 1) {
    pushGraphemeChunks(text);
    return lines.slice(0, maxLines);
  }
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (splitGraphemes(candidate).length > maxPerLine && current) {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    } else {
      current = candidate;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.slice(0, maxLines);
};

let LEARNING_FONTCONFIG_FILE = "";
const fontDirFor = (packageName, relativeFile) => {
  try {
    return path.dirname(require.resolve(`${packageName}/${relativeFile}`));
  } catch {
    return "";
  }
};

const ensureLearningFontConfig = () => {
  if (process.env.FONTCONFIG_FILE && fs.existsSync(process.env.FONTCONFIG_FILE)) return process.env.FONTCONFIG_FILE;
  if (LEARNING_FONTCONFIG_FILE && fs.existsSync(LEARNING_FONTCONFIG_FILE)) {
    process.env.FONTCONFIG_FILE = LEARNING_FONTCONFIG_FILE;
    return LEARNING_FONTCONFIG_FILE;
  }
  const fontDirs = [
    fontDirFor("@expo-google-fonts/noto-sans-kr", "400Regular/NotoSansKR_400Regular.ttf"),
    fontDirFor("@expo-google-fonts/noto-sans-kr", "700Bold/NotoSansKR_700Bold.ttf"),
    fontDirFor("@expo-google-fonts/noto-sans-kr", "900Black/NotoSansKR_900Black.ttf"),
    fontDirFor("@expo-google-fonts/noto-sans-khmer", "400Regular/NotoSansKhmer_400Regular.ttf"),
    fontDirFor("@expo-google-fonts/noto-sans-khmer", "700Bold/NotoSansKhmer_700Bold.ttf"),
    fontDirFor("@expo-google-fonts/noto-sans-khmer", "900Black/NotoSansKhmer_900Black.ttf"),
    "/usr/share/fonts/truetype/dejavu",
  ].filter(Boolean);
  const configDir = path.resolve(__dirname, "../../tmp");
  fs.mkdirSync(configDir, { recursive: true });
  LEARNING_FONTCONFIG_FILE = path.join(configDir, "learning-fonts.conf");
  const fontConfig = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
${fontDirs.map((dir) => `  <dir>${escapeHtml(dir)}</dir>`).join("\n")}
  <cachedir>${escapeHtml(path.join(configDir, "font-cache"))}</cachedir>
  <config></config>
</fontconfig>`;
  fs.writeFileSync(LEARNING_FONTCONFIG_FILE, fontConfig);
  process.env.FONTCONFIG_FILE = LEARNING_FONTCONFIG_FILE;
  return LEARNING_FONTCONFIG_FILE;
};

const getLearningShareData = async (req) => {
  const levelSlug = String(req.params.levelSlug || "").trim().toLowerCase();
  const lessonSlug = String(req.params.lessonSlug || "").trim().toLowerCase();
  const level = await LearningLevel.findOne({ slug: levelSlug, status: "published" }).lean();
  if (!level) return null;
  const lesson = await LearningLesson.findOne({ levelId: level._id, slug: lessonSlug, status: "published" }).lean();
  if (!lesson) return null;
  const words = getLearningWords(lesson);
  const wordIndex = Math.min(Math.max(Number(req.query.word || req.query.wordIndex || 0) || 0, 0), Math.max(words.length - 1, 0));
  const word = words[wordIndex] || words[0] || {};
  const learningLang = normalizeLang(req.query.to || req.query.learning || level.targetLanguage, normalizeLang(level.targetLanguage, "kr"));
  const meaningLang = normalizeLang(req.query.from || req.query.meaning || level.translationLanguage, normalizeLang(level.translationLanguage, "kh"));
  const learningCode = learningLang.toUpperCase();
  const meaningCode = meaningLang.toUpperCase();
  const learnedWord = getLearningWordValue(word, learningLang, level) || word.word || word.english || "Learning Word";
  const baseWord = getLearningWordValue(word, "en", level) || word.english || learnedWord;
  const meaningWord = getLearningWordValue(word, meaningLang, level) || word.meaning || baseWord;
  const note = getLearningWordNote(word, meaningLang) || getLearningWordNote(word, learningLang);
  const examples = (Array.isArray(word.examples) ? word.examples : []).slice(0, 3).map((example) => ({
    selected: getLearningExampleValue(example, learningLang, level) || example.selected || example.english || example.meaning || "",
    english: getLearningExampleValue(example, "en", level) || example.english || "",
    meaning: getLearningExampleValue(example, meaningLang, level) || example.meaning || example.english || example.selected || "",
  }));
  return { level, lesson, word, wordIndex, learningLang, meaningLang, learningCode, meaningCode, learnedWord, pronunciation: String(word.pronunciation || "").trim(), baseWord, meaningWord, note, examples };
};

const renderLearningShareSvg = (data) => {
  const accent = /^#[0-9a-f]{6}$/i.test(String(data.level.accentColor || "")) ? data.level.accentColor : "#0f766e";
  const languageName = learningLanguageName(data.learningLang);
  const meaningName = learningLanguageName(data.meaningLang);
  const examples = data.examples.slice(0, 2);
  const badgeStyle = learningShareTextStyle("en", 900);
  const englishStyle = learningShareTextStyle("en", 800);
  const learningStyle = learningShareTextStyle(data.learningLang, 900);
  const learningExampleStyle = learningShareTextStyle(data.learningLang, 900);
  const meaningStyle = learningShareTextStyle(data.meaningLang, 800);
  const meaningStrongStyle = learningShareTextStyle(data.meaningLang, 700);
  const rows = examples.map((example, index) => {
    const y = 760 + index * 168;
    const divider = index === 0 && examples.length > 1 ? `<line x1="76" y1="${y + 124}" x2="646" y2="${y + 124}" stroke="#e2e8f0" stroke-width="2" stroke-dasharray="5 8"/>` : "";
    return `${divider}
    <circle cx="60" cy="${y - 8}" r="18" fill="#059669"/><text x="60" y="${y - 3}" text-anchor="middle" ${badgeStyle} font-size="14" fill="#fff">${svgText(data.learningCode, 4)}</text><text x="94" y="${y}" ${learningExampleStyle} font-size="24" fill="#0f172a">${svgText(example.selected, 45)}</text>
    <circle cx="60" cy="${y + 40}" r="18" fill="#2563eb"/><text x="60" y="${y + 45}" text-anchor="middle" ${badgeStyle} font-size="14" fill="#fff">EN</text><text x="94" y="${y + 48}" ${englishStyle} font-size="23" fill="#334155">${svgText(example.english, 48)}</text>
    <circle cx="60" cy="${y + 88}" r="18" fill="#0f766e"/><text x="60" y="${y + 93}" text-anchor="middle" ${badgeStyle} font-size="14" fill="#fff">${svgText(data.meaningCode, 4)}</text><text x="94" y="${y + 96}" ${meaningStrongStyle} font-size="23" fill="#334155">${svgText(example.meaning, 48)}</text>`;
  }).join("\n");
  const noteLines = splitSvgLines(data.note, 42, 2);
  const note = noteLines.length ? `<rect x="28" y="1110" width="664" height="104" rx="24" fill="rgba(236,253,245,.85)" stroke="#bbf7d0" stroke-width="2"/><text x="82" y="1150" ${badgeStyle} font-size="18" fill="#94a3b8">NOTE</text><text x="160" y="1150" ${meaningStrongStyle} font-size="21" fill="#475569">${svgText(noteLines[0], 60, "")}</text>${noteLines[1] ? `<text x="160" y="1180" ${meaningStrongStyle} font-size="21" fill="#475569">${svgText(noteLines[1], 60, "")}</text>` : ""}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
  <defs><style><![CDATA[
    text { text-rendering: geometricPrecision; }
  ]]></style></defs>
  <rect width="720" height="1280" fill="#fff"/>
  <rect x="8" y="8" width="704" height="1264" rx="34" fill="#eaf8f1" stroke="#bbf7d0" stroke-width="2"/>
  <rect x="268" y="26" width="184" height="40" rx="20" fill="#fff"/>
  <text x="360" y="52" text-anchor="middle" ${badgeStyle} font-size="18" fill="#475569">${String(data.wordIndex + 1).padStart(2, "0")} • ${svgText(languageName, 20)}</text>
  <text x="360" y="122" text-anchor="middle" ${learningStyle} font-size="58" fill="${escapeHtml(accent)}">${svgText(data.learnedWord, 24)}</text>
  <circle cx="326" cy="176" r="22" fill="rgba(255,255,255,.86)" stroke="#cbd5e1" stroke-width="2"/><text x="326" y="183" text-anchor="middle" ${badgeStyle} font-size="20" fill="${escapeHtml(accent)}">♪</text>
  <text x="390" y="184" text-anchor="middle" ${englishStyle} font-size="24" fill="#64748b">${svgText(data.pronunciation, 28)}</text>
  <rect x="220" y="215" width="280" height="58" rx="29" fill="rgba(255,255,255,.86)"/>
  <text x="360" y="251" text-anchor="middle" ${englishStyle} font-size="24" fill="#1e293b">EN: ${svgText(data.baseWord, 26)}</text>
  <text x="360" y="335" text-anchor="middle" ${meaningStyle} font-size="38" fill="${escapeHtml(accent)}">${svgText(data.meaningWord, 32)}</text>
  <text x="360" y="389" text-anchor="middle" ${badgeStyle} font-size="18" fill="#64748b">${svgText(meaningName.toUpperCase(), 18)} MEANING</text>
  <rect x="28" y="420" width="664" height="286" rx="24" fill="rgba(255,255,255,.74)"/>
  <circle cx="360" cy="560" r="72" fill="rgba(245,239,229,.95)"/>
  <rect x="333" y="536" width="54" height="48" rx="4" fill="none" stroke="${escapeHtml(accent)}" stroke-width="7"/>
  <circle cx="350" cy="550" r="6" fill="${escapeHtml(accent)}"/>
  <path d="M336 577 L354 562 L367 573 L384 556" fill="none" stroke="${escapeHtml(accent)}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
  ${rows}
  ${note}
  <text x="360" y="1240" text-anchor="middle" ${badgeStyle} font-size="18" fill="#0f766e">picturedictionary.cloud</text>
</svg>`;
};

const renderLearningSharePng = async (svg) => {
  let sharp;
  try {
    ensureLearningFontConfig();
    sharp = require("sharp");
  } catch {
    return null;
  }
  return sharp(Buffer.from(svg)).png().toBuffer();
};

router.get("/learning/:levelSlug/:lessonSlug/image.svg", async (req, res) => {
  const data = await getLearningShareData(req);
  if (!data) return res.status(404).type("text/plain").send("Learning lesson not found");
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  res.type("image/svg+xml").send(renderLearningShareSvg(data));
});

router.get("/learning/:levelSlug/:lessonSlug/image.png", async (req, res) => {
  const data = await getLearningShareData(req);
  if (!data) return res.status(404).type("text/plain").send("Learning lesson not found");
  const svg = renderLearningShareSvg(data);
  const png = await renderLearningSharePng(svg);
  if (!png) {
    return res.status(503).type("text/plain").send("PNG preview generation is not available. Install backend dependency: sharp.");
  }
  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  res.type("image/png").send(png);
});

router.get("/learning/:levelSlug/:lessonSlug", async (req, res) => {
  const data = await getLearningShareData(req);
  if (!data) return res.status(404).type("text/plain").send("Learning lesson not found");

  const webBase = frontEndBase(req);
  const shareParams = new URLSearchParams();
  shareParams.set("from", data.meaningLang);
  shareParams.set("to", data.learningLang);
  shareParams.set("word", String(data.wordIndex));
  const query = `?${shareParams.toString()}`;
  const appUrl = `${webBase}/learning/${encodeURIComponent(data.level.slug)}/${encodeURIComponent(data.lesson.slug)}`;
  const canonicalShareUrl = `${requestPublicBase(req)}/share/learning/${encodeURIComponent(data.level.slug)}/${encodeURIComponent(data.lesson.slug)}${query}`;
  const title = `${data.learnedWord} - ${data.lesson.title || "Picture Dictionary Learning"}`;
  const descriptionParts = [
    `${data.learningCode}: ${data.learnedWord}`,
    `EN: ${data.baseWord}`,
    `${data.meaningCode}: ${data.meaningWord}`,
    data.note ? `Note: ${data.note}` : "",
    data.examples[0]?.english ? `Example: ${data.examples[0].english}` : "",
  ].filter(Boolean);
  const description = stripText(descriptionParts.join(" - ")).slice(0, 280) || "Learn words with images, pronunciation, examples, and quizzes.";
  const ogImage = `${requestPublicBase(req)}/share/learning/${encodeURIComponent(data.level.slug)}/${encodeURIComponent(data.lesson.slug)}/image.png${query}`;
  const updatedTime = data.lesson.updatedAt || data.level.updatedAt || new Date();
  const isCrawler = BOT_UA_RE.test(String(req.get("user-agent") || ""));

  if (!isCrawler) {
    return res.redirect(302, appUrl);
  }

  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  res.type("html").send(`<!doctype html>
<html lang="${escapeHtml(data.learningLang || "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    ${FB_APP_ID ? `<meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}" />` : ""}
    ${FB_PAGE_URL ? `<meta property="article:publisher" content="${escapeHtml(FB_PAGE_URL)}" />` : ""}
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta property="og:image:width" content="720" />
    <meta property="og:image:height" content="1280" />
    <meta property="og:updated_time" content="${escapeHtml(new Date(updatedTime).toISOString())}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:image:src" content="${escapeHtml(ogImage)}" />
  </head>
  <body>
    <main>
      <h1 id="entry-title">${escapeHtml(title)}</h1>
      <img src="${escapeHtml(ogImage)}" alt="${escapeHtml(title)}" />
      <p>${escapeHtml(description)}</p>
      <p>Open the interactive page: <a href="${escapeHtml(appUrl)}">lesson details</a>.</p>
    </main>
  </body>
</html>`);
});

router.get("/item/:itemId/image", async (req, res) => {
  try {
    const itemId = String(req.params.itemId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(itemId)) return res.status(404).end();
    const item = await Item.findById(itemId).select("imageUrl imageThumbUrl").lean();
    if (!item) return res.status(404).end();
    const sourceUrl = absoluteImageUrl(req, item.imageUrl || item.imageThumbUrl);
    if (!sourceUrl) return res.status(404).end();
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(502).end();
    const source = Buffer.from(await response.arrayBuffer());
    const background = { r: 246, g: 247, b: 251 };
    const output = await sharp(source).rotate().resize(1200, 630, { fit: "contain", background }).flatten({ background }).jpeg({ quality: 88 }).toBuffer();
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/jpeg").send(output);
  } catch (error) {
    console.error("share item image failed", error);
    res.status(500).end();
  }
});

router.get("/item/:itemId/:slug?", async (req, res) => {
  const itemId = String(req.params.itemId || "").trim();
  const categoryId = String(req.query.categoryId || "").trim();
  const from = normalizeLang(req.query.from, "en");
  const to = normalizeLang(req.query.to, "kh");

  if (!mongoose.Types.ObjectId.isValid(itemId)) {
    return res.status(400).type("text/plain").send("Invalid itemId");
  }

  const item = await Item.findById(itemId).lean();
  if (!item) {
    return res.status(404).type("text/plain").send("Item not found");
  }

  const resolvedCategoryId = mongoose.Types.ObjectId.isValid(categoryId)
    ? categoryId
    : String(item.categoryId || "");
  const category = mongoose.Types.ObjectId.isValid(resolvedCategoryId)
    ? await Category.findById(resolvedCategoryId).select("label").lean()
    : null;

  const fromText = getTranslation(item, from) || "Picture Dictionary";
  const toText = getTranslation(item, to);
  const categoryLabel = String(category?.label || "").trim();
  const title = toText && toText !== "-" ? `${fromText} (${toText})` : fromText;
  const itemSlug = String(fromText || "word").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "word";
  const examples = getLocalizedList(item.examples, to, 3);
  const relatedWords = getLocalizedList(item.relatedWords, to, 5);
  const funFact = getLocalizedText(item.funFacts, to);
  const categoryExplanation = getLocalizedText(item.categoryExplanations, to);
  const descriptionParts = [
    toText && toText !== "-" ? `${fromText} means ${toText}` : "",
    categoryLabel ? `Category: ${categoryLabel}` : "",
    String(item.description || "").trim(),
    examples[0] ? `Example: ${examples[0]}` : "",
    funFact,
  ].filter(Boolean);
  const description = descriptionParts.join(" - ") || "Learn words with pictures, translation, and voice support.";
  const webBase = frontEndBase(req);
  const imageUrl = absoluteImageUrl(req, item.imageUrl || item.imageThumbUrl);
  const fallbackImage = String(process.env.SHARE_FALLBACK_IMAGE || "").trim()
    || `${webBase}/favicons.png`;
  const imageVersion = encodeURIComponent(new Date(item.updatedAt || item.createdAt || 0).getTime() || "1");
  const ogImage = imageUrl ? requestPublicBase(req) + "/share/item/" + encodeURIComponent(itemId) + "/image?v=" + imageVersion : fallbackImage;
  const ogImageType = imageTypeFromUrl(ogImage);
  const isCrawler = BOT_UA_RE.test(String(req.get("user-agent") || ""));
  const ogImageDimensions = isCrawler
    ? await getOgImageDimensions(ogImage, { width: 1200, height: 630 })
    : { width: 1200, height: 630 };
  const updatedTime = item.updatedAt || item.createdAt || new Date();

  const appUrlParams = new URLSearchParams();
  if (resolvedCategoryId && mongoose.Types.ObjectId.isValid(resolvedCategoryId)) {
    appUrlParams.set("categoryId", resolvedCategoryId);
  }
  appUrlParams.set("itemId", itemId);
  appUrlParams.set("from", from);
  appUrlParams.set("to", to);
  const appUrl = `${webBase}/dictionary?${appUrlParams.toString()}`;
  const canonicalShareUrl = `${requestPublicBase(req)}/share/item/${encodeURIComponent(itemId)}/${encodeURIComponent(itemSlug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const requestedSlug = String(req.params.slug || "").trim().toLowerCase();
  if (requestedSlug !== itemSlug) {
    return res.redirect(301, canonicalShareUrl);
  }
  if (!isCrawler) {
    return res.redirect(302, appUrl);
  }

  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  res.type("html").send(`<!doctype html>
<html lang="${escapeHtml(to || from || "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    ${FB_APP_ID ? `<meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}" />` : ""}
    ${FB_PAGE_URL ? `<meta property="article:publisher" content="${escapeHtml(FB_PAGE_URL)}" />` : ""}
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:type" content="${escapeHtml(ogImageType)}" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta property="og:image:width" content="${escapeHtml(ogImageDimensions.width)}" />
    <meta property="og:image:height" content="${escapeHtml(ogImageDimensions.height)}" />
    <meta property="og:updated_time" content="${escapeHtml(new Date(updatedTime).toISOString())}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:image:src" content="${escapeHtml(ogImage)}" />
    <style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#f4f7f6;color:#172033;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.site-header{background:#fff;border-bottom:1px solid #dfe7e3}.site-header div{max-width:1040px;margin:auto;padding:16px 24px;display:flex;align-items:center;justify-content:space-between}.brand{font-size:18px;font-weight:800;color:#123d32;text-decoration:none}.home-link{color:#087f5b;text-decoration:none;font-weight:700}main{max-width:960px;margin:32px auto;padding:36px;background:#fff;border:1px solid #dfe7e3;border-radius:24px;box-shadow:0 18px 50px rgba(15,23,42,.08)}h1{margin:0 0 24px;font-size:clamp(32px,5vw,48px);line-height:1.1;color:#102a25}main>img{display:block;width:100%;height:auto;max-height:560px;object-fit:contain;background:#f6f7fb;border-radius:18px;margin-bottom:28px}p{font-size:16px;line-height:1.75;color:#41524e}strong{color:#173f35}a{color:#087f5b}section{margin:24px 0;padding:20px 24px;border:1px solid #bdebd8;border-radius:16px;background:#effcf6}section h2{margin:0 0 12px;color:#126c52}ul{padding-left:24px;line-height:1.8}main>p:last-child{margin-top:30px;padding-top:24px;border-top:1px solid #dfe7e3}main>p:last-child a{display:inline-flex;margin-left:8px;padding:11px 18px;border-radius:999px;background:#087f5b;color:#fff;text-decoration:none;font-weight:800}@media(max-width:700px){.site-header div{padding:14px 18px}main{margin:16px;padding:22px;border-radius:18px}main>img{border-radius:12px}}</style>
  </head>
  <body>
    <header class="site-header"><div><a class="brand" href="/">Picture Dictionary</a><a class="home-link" href="/">Browse dictionary</a></div></header>
    <main aria-labelledby="entry-title">
      <h1 id="entry-title">${escapeHtml(title)}</h1>
      ${ogImage ? `<img src="${escapeHtml(ogImage)}" alt="${escapeHtml(title)}" />` : ""}
      <p><strong>Category:</strong> ${category && resolvedCategoryId ? `<a href="/share/category/${encodeURIComponent(resolvedCategoryId)}/${encodeURIComponent(String(categoryLabel || "category").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category")}">${escapeHtml(categoryLabel || "Vocabulary")}</a>` : escapeHtml(categoryLabel || "Vocabulary")}</p>
      <p><strong>Definition:</strong> ${escapeHtml(String(item.description || "No description yet.").trim())}</p>
      ${categoryExplanation ? `<p><strong>Category explanation:</strong> ${escapeHtml(categoryExplanation)}</p>` : ""}
      ${examples.length ? `<section><h2>Examples</h2><ul>${examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul></section>` : ""}
      ${funFact ? `<p><strong>Fun fact:</strong> ${escapeHtml(funFact)}</p>` : ""}
      ${relatedWords.length ? `<section><h2>Related words</h2><ul>${relatedWords.map((word) => `<li>${escapeHtml(word)}</li>`).join("")}</ul></section>` : ""}
      <p>Continue learning in the interactive dictionary: <a href="${escapeHtml(appUrl)}">Open item details</a>.</p>
    </main>
  </body>
</html>`);
});

router.get("/blog/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim().toLowerCase();
  if (!slug) {
    return res.status(400).type("text/plain").send("Invalid slug");
  }

  const post = await BlogPost.findOne({ slug, status: "published" }).lean();
  if (!post) {
    return res.status(404).type("text/plain").send("Post not found");
  }

  const webBase = frontEndBase(req);
  const requestedLang = normalizeLang(req.query.lang || req.query.language || "", "");
  const shareParams = new URLSearchParams();
  if (requestedLang) shareParams.set("lang", requestedLang);
  const previewVersion = String(req.query.v || req.query.preview || "").trim();
  if (previewVersion) shareParams.set("v", previewVersion);
  const langQuery = shareParams.toString() ? `?${shareParams.toString()}` : "";
  const originalLanguage = normalizeLang(post.originalLanguage || "en", "en");
  const selectedTranslation = requestedLang && requestedLang !== originalLanguage ? getAliasedMapValue(post.translations, requestedLang) : null;
  const previewTitle = selectedTranslation?.title || post.title;
  const previewExcerpt = selectedTranslation?.excerpt || post.excerpt;
  const previewContent = selectedTranslation?.content || post.content;
  const title = String(previewTitle || "Picture Dictionary Blog").trim();
  const description =
    stripText(previewExcerpt).slice(0, 280) ||
    stripText(previewContent).slice(0, 280) ||
    "Read education, language, health, and learning articles from Picture Dictionary.";
  const imageUrl = absoluteImageUrl(req, post.coverImageUrl);
  const fallbackImage = String(process.env.SHARE_FALLBACK_IMAGE || "").trim()
    || `${webBase}/favicons.png`;
  const ogImage = imageUrl || fallbackImage;
  const ogImageType = imageTypeFromUrl(ogImage);
  const isCrawler = BOT_UA_RE.test(String(req.get("user-agent") || ""));
  const ogImageDimensions = isCrawler
    ? await getOgImageDimensions(ogImage, { width: 1200, height: 675 })
    : { width: 1200, height: 675 };
  const updatedTime = post.updatedAt || post.publishedAt || post.createdAt || new Date();
  const appUrl = `${webBase}/blog/${encodeURIComponent(slug)}${langQuery}`;
  const canonicalShareUrl = `${requestPublicBase(req)}/share/blog/${encodeURIComponent(slug)}${langQuery}`;

  if (!isCrawler) {
    return res.redirect(302, appUrl);
  }

  res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
  res.set(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  );
  res.type("html").send(`<!doctype html>
<html lang="${escapeHtml(requestedLang || originalLanguage || "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    ${FB_APP_ID ? `<meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}" />` : ""}
    ${FB_PAGE_URL ? `<meta property="article:publisher" content="${escapeHtml(FB_PAGE_URL)}" />` : ""}
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:type" content="${escapeHtml(ogImageType)}" />
    <meta property="og:image:alt" content="${escapeHtml(post.coverImageAlt || title)}" />
    <meta property="og:image:width" content="${escapeHtml(ogImageDimensions.width)}" />
    <meta property="og:image:height" content="${escapeHtml(ogImageDimensions.height)}" />
    <meta property="og:updated_time" content="${escapeHtml(new Date(updatedTime).toISOString())}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:image:src" content="${escapeHtml(ogImage)}" />
  </head>
  <body>
    <p>Redirecting to <a href="${escapeHtml(appUrl)}">blog post</a>...</p>
  </body>
</html>`);
});

module.exports = router;

router.get("/category/:categoryId/:slug?", async (req, res) => {
  try {
    const categoryId = String(req.params.categoryId || "").trim();
    if (!mongoose.Types.ObjectId.isValid(categoryId)) return res.status(404).send("Category not found");
    const [category, items] = await Promise.all([
      Category.findOne({ _id: categoryId, $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] }).lean(),
      Item.find({ categoryId, $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] }).sort({ "translations.en": 1 }).lean(),
    ]);
    if (!category) return res.status(404).send("Category not found");
    const completeItems = items.filter((item) =>
      item.imageUrl &&
      String(item.translations?.en || "").trim() &&
      String(item.description || "").trim().length >= 80 &&
      String(item.phoneticPronunciations?.en || "").trim() &&
      getLocalizedList(item.examples, "en", 3).length >= 1 &&
      getLocalizedList(item.relatedWords, "en", 5).length >= 2
    );
    const categorySlug = String(req.params.slug || category.label || "category").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "category";
    const canonicalUrl = requestPublicBase(req) + "/share/category/" + encodeURIComponent(categoryId) + "/" + encodeURIComponent(categorySlug);
    const title = category.label + " Picture Dictionary";
    const description = "Learn " + completeItems.length + " reviewed " + category.label.toLowerCase() + " words with original pictures, definitions, pronunciation, examples, translations, and related vocabulary.";
    const cards = completeItems.map((item) => {
      const word = String(item.translations?.en || "Word").trim();
      const itemSlug = word.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "word";
      const href = "/share/item/" + encodeURIComponent(item._id) + "/" + encodeURIComponent(itemSlug) + "?from=en&to=kh";
      const image = "/share/item/" + encodeURIComponent(item._id) + "/image?v=" + encodeURIComponent(new Date(item.updatedAt || item.createdAt || 0).getTime() || "1");
      return '<article><a href="' + href + '"><img src="' + image + '" alt="' + escapeHtml(word) + '" width="320" height="168" loading="lazy" /><h2>' + escapeHtml(word) + '</h2></a><p>' + escapeHtml(String(item.description || "").trim()) + '</p></article>';
    }).join("");
    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    res.type("html").send('<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>' + escapeHtml(title) + '</title><meta name="description" content="' + escapeHtml(description) + '" /><meta name="robots" content="index, follow, max-image-preview:large" /><link rel="canonical" href="' + escapeHtml(canonicalUrl) + '" /><meta property="og:type" content="website" /><meta property="og:site_name" content="Picture Dictionary" />' + (FB_APP_ID ? '<meta property="fb:app_id" content="' + escapeHtml(FB_APP_ID) + '" />' : '') + '<meta property="og:title" content="' + escapeHtml(title) + '" /><meta property="og:description" content="' + escapeHtml(description) + '" /><meta property="og:url" content="' + escapeHtml(canonicalUrl) + '" /><style>body{font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:1100px;margin:auto;padding:24px}nav a,a{color:#087f5b}header{max-width:800px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:24px;margin-top:28px}article{border:1px solid #dfe5e2;border-radius:16px;padding:16px;background:#fff}article img{width:100%;height:auto;aspect-ratio:40/21;object-fit:contain;background:#f6f7fb;border-radius:10px}h1,h2{line-height:1.2}</style></head><body><nav><a href="/">Picture Dictionary</a> � <a href="/about">About</a></nav><header><h1>' + escapeHtml(title) + '</h1><p>' + escapeHtml(description) + '</p></header><main class="grid">' + cards + '</main></body></html>');
  } catch (error) {
    console.error("share category failed", error);
    res.status(500).send("Could not load category");
  }
});
