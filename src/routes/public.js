// backend/src/routes/public.js

const express = require("express");
const mongoose = require("mongoose");
const Language = require("../models/Language");
const Category = require("../models/Category");
const Item = require("../models/Item");
const Ad = require("../models/Ad");
const Translation = require("../models/Translation");
const TranslationSettings = require("../models/TranslationSettings");
const TranslationUsage = require("../models/TranslationUsage");
const { translateText } = require("../utils/translate");
const { hasGoogleServiceAccount, getGoogleAccessToken } = require("../utils/googleAuth");
const { buildCacheKey, readCachedAudio, writeCachedAudio } = require("../utils/ttsCache");
const router = express.Router();
const ttsInFlight = new Map();

const setCache = (res, seconds) => {
  res.set("Cache-Control", `public, max-age=${seconds}, stale-while-revalidate=${seconds}`);
};
const geminiApiBase = String(process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
const geminiTtsModel = String(process.env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts").trim();
const geminiVoiceName = String(process.env.GEMINI_TTS_VOICE || "Kore").trim();

const decodeKey = (key) => String(key || "").replace(/__dot__/g, ".").replace(/__dollar__/g, "$");
const decodeMessages = (obj = {}) => {
  const out = {};
  Object.entries(obj || {}).forEach(([k, v]) => {
    out[decodeKey(k)] = v;
  });
  return out;
};

const normalizeLangCode = (value, fallback = "") => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return fallback;
  const key = raw.split(/[-_]/)[0];
  if (["km", "kh", "khmer"].includes(key)) return "kh";
  if (["kr", "ko", "korean"].includes(key)) return "kr";
  if (["en", "eng", "english"].includes(key)) return "en";
  return key;
};

const languageAliases = (code) => {
  if (code === "kh") return ["km", "khmer"];
  if (code === "kr") return ["ko", "korean"];
  if (code === "en") return ["eng", "english"];
  return [];
};

const toGoogleTtsLanguageCode = (code) => {
  const normalized = normalizeLangCode(code || "en");
  if (normalized === "kh") return "km-KH";
  if (normalized === "kr") return "ko-KR";
  if (normalized === "en") return "en-US";
  if (!normalized) return "en-US";
  return normalized.includes("-") ? normalized : `${normalized}-${normalized.toUpperCase()}`;
};

const toGoogleTranslateTtsLang = (code) => {
  const normalized = normalizeLangCode(code || "en");
  if (normalized === "kh") return "km";
  if (normalized === "kr") return "ko";
  if (normalized === "en") return "en";
  return normalized || "en";
};

const parseRate = (value, fallback = 0.88) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1.25, Math.max(0.65, n));
};

const updateUsage = async ({ provider, chars }) => {
  const yearMonth = new Date().toISOString().slice(0, 7);
  await TranslationUsage.findOneAndUpdate(
    { provider, yearMonth },
    { $inc: { chars: Math.max(Number(chars) || 0, 0) } },
    { upsert: true, new: true }
  );
};

const isQuickTranslateEnabled = async () => {
  const settings = await TranslationSettings.findOne().select("features.quickTranslateEnabled").lean();
  return settings?.features?.quickTranslateEnabled !== false;
};

const extractInlineAudio = (data) => {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data || null;
      const b64 = String(inline?.data || "").trim();
      if (!b64) continue;
      const mimeType = String(inline?.mimeType || inline?.mime_type || "audio/wav").trim() || "audio/wav";
      return { buffer: Buffer.from(b64, "base64"), mimeType };
    }
  }
  return null;
};

const pcm16leToWav = ({ pcmBuffer, sampleRate = 24000, channels = 1 }) => {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const wavHeader = Buffer.alloc(44);
  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + dataSize, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16);
  wavHeader.writeUInt16LE(1, 20);
  wavHeader.writeUInt16LE(channels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitsPerSample, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(dataSize, 40);
  return Buffer.concat([wavHeader, pcmBuffer]);
};

router.get("/languages", async (_req, res) => {
  setCache(res, 300);
  const list = await Language.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  }).sort({ name: 1 }).lean();
  const languages = list.map((lang) => ({
    ...lang,
    code: normalizeLangCode(lang.code),
  }));
  res.json({ languages });
});

router.get("/categories", async (_req, res) => {
  setCache(res, 300);
  const categories = await Category.find({
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  })
    .select("_id label coverUrl isEnabled")
    .lean();
  const categoryIds = categories.map((cat) => cat._id);
  const itemCounts = await Item.aggregate([
    {
      $match: {
        categoryId: { $in: categoryIds },
        $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
      },
    },
    { $group: { _id: "$categoryId", itemCount: { $sum: 1 } } },
  ]);
  const countsByCategory = new Map(itemCounts.map((row) => [String(row._id), row.itemCount]));
  const normalized = categories.map((cat) => {
    const coverUrl = String(cat.coverUrl || "");
    return {
      ...cat,
      coverUrl: coverUrl.startsWith("data:image") ? "" : coverUrl,
      itemCount: countsByCategory.get(String(cat._id)) || 0,
    };
  }).sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), undefined, { sensitivity: "base" }));
  res.json({ categories: normalized });
});

router.get("/categories/:categoryId/image", async (req, res) => {
  const categoryId = String(req.params.categoryId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(categoryId)) return res.status(404).end();

  const category = await Category.findOne({
    _id: categoryId,
    $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  }).select("coverUrl updatedAt createdAt").lean();
  if (!category?.coverUrl) return res.status(404).end();

  let sourceUrl;
  try {
    sourceUrl = new URL(String(category.coverUrl));
  } catch {
    return res.status(404).end();
  }
  if (!["http:", "https:"].includes(sourceUrl.protocol)) return res.status(404).end();

  try {
    const response = await fetch(sourceUrl, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return res.status(502).end();
    const contentType = String(response.headers.get("content-type") || "image/jpeg");
    if (!contentType.startsWith("image/")) return res.status(502).end();
    const buffer = Buffer.from(await response.arrayBuffer());
    const updated = new Date(category.updatedAt || category.createdAt || Date.now()).toUTCString();
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Last-Modified", updated);
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.type(contentType).send(buffer);
  } catch (error) {
    console.error("category image proxy failed", error);
    res.status(502).end();
  }
});

router.get("/stats", async (_req, res) => {
  setCache(res, 60);
  const enabledFilter = { $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] };
  const [itemsCount, categoriesCount] = await Promise.all([
    Item.countDocuments(enabledFilter),
    Category.countDocuments(enabledFilter),
  ]);
  res.json({ itemsCount, categoriesCount });
});

router.get("/items", async (req, res) => {
  setCache(res, 60);
  const { categoryId, q } = req.query;
  const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const filter = { $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] };
  if (categoryId) {
    const normalizedCategoryId = String(categoryId).trim();
    if (!mongoose.Types.ObjectId.isValid(normalizedCategoryId)) {
      return res.status(400).json({ message: "Invalid categoryId" });
    }
    filter.categoryId = normalizedCategoryId;
  }

  // Simple search (extend with Atlas Search later)
  if (q && String(q).trim()) {
    const s = String(q).trim();
    const regex = { $regex: s, $options: "i" };
    filter.$or = [
      { description: regex },
      { "examples.en": regex },
      { "relatedWords.en": regex },
      { "funFacts.en": regex },
      { "categoryExplanations.en": regex },
      {
        $expr: {
          $gt: [
            {
              $size: {
                $filter: {
                  input: { $objectToArray: "$translations" },
                  as: "t",
                  cond: { $regexMatch: { input: "$$t.v", regex: s, options: "i" } }
                }
              }
            },
            0
          ]
        }
      }
    ];
  }

  const query = Item.find(filter).sort({ createdAt: -1 }).skip(offset).limit(limit).lean();
  const [items, total] = await Promise.all([
    query,
    Item.countDocuments(filter),
  ]);
  res.json({
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  });
});

router.get("/ads", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const { placement } = req.query;
  const filter = { isEnabled: true };
  if (placement) filter.placement = placement;
  const ads = await Ad.find(filter).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ ads });
});

router.get("/translations/languages", async (_req, res) => {
  setCache(res, 300);
  const list = await Translation.find({ $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] })
    .select("lang fontFamily messages isEnabled")
    .sort({ lang: 1 })
    .lean();
  const languages = list.map((row) => ({
    lang: normalizeLangCode(row.lang),
    fontFamily: row.fontFamily || "",
    numKeys: Object.keys(row.messages || {}).length,
    isEnabled: row.isEnabled !== false,
  }));
  res.json({ languages });
});

router.get("/translations/:lang", async (req, res) => {
  setCache(res, 300);
  const lang = normalizeLangCode(req.params.lang);
  if (!lang) return res.status(400).json({ message: "Missing language code." });
  const doc = await Translation.findOne({ lang: { $in: [lang, ...languageAliases(lang)] } })
    .sort({ createdAt: -1 })
    .lean();
  if (!doc || doc.isEnabled === false) return res.status(404).json({ message: "Language not found." });
  res.json({
    lang,
    messages: decodeMessages(doc.messages || {}),
    fontFamily: doc.fontFamily || "",
    fontOverrides: decodeMessages(doc.fontOverrides || {}),
    isEnabled: doc.isEnabled !== false,
  });
});

router.get("/translation-config", async (_req, res) => {
  try {
    const quickTranslateEnabled = await isQuickTranslateEnabled();
    return res.json({ quickTranslateEnabled });
  } catch {
    return res.json({ quickTranslateEnabled: true });
  }
});

const runTranslate = async ({ q, source, target }, res) => {
  try {
    const enabled = await isQuickTranslateEnabled();
    if (!enabled) {
      return res.status(403).json({ message: "Quick Translate is currently disabled." });
    }
  } catch {
    // Keep translation available if settings lookup fails.
  }
  const text = String(q || "").trim();
  if (!text) return res.status(400).json({ message: "Text is required." });
  if (!target) return res.status(400).json({ message: "Target language is required." });
  try {
    const result = await translateText({
      text,
      source: normalizeLangCode(source || "auto"),
      target: normalizeLangCode(target),
    });
    return res.json(result);
  } catch (err) {
    return res.status(502).json({ message: err?.message || "Translation failed." });
  }
};

router.get("/translate", async (req, res) => {
  const { q, source, target } = req.query || {};
  return runTranslate({ q, source, target }, res);
});

router.post("/translate", async (req, res) => {
  const { q, source, target } = req.body || {};
  return runTranslate({ q, source, target }, res);
});

router.get("/tts", async (req, res) => {
  const text = String(req.query?.text || "").trim();
  const lang = String(req.query?.lang || "en").trim();
  const speakingRate = parseRate(req.query?.rate, 0.88);
  if (!text) return res.status(400).json({ message: "Text is required." });
  if (text.length > 240) return res.status(400).json({ message: "Text too long for TTS." });

  let cloudApiKey = String(process.env.GOOGLE_TTS_KEY || process.env.GOOGLE_TRANSLATE_KEY || "").trim();
  let googleProviderEnabled = true;
  let ttsGeminiEnabled = true;
  let ttsGoogleCloudEnabled = true;
  let ttsGoogleFallbackEnabled = true;
  try {
    const settings = await TranslationSettings.findOne().select("providers.google ttsProviders").lean();
    googleProviderEnabled = settings?.providers?.google?.enabled !== false;
    ttsGeminiEnabled = settings?.ttsProviders?.gemini?.enabled !== false;
    ttsGoogleCloudEnabled = settings?.ttsProviders?.googleCloud?.enabled !== false;
    ttsGoogleFallbackEnabled = settings?.ttsProviders?.googleFallback?.enabled !== false;
    cloudApiKey =
      String(
        settings?.providers?.google?.ttsKey ||
        settings?.providers?.google?.key ||
        cloudApiKey
      ).trim();
  } catch {
    cloudApiKey = String(cloudApiKey || "").trim();
  }
  if (!ttsGeminiEnabled && !ttsGoogleCloudEnabled && !ttsGoogleFallbackEnabled) {
    return res.status(503).json({ message: "TTS provider is disabled." });
  }
  const languageCode = toGoogleTtsLanguageCode(lang);
  const geminiApiKey = String(
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_TTS_KEY ||
    process.env.GOOGLE_TRANSLATE_KEY ||
    ""
  ).trim();
  const geminiEnabled =
    ttsGeminiEnabled &&
    String(process.env.GEMINI_TTS_ENABLED || "true").toLowerCase() !== "false";
  const cacheKey = buildCacheKey({
    text,
    lang: normalizeLangCode(lang || "en"),
    rate: speakingRate,
  });

  const cached = await readCachedAudio(cacheKey);
  if (cached.hit && cached.buffer && cached.buffer.length > 0) {
    res.set("Content-Type", cached.mimeType || "audio/mpeg");
    res.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    res.set("X-TTS-Cache", "HIT");
    return res.send(cached.buffer);
  }

  const inFlight = ttsInFlight.get(cacheKey);
  if (inFlight) {
    try {
      const shared = await inFlight;
      res.set("Content-Type", shared.mimeType || "audio/mpeg");
      res.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
      res.set("X-TTS-Cache", "SHARED");
      return res.send(shared.buffer);
    } catch {
      return res.status(502).json({ message: "TTS provider unavailable." });
    }
  }

  const generator = (async () => {
    if (geminiEnabled && geminiApiKey) {
      try {
        const prompt = `Read exactly the following text in ${languageCode} with natural pacing:\n${text}`;
        const endpoint = `${geminiApiBase}/v1beta/models/${encodeURIComponent(geminiTtsModel)}:generateContent`;
        const geminiRes = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiApiKey,
          },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: {
                    voiceName: geminiVoiceName,
                  },
                },
              },
            },
          }),
        });
        const geminiData = await geminiRes.json().catch(() => ({}));
        const inlineAudio = geminiRes.ok ? extractInlineAudio(geminiData) : null;
        if (inlineAudio?.buffer?.length) {
          const mime = String(inlineAudio.mimeType || "").toLowerCase();
          const outBuffer = mime.includes("audio/l16") || mime.includes("audio/pcm")
            ? pcm16leToWav({ pcmBuffer: inlineAudio.buffer, sampleRate: 24000, channels: 1 })
            : inlineAudio.buffer;
          const outMimeType = mime.includes("audio/l16") || mime.includes("audio/pcm")
            ? "audio/wav"
            : (inlineAudio.mimeType || "audio/wav");
          await updateUsage({ provider: "tts:gemini_25_flash_preview", chars: text.length });
          await writeCachedAudio({ key: cacheKey, buffer: outBuffer, mimeType: outMimeType });
          return {
            buffer: outBuffer,
            provider: "tts:gemini_25_flash_preview",
            mimeType: outMimeType,
          };
        }
      } catch {
        // Continue to Cloud/fallback path.
      }
    }

    if (ttsGoogleCloudEnabled && googleProviderEnabled && (cloudApiKey || hasGoogleServiceAccount())) {
      try {
        const useKey = !!cloudApiKey;
        const accessToken = useKey ? "" : await getGoogleAccessToken();
        const endpoint = useKey
          ? `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(cloudApiKey)}`
          : "https://texttospeech.googleapis.com/v1/text:synthesize";
        const cloudRes = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode, ssmlGender: "FEMALE" },
            audioConfig: { audioEncoding: "MP3", speakingRate },
          }),
        });
          const cloudData = await cloudRes.json().catch(() => ({}));
          if (cloudRes.ok && cloudData?.audioContent) {
            const audioBuffer = Buffer.from(String(cloudData.audioContent), "base64");
            await updateUsage({ provider: "tts:google_cloud", chars: text.length });
          await writeCachedAudio({ key: cacheKey, buffer: audioBuffer, mimeType: "audio/mpeg" });
          return { buffer: audioBuffer, provider: "tts:google_cloud", mimeType: "audio/mpeg" };
        }
      } catch {
        // Continue to fallback endpoint.
      }
    }

    if (!ttsGoogleFallbackEnabled || !googleProviderEnabled) {
      throw new Error("No enabled TTS provider available.");
    }
    const tl = toGoogleTranslateTtsLang(lang);
    const fallbackUrl = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(tl)}&q=${encodeURIComponent(text)}`;
    const fallbackRes = await fetch(fallbackUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!fallbackRes.ok) throw new Error("Google TTS fallback failed.");
    const arr = await fallbackRes.arrayBuffer();
    const fallbackBuffer = Buffer.from(arr);
    await updateUsage({ provider: "tts:google_fallback", chars: text.length });
    await writeCachedAudio({ key: cacheKey, buffer: fallbackBuffer, mimeType: "audio/mpeg" });
    return { buffer: fallbackBuffer, provider: "tts:google_fallback", mimeType: "audio/mpeg" };
  })();

  ttsInFlight.set(cacheKey, generator);
  try {
    const generated = await generator;
    res.set("Content-Type", generated.mimeType || "audio/mpeg");
    res.set("Cache-Control", "public, max-age=604800, stale-while-revalidate=86400");
    res.set("X-TTS-Cache", "MISS");
    return res.send(generated.buffer);
  } catch {
    return res.status(502).json({ message: "TTS provider unavailable." });
  } finally {
    ttsInFlight.delete(cacheKey);
  }
});

module.exports = router;
