const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const cacheDir = () => {
  const configured = String(process.env.TTS_CACHE_DIR || "").trim();
  if (configured) return configured;
  return path.resolve(process.cwd(), "var", "tts-cache");
};

const normalizeText = (value) => String(value || "").trim().replace(/\s+/g, " ");

const buildCacheKey = ({ text, lang, rate }) => {
  const payload = {
    v: 2,
    text: normalizeText(text),
    lang: String(lang || "").trim().toLowerCase(),
    rate: String(rate || "").trim(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
};

const filePathForKey = (key) => {
  const safeKey = String(key || "").replace(/[^a-f0-9]/gi, "");
  const shard = safeKey.slice(0, 2) || "00";
  return path.join(cacheDir(), shard, `${safeKey}.mp3`);
};
const metaPathForKey = (key) => {
  const safeKey = String(key || "").replace(/[^a-f0-9]/gi, "");
  const shard = safeKey.slice(0, 2) || "00";
  return path.join(cacheDir(), shard, `${safeKey}.json`);
};

const ensureParentDir = async (filepath) => {
  const dir = path.dirname(filepath);
  await fs.promises.mkdir(dir, { recursive: true });
};

const readCachedAudio = async (key) => {
  const filepath = filePathForKey(key);
  const metapath = metaPathForKey(key);
  try {
    const buffer = await fs.promises.readFile(filepath);
    let mimeType = "audio/mpeg";
    try {
      const raw = await fs.promises.readFile(metapath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed?.mimeType) mimeType = String(parsed.mimeType);
    } catch {}
    return { hit: true, buffer, path: filepath, mimeType };
  } catch {
    return { hit: false, buffer: null, path: filepath, mimeType: "audio/mpeg" };
  }
};

const writeCachedAudio = async ({ key, buffer, mimeType = "audio/mpeg" }) => {
  const filepath = filePathForKey(key);
  const metapath = metaPathForKey(key);
  await ensureParentDir(filepath);
  const tmpPath = `${filepath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tmpMetaPath = `${metapath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await fs.promises.writeFile(tmpPath, buffer);
  await fs.promises.writeFile(tmpMetaPath, JSON.stringify({ mimeType }, null, 0), "utf8");
  await fs.promises.rename(tmpPath, filepath);
  await fs.promises.rename(tmpMetaPath, metapath);
  return filepath;
};

module.exports = {
  buildCacheKey,
  readCachedAudio,
  writeCachedAudio,
};
