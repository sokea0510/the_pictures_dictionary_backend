const mongoose = require("mongoose");
const Item = require("../models/Item");
const Category = require("../models/Category");
const TelegramPost = require("../models/TelegramPost");
const TelegramPostLog = require("../models/TelegramPostLog");
const TelegramSettings = require("../models/TelegramSettings");

const DEFAULT_POST_TIME = "08:00";
const DEFAULT_TIME_ZONE = "Asia/Phnom_Penh";
const MAX_CAPTION_LENGTH = 1024;

let timer = null;
let schedulerStarted = false;

const normalizeLang = (value, fallback = "en") => {
  const raw = String(value || fallback || "").trim().toLowerCase().split(/[-_]/)[0];
  if (["km", "khmer"].includes(raw)) return "kh";
  if (["ko", "korean"].includes(raw)) return "kr";
  return raw || fallback;
};

const getMapValue = (map, code) => {
  if (!map) return "";
  if (typeof map.get === "function") return map.get(code) || "";
  return map[code] || "";
};

const getLocalizedText = (map, lang, fallbackLang = "en") => {
  const code = normalizeLang(lang, fallbackLang);
  const aliases =
    code === "kh" ? ["km", "khmer"] :
    code === "kr" ? ["ko", "korean"] :
    code === "en" ? ["eng", "english"] :
    [];
  return (
    getMapValue(map, code) ||
    aliases.map((alias) => getMapValue(map, alias)).find(Boolean) ||
    getMapValue(map, fallbackLang) ||
    getMapValue(map, "en") ||
    ""
  );
};

const getLocalizedList = (map, lang, maxItems = 2) => {
  const raw = getLocalizedText(map, lang, "");
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/\n|,/);
  return list.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, maxItems);
};

const stripText = (value) => String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const truncate = (value, max) => {
  const text = stripText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
};

const cleanLearningText = (value) => stripText(value).replace(/^\s*\d+[.)-]?\s*/, "").trim();

const sentenceLimit = (value, max) => {
  const text = cleanLearningText(value);
  if (!text || text.length <= max) return text;
  const slice = text.slice(0, max + 1);
  const sentenceEnd = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  if (sentenceEnd >= Math.floor(max * 0.45)) return slice.slice(0, sentenceEnd + 1).trim();
  const wordEnd = slice.lastIndexOf(" ");
  const end = wordEnd >= Math.floor(max * 0.45) ? wordEnd : max;
  return `${slice.slice(0, end).trim()}...`;
};

const languageLabel = (code) => {
  const normalized = normalizeLang(code, "en");
  if (normalized === "kh") return "Khmer";
  if (normalized === "kr") return "Korean";
  if (normalized === "en") return "English";
  return normalized.toUpperCase();
};

const hashtagify = (value) => {
  const text = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim();
  if (!text) return "";
  const tag = text.split(/\s+/).map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join("");
  return tag ? `#${tag}` : "";
};

const uniqueHashtags = (tags = []) => Array.from(new Set(tags.filter(Boolean))).slice(0, 12).join(" ");


const slugify = (value, fallback = "word") =>
  String(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;

const cleanUrl = (value) => String(value || "").trim().replace(/\/+$/, "");

const publicApiBase = (settings = {}) => {
  const explicit = settings.publicApiBaseUrl || process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || process.env.BACKEND_URL || "";
  if (explicit) return cleanUrl(explicit);
  const frontend = process.env.FRONTEND_URL || process.env.APP_BASE_URL || "";
  if (frontend) return cleanUrl(frontend);
  return "https://picturedictionary.cloud";
};

const localDateKey = (date = new Date(), timeZone = process.env.TELEGRAM_DAILY_POST_TIME_ZONE || DEFAULT_TIME_ZONE) => {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

const localTimeParts = (date = new Date(), timeZone = process.env.TELEGRAM_DAILY_POST_TIME_ZONE || DEFAULT_TIME_ZONE) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date);
    return {
      hour: Number(parts.find((part) => part.type === "hour")?.value || 0),
      minute: Number(parts.find((part) => part.type === "minute")?.value || 0),
    };
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
};

const parsePostTime = (value = "") => {
  const match = String(value || DEFAULT_POST_TIME).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 8, minute: 0 };
  return {
    hour: Math.min(Math.max(Number(match[1]) || 0, 0), 23),
    minute: Math.min(Math.max(Number(match[2]) || 0, 0), 59),
  };
};

const minutesUntilNextRun = (settings = {}) => {
  const timeZone = settings.timeZone || process.env.TELEGRAM_DAILY_POST_TIME_ZONE || DEFAULT_TIME_ZONE;
  const target = parsePostTime(settings.postTime || process.env.TELEGRAM_DAILY_POST_TIME || DEFAULT_POST_TIME);
  const now = new Date();
  const current = localTimeParts(now, timeZone);
  const currentMinutes = current.hour * 60 + current.minute;
  const targetMinutes = target.hour * 60 + target.minute;
  let delta = targetMinutes - currentMinutes;
  if (delta <= 0) delta += 24 * 60;
  return delta;
};

const maskToken = (token = "") => {
  const value = String(token || "").trim();
  if (!value) return "";
  if (value.length <= 10) return "••••";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const getTelegramSettings = async () => {
  let doc = await TelegramSettings.findOne();
  if (!doc) {
    doc = await TelegramSettings.create({
      botToken: process.env.TELEGRAM_BOT_TOKEN || "",
      channelId: process.env.TELEGRAM_CHANNEL_ID || "",
      publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || process.env.BACKEND_URL || "https://api.picturedictionary.cloud",
      postsPerDay: Number(process.env.TELEGRAM_POSTS_PER_DAY || 1) || 1,
      isEnabled: String(process.env.TELEGRAM_DAILY_POST_ENABLED || "true").toLowerCase() !== "false",
      postTime: process.env.TELEGRAM_DAILY_POST_TIME || DEFAULT_POST_TIME,
      timeZone: process.env.TELEGRAM_DAILY_POST_TIME_ZONE || DEFAULT_TIME_ZONE,
      fromLang: process.env.TELEGRAM_POST_FROM_LANG || "en",
      toLang: process.env.TELEGRAM_POST_TO_LANG || "kh",
    });
  }
  return doc;
};

const publicTelegramSettings = (doc) => ({
  id: String(doc?._id || ""),
  channelId: doc?.channelId || "",
  publicApiBaseUrl: doc?.publicApiBaseUrl || "",
  postsPerDay: Number(doc?.postsPerDay || 1),
  isEnabled: doc?.isEnabled !== false,
  postTime: doc?.postTime || DEFAULT_POST_TIME,
  timeZone: doc?.timeZone || DEFAULT_TIME_ZONE,
  fromLang: doc?.fromLang || "en",
  toLang: doc?.toLang || "kh",
  hasBotToken: !!doc?.botToken,
  botTokenMasked: maskToken(doc?.botToken || ""),
  updatedAt: doc?.updatedAt || null,
});

const updateTelegramSettings = async (payload = {}) => {
  const current = await getTelegramSettings();
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(payload, "botToken")) {
    const next = String(payload.botToken || "").trim();
    if (next) patch.botToken = next;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "channelId")) patch.channelId = String(payload.channelId || "").trim();
  if (Object.prototype.hasOwnProperty.call(payload, "publicApiBaseUrl")) patch.publicApiBaseUrl = cleanUrl(payload.publicApiBaseUrl || "");
  if (Object.prototype.hasOwnProperty.call(payload, "postsPerDay")) patch.postsPerDay = Math.min(Math.max(Number(payload.postsPerDay) || 1, 1), 20);
  if (Object.prototype.hasOwnProperty.call(payload, "isEnabled")) patch.isEnabled = payload.isEnabled !== false;
  if (Object.prototype.hasOwnProperty.call(payload, "postTime")) patch.postTime = String(payload.postTime || DEFAULT_POST_TIME).trim();
  if (Object.prototype.hasOwnProperty.call(payload, "timeZone")) patch.timeZone = String(payload.timeZone || DEFAULT_TIME_ZONE).trim();
  if (Object.prototype.hasOwnProperty.call(payload, "fromLang")) patch.fromLang = normalizeLang(payload.fromLang, "en");
  if (Object.prototype.hasOwnProperty.call(payload, "toLang")) patch.toLang = normalizeLang(payload.toLang, "kh");
  Object.assign(current, patch);
  await current.save();
  if (schedulerStarted) {
    await rescheduleTelegramDailyPoster();
  }
  return current;
};

const enabledItemFilter = {
  $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  imageUrl: { $exists: true, $ne: "" },
};

const selectDailyItem = async () => {
  const queuedIds = await TelegramPost.distinct("itemId", { status: { $in: ["pending", "published"] } });
  const loggedIds = await TelegramPostLog.distinct("itemId", { status: "sent" });
  const usedIds = Array.from(new Set([...queuedIds, ...loggedIds].map(String))).filter(mongoose.Types.ObjectId.isValid);
  const baseFilter = { ...enabledItemFilter };
  if (usedIds.length) baseFilter._id = { $nin: usedIds };

  let count = await Item.countDocuments(baseFilter);
  let filter = baseFilter;
  if (!count) {
    filter = enabledItemFilter;
    count = await Item.countDocuments(filter);
  }
  if (!count) return null;

  const offset = Math.floor(Math.random() * count);
  return Item.findOne(filter).sort({ updatedAt: -1, createdAt: -1 }).skip(offset).lean();
};

const buildPostContent = async (item, settings = {}) => {
  const from = normalizeLang(settings.fromLang || process.env.TELEGRAM_POST_FROM_LANG || "en", "en");
  const to = normalizeLang(settings.toLang || process.env.TELEGRAM_POST_TO_LANG || "kh", "kh");
  const sourceWord = getLocalizedText(item.translations, from) || getLocalizedText(item.translations, "en") || "Picture Dictionary";
  const targetWord = getLocalizedText(item.translations, to);
  const englishWord = getLocalizedText(item.translations, "en") || sourceWord || targetWord || "Picture Dictionary";
  const fromPronunciation = getLocalizedText(item.phoneticPronunciations, from);
  const toPronunciation = getLocalizedText(item.phoneticPronunciations, to);
  const examples = getLocalizedList(item.examples, to, 2).length
    ? getLocalizedList(item.examples, to, 2)
    : (getLocalizedList(item.examples, from, 2).length ? getLocalizedList(item.examples, from, 2) : getLocalizedList(item.examples, "en", 2));
  const funFact = getLocalizedText(item.funFacts, to) || getLocalizedText(item.funFacts, from) || getLocalizedText(item.funFacts, "en");
  const category = mongoose.Types.ObjectId.isValid(String(item.categoryId || ""))
    ? await Category.findById(item.categoryId).select("label").lean()
    : null;
  const categoryLabel = String(category?.label || "Vocabulary").trim();
  const itemSlug = slugify(englishWord || sourceWord || targetWord || "word");
  const apiBase = publicApiBase(settings);
  const params = new URLSearchParams({ from, to });
  const shareUrl = `${apiBase}/share/item/${encodeURIComponent(String(item._id))}/${encodeURIComponent(itemSlug)}?${params.toString()}`;
  const imageUrl = `${apiBase}/share/item/${encodeURIComponent(String(item._id))}/image?v=${encodeURIComponent(new Date(item.updatedAt || item.createdAt || Date.now()).getTime())}`;
  const languagePairTag = `#${languageLabel(from)}To${languageLabel(to)}`;
  const hashtags = uniqueHashtags([
    "#PictureDictionary",
    "#WordOfTheDay",
    "#LearnVocabulary",
    "#LanguageLearning",
    hashtagify(englishWord),
    hashtagify(categoryLabel),
    categoryLabel.toLowerCase() === "vocabulary" ? "" : hashtagify(`${categoryLabel} vocabulary`),
    `#Learn${languageLabel(from)}`,
    `#Learn${languageLabel(to)}`,
    languagePairTag,
    "#LearnEnglish",
    "#Vocabulary",
  ]);

  const wordLines = [
    `- ${languageLabel(from)}: ${sourceWord}${fromPronunciation ? ` (${fromPronunciation})` : ""}`,
    targetWord ? `- ${languageLabel(to)}: ${targetWord}${toPronunciation && toPronunciation !== fromPronunciation ? ` (${toPronunciation})` : ""}` : "",
    englishWord && englishWord !== sourceWord && englishWord !== targetWord ? `- English: ${englishWord}` : "",
  ].filter(Boolean);

  const lines = [
    "Picture Dictionary word of the day",
    `Learn this word in ${languageLabel(from)} and ${languageLabel(to)}:`,
    "",
    ...wordLines,
    "",
    `Category: ${categoryLabel}`,
    item.description ? `Meaning: ${sentenceLimit(item.description, 145)}` : "",
    examples.length ? `Example: ${sentenceLimit(examples[0], 135)}` : "",
    funFact ? `Did you know? ${sentenceLimit(funFact, 135)}` : "",
    "",
    "Practice with picture, sound, examples, and related words:",
    shareUrl,
    "",
    "Try it: write one sentence with this word in the comments.",
    "Save this post for daily vocabulary practice.",
    "",
    hashtags,
  ].filter((line) => line !== "");

  let caption = lines.join("\n");
  if (caption.length > MAX_CAPTION_LENGTH) {
    const reserved = `\n\nPractice here:\n${shareUrl}\n\n${hashtags}`;
    caption = `${caption.slice(0, MAX_CAPTION_LENGTH - reserved.length - 3).trim()}...${reserved}`;
  }

  return { caption, imageUrl, shareUrl };
};

const serializeTelegramPost = (post) => {
  const item = post?.itemId && typeof post.itemId === "object" ? post.itemId : null;
  const translations = item?.translations || {};
  return {
    id: String(post?._id || ""),
    itemId: item?._id ? String(item._id) : String(post?.itemId || ""),
    itemTitle: getLocalizedText(translations, "en") || getLocalizedText(translations, "kh") || "Picture Dictionary item",
    itemImageUrl: item?.imageThumbUrl || item?.imageUrl || "",
    scheduledDate: post?.scheduledDate || "",
    channelId: post?.channelId || "",
    caption: post?.caption || "",
    imageUrl: post?.imageUrl || "",
    shareUrl: post?.shareUrl || "",
    status: post?.status || "pending",
    messageId: post?.messageId || null,
    error: post?.error || "",
    approvedAt: post?.approvedAt || null,
    publishedAt: post?.publishedAt || null,
    createdAt: post?.createdAt || null,
    updatedAt: post?.updatedAt || null,
  };
};

const createPendingTelegramPosts = async ({ count, scheduledDate } = {}) => {
  const settings = await getTelegramSettings();
  const postDate = scheduledDate || localDateKey(new Date(), settings.timeZone || DEFAULT_TIME_ZONE);
  const limit = Math.min(Math.max(Number(count || settings.postsPerDay || 1), 1), 20);
  const existingCount = await TelegramPost.countDocuments({ scheduledDate: postDate, status: { $in: ["pending", "published"] } });
  const needed = Math.max(limit - existingCount, 0);
  const created = [];

  for (let i = 0; i < needed; i += 1) {
    const item = await selectDailyItem();
    if (!item) break;
    const content = await buildPostContent(item, settings);
    const post = await TelegramPost.create({
      itemId: item._id,
      scheduledDate: postDate,
      channelId: settings.channelId || process.env.TELEGRAM_CHANNEL_ID || "",
      caption: content.caption,
      imageUrl: content.imageUrl,
      shareUrl: content.shareUrl,
      status: "pending",
    });
    created.push(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  }

  return { created: created.map(serializeTelegramPost), createdCount: created.length, scheduledDate: postDate, requestedCount: limit };
};

const telegramRequest = async (method, payload, settings = {}) => {
  const token = settings.botToken || process.env.TELEGRAM_BOT_TOKEN || "";
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    const error = new Error(data?.description || `Telegram ${method} failed with ${response.status}`);
    error.statusCode = response.status;
    error.telegramDescription = data?.description || "";
    throw error;
  }
  return data.result;
};

const publishTelegramPost = async (postId, ownerId = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(postId || ""))) throw new Error("Invalid Telegram post id");
  const settings = await getTelegramSettings();
  const post = await TelegramPost.findById(postId);
  if (!post) throw new Error("Telegram post not found");
  if (post.status === "published") return serializeTelegramPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  if (post.status !== "pending" && post.status !== "failed") throw new Error("Only pending or failed posts can be published");
  const channelId = String(settings.channelId || post.channelId || process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!channelId) throw new Error("TELEGRAM_CHANNEL_ID is not configured");

  try {
    const result = await telegramRequest("sendPhoto", {
      chat_id: channelId,
      photo: post.imageUrl,
      caption: post.caption,
      disable_notification: false,
    }, settings);
    post.status = "published";
    post.channelId = channelId;
    post.messageId = Number(result?.message_id || 0) || null;
    post.error = "";
    post.approvedBy = ownerId || null;
    post.approvedAt = new Date();
    post.publishedAt = new Date();
    await post.save();

    await TelegramPostLog.findOneAndUpdate(
      { postDate: post.scheduledDate, channelId },
      {
        $set: {
          postDate: post.scheduledDate,
          channelId,
          itemId: post.itemId,
          messageId: post.messageId,
          caption: post.caption,
          status: "sent",
          error: "",
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    return serializeTelegramPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  } catch (error) {
    post.status = "failed";
    post.error = String(error?.message || error).slice(0, 500);
    await post.save();
    throw error;
  }
};

const deletePublishedTelegramPost = async (postId) => {
  if (!mongoose.Types.ObjectId.isValid(String(postId || ""))) throw new Error("Invalid Telegram post id");
  const settings = await getTelegramSettings();
  const post = await TelegramPost.findById(postId);
  if (!post) throw new Error("Telegram post not found");
  if (post.status !== "published") throw new Error("Only published Telegram posts can be deleted");
  const channelId = String(post.channelId || settings.channelId || process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!channelId) throw new Error("TELEGRAM_CHANNEL_ID is not configured");
  if (!post.messageId) throw new Error("Telegram message id is missing for this post");

  const markDeleted = async (note = "Deleted from Telegram by owner") => {
    post.status = "deleted";
    post.error = note;
    await post.save();
    await TelegramPostLog.findOneAndUpdate(
      { postDate: post.scheduledDate, channelId, messageId: post.messageId },
      { $set: { status: "failed", error: note } },
      { new: true }
    );
    return serializeTelegramPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  };

  try {
    await telegramRequest("deleteMessage", {
      chat_id: channelId,
      message_id: post.messageId,
    }, settings);
  } catch (error) {
    const message = String(error?.telegramDescription || error?.message || "").toLowerCase();
    if (message.includes("message to delete not found") || message.includes("message_id_invalid") || message.includes("message not found")) {
      return markDeleted("Message was already missing on Telegram; local record cleaned up by owner");
    }
    error.statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;
    throw error;
  }

  return markDeleted();
};

const postDailyTelegramItem = async ({ force = false } = {}) => {
  const settings = await getTelegramSettings();
  const channelId = String(settings.channelId || process.env.TELEGRAM_CHANNEL_ID || "").trim();
  if (!channelId) return { skipped: true, reason: "TELEGRAM_CHANNEL_ID is not configured" };

  const postDate = localDateKey(new Date(), settings.timeZone || DEFAULT_TIME_ZONE);
  if (!force) {
    const existing = await TelegramPostLog.findOne({ postDate, channelId, status: "sent" }).lean();
    if (existing) return { skipped: true, reason: "Daily Telegram post already sent", log: existing };
  }

  const pending = await createPendingTelegramPosts({ count: 1, scheduledDate: postDate });
  const post = pending.created[0] || await TelegramPost.findOne({ scheduledDate: postDate, status: { $in: ["pending", "failed"] } }).sort({ createdAt: 1 }).lean();
  if (!post) return { skipped: true, reason: "No pending Telegram post is available" };
  const published = await publishTelegramPost(post.id || post._id);
  return { sent: true, itemId: published.itemId, messageId: published.messageId, shareUrl: published.shareUrl };
};

const clearSchedule = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

const scheduleNextRun = async (settingsArg = null) => {
  clearSchedule();
  const settings = settingsArg || await getTelegramSettings();
  const delay = Math.max(60_000, minutesUntilNextRun(settings) * 60_000);
  timer = setTimeout(async () => {
    try {
      const latest = await getTelegramSettings();
      if (latest.isEnabled !== false) {
        const result = await createPendingTelegramPosts({ count: latest.postsPerDay });
        console.log(`[telegram] pending posts ready: ${result.createdCount}/${result.requestedCount}`);
      } else {
        console.log("[telegram] daily poster disabled");
      }
    } catch (error) {
      console.error("[telegram] pending post generation failed", error);
    } finally {
      if (schedulerStarted) scheduleNextRun();
    }
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
};

const rescheduleTelegramDailyPoster = async () => {
  const settings = await getTelegramSettings();
  if (settings.isEnabled === false) {
    clearSchedule();
    console.log("[telegram] daily poster disabled");
    return { scheduled: false, reason: "disabled" };
  }
  await scheduleNextRun(settings);
  console.log(`[telegram] pending-post generator scheduled for ${settings.postTime || DEFAULT_POST_TIME} ${settings.timeZone || DEFAULT_TIME_ZONE}`);
  return { scheduled: true, postTime: settings.postTime || DEFAULT_POST_TIME, timeZone: settings.timeZone || DEFAULT_TIME_ZONE };
};

const startTelegramDailyPoster = async () => {
  schedulerStarted = true;
  return rescheduleTelegramDailyPoster();
};

module.exports = {
  buildPostContent,
  createPendingTelegramPosts,
  deletePublishedTelegramPost,
  getTelegramSettings,
  postDailyTelegramItem,
  publishTelegramPost,
  publicTelegramSettings,
  serializeTelegramPost,
  rescheduleTelegramDailyPoster,
  startTelegramDailyPoster,
  updateTelegramSettings,
};
