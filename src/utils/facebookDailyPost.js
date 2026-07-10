const mongoose = require("mongoose");
const Item = require("../models/Item");
const Category = require("../models/Category");
const FacebookPost = require("../models/FacebookPost");
const FacebookSettings = require("../models/FacebookSettings");

const DEFAULT_POST_TIME = "08:00";
const DEFAULT_TIME_ZONE = "Asia/Phnom_Penh";
const GRAPH_BASE = "https://graph.facebook.com/v20.0";
const MAX_CAPTION_LENGTH = 5000;

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

const localDateKey = (date = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
};

const localTimeParts = (date = new Date(), timeZone = DEFAULT_TIME_ZONE) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(date);
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
  const timeZone = settings.timeZone || DEFAULT_TIME_ZONE;
  const target = parsePostTime(settings.postTime || DEFAULT_POST_TIME);
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

const getFacebookSettings = async () => {
  let doc = await FacebookSettings.findOne();
  if (!doc) {
    doc = await FacebookSettings.create({
      pageId: process.env.FACEBOOK_PAGE_ID || "",
      pageAccessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "",
      publicApiBaseUrl: process.env.PUBLIC_API_BASE_URL || process.env.API_BASE_URL || process.env.BACKEND_URL || "https://api.picturedictionary.cloud",
      postsPerDay: Number(process.env.FACEBOOK_POSTS_PER_DAY || 1) || 1,
      isEnabled: String(process.env.FACEBOOK_DAILY_POST_ENABLED || "true").toLowerCase() !== "false",
      postTime: process.env.FACEBOOK_DAILY_POST_TIME || DEFAULT_POST_TIME,
      timeZone: process.env.FACEBOOK_DAILY_POST_TIME_ZONE || DEFAULT_TIME_ZONE,
      fromLang: process.env.FACEBOOK_POST_FROM_LANG || "en",
      toLang: process.env.FACEBOOK_POST_TO_LANG || "kh",
    });
  }
  return doc;
};

const publicFacebookSettings = (doc) => ({
  id: String(doc?._id || ""),
  pageId: doc?.pageId || "",
  publicApiBaseUrl: doc?.publicApiBaseUrl || "",
  postsPerDay: Number(doc?.postsPerDay || 1),
  isEnabled: doc?.isEnabled !== false,
  postTime: doc?.postTime || DEFAULT_POST_TIME,
  timeZone: doc?.timeZone || DEFAULT_TIME_ZONE,
  fromLang: doc?.fromLang || "en",
  toLang: doc?.toLang || "kh",
  hasPageAccessToken: !!doc?.pageAccessToken,
  pageAccessTokenMasked: maskToken(doc?.pageAccessToken || ""),
  updatedAt: doc?.updatedAt || null,
});

const updateFacebookSettings = async (payload = {}) => {
  const current = await getFacebookSettings();
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(payload, "pageAccessToken")) {
    const next = String(payload.pageAccessToken || "").trim();
    if (next) patch.pageAccessToken = next;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "pageId")) patch.pageId = String(payload.pageId || "").trim();
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
    await rescheduleFacebookDailyPoster();
  }
  return current;
};

const enabledItemFilter = {
  $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }],
  imageUrl: { $exists: true, $ne: "" },
};

const selectDailyItem = async () => {
  const queuedIds = await FacebookPost.distinct("itemId", { status: { $in: ["pending", "published"] } });
  const usedIds = Array.from(new Set(queuedIds.map(String))).filter(mongoose.Types.ObjectId.isValid);
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
  const from = normalizeLang(settings.fromLang || process.env.FACEBOOK_POST_FROM_LANG || "en", "en");
  const to = normalizeLang(settings.toLang || process.env.FACEBOOK_POST_TO_LANG || "kh", "kh");
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
    item.description ? `Meaning: ${sentenceLimit(item.description, 240)}` : "",
    examples.length ? `Example: ${sentenceLimit(examples[0], 180)}` : "",
    funFact ? `Did you know? ${sentenceLimit(funFact, 180)}` : "",
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

const serializeFacebookPost = (post) => {
  const item = post?.itemId && typeof post.itemId === "object" ? post.itemId : null;
  const translations = item?.translations || {};
  return {
    id: String(post?._id || ""),
    itemId: item?._id ? String(item._id) : String(post?.itemId || ""),
    itemTitle: getLocalizedText(translations, "en") || getLocalizedText(translations, "kh") || "Picture Dictionary item",
    itemImageUrl: item?.imageThumbUrl || item?.imageUrl || "",
    scheduledDate: post?.scheduledDate || "",
    pageId: post?.pageId || "",
    caption: post?.caption || "",
    imageUrl: post?.imageUrl || "",
    shareUrl: post?.shareUrl || "",
    status: post?.status || "pending",
    facebookPostId: post?.facebookPostId || "",
    facebookPhotoId: post?.facebookPhotoId || "",
    messageId: post?.facebookPostId || post?.facebookPhotoId || "",
    error: post?.error || "",
    approvedAt: post?.approvedAt || null,
    publishedAt: post?.publishedAt || null,
    createdAt: post?.createdAt || null,
    updatedAt: post?.updatedAt || null,
  };
};

const createPendingFacebookPosts = async ({ count, scheduledDate } = {}) => {
  const settings = await getFacebookSettings();
  const postDate = scheduledDate || localDateKey(new Date(), settings.timeZone || DEFAULT_TIME_ZONE);
  const limit = Math.min(Math.max(Number(count || settings.postsPerDay || 1), 1), 20);
  const existingCount = await FacebookPost.countDocuments({ scheduledDate: postDate, status: { $in: ["pending", "published"] } });
  const needed = Math.max(limit - existingCount, 0);
  const created = [];

  for (let i = 0; i < needed; i += 1) {
    const item = await selectDailyItem();
    if (!item) break;
    const content = await buildPostContent(item, settings);
    const post = await FacebookPost.create({
      itemId: item._id,
      scheduledDate: postDate,
      pageId: settings.pageId || process.env.FACEBOOK_PAGE_ID || "",
      caption: content.caption,
      imageUrl: content.imageUrl,
      shareUrl: content.shareUrl,
      status: "pending",
    });
    created.push(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  }

  return { created: created.map(serializeFacebookPost), createdCount: created.length, scheduledDate: postDate, requestedCount: limit };
};

const facebookRequest = async (path, payload = {}, settings = {}, method = "POST") => {
  const token = settings.pageAccessToken || process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
  if (!token) throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN is not configured");
  const url = new URL(`${GRAPH_BASE}/${String(path || "").replace(/^\/+/, "")}`);
  url.searchParams.set("access_token", token);
  const options = { method };
  if (method !== "GET" && method !== "DELETE") {
    const body = new URLSearchParams();
    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) body.set(key, String(value));
    });
    options.headers = { "Content-Type": "application/x-www-form-urlencoded" };
    options.body = body.toString();
  } else {
    Object.entries(payload || {}).forEach(([key, value]) => {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    });
  }
  const response = await fetch(url.toString(), options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) {
    const error = new Error(data?.error?.message || `Facebook Graph API failed with ${response.status}`);
    error.statusCode = response.status;
    error.facebookError = data?.error || null;
    throw error;
  }
  return data;
};

const publishFacebookPost = async (postId, ownerId = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(postId || ""))) throw new Error("Invalid Facebook post id");
  const settings = await getFacebookSettings();
  const post = await FacebookPost.findById(postId);
  if (!post) throw new Error("Facebook post not found");
  if (post.status === "published") return serializeFacebookPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  if (post.status !== "pending" && post.status !== "failed") throw new Error("Only pending or failed posts can be published");
  const pageId = String(settings.pageId || post.pageId || process.env.FACEBOOK_PAGE_ID || "").trim();
  if (!pageId) throw new Error("FACEBOOK_PAGE_ID is not configured");

  try {
    const result = await facebookRequest(`${encodeURIComponent(pageId)}/photos`, {
      url: post.imageUrl,
      caption: post.caption,
      published: "true",
    }, settings);
    post.status = "published";
    post.pageId = pageId;
    post.facebookPhotoId = String(result?.id || "");
    post.facebookPostId = String(result?.post_id || result?.id || "");
    post.error = "";
    post.approvedBy = ownerId || null;
    post.approvedAt = new Date();
    post.publishedAt = new Date();
    await post.save();
    return serializeFacebookPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  } catch (error) {
    post.status = "failed";
    post.error = String(error?.message || error).slice(0, 500);
    await post.save();
    throw error;
  }
};

const deletePublishedFacebookPost = async (postId) => {
  if (!mongoose.Types.ObjectId.isValid(String(postId || ""))) throw new Error("Invalid Facebook post id");
  const settings = await getFacebookSettings();
  const post = await FacebookPost.findById(postId);
  if (!post) throw new Error("Facebook post not found");
  if (post.status !== "published") throw new Error("Only published Facebook posts can be deleted");
  const graphId = String(post.facebookPostId || post.facebookPhotoId || "").trim();
  if (!graphId) throw new Error("Facebook post id is missing for this post");

  const markDeleted = async (note = "Deleted from Facebook by owner") => {
    post.status = "deleted";
    post.error = note;
    await post.save();
    return serializeFacebookPost(await post.populate("itemId", "translations imageUrl imageThumbUrl"));
  };

  try {
    await facebookRequest(encodeURIComponent(graphId), {}, settings, "DELETE");
  } catch (error) {
    const message = String(error?.message || "").toLowerCase();
    if (message.includes("does not exist") || message.includes("unsupported delete request") || message.includes("cannot be loaded")) {
      return markDeleted("Facebook post was already missing; local record cleaned up by owner");
    }
    error.statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 400;
    throw error;
  }

  return markDeleted();
};

const clearSchedule = () => {
  if (timer) clearTimeout(timer);
  timer = null;
};

const scheduleNextRun = async (settingsArg = null) => {
  clearSchedule();
  const settings = settingsArg || await getFacebookSettings();
  const delay = Math.max(60_000, minutesUntilNextRun(settings) * 60_000);
  timer = setTimeout(async () => {
    try {
      const latest = await getFacebookSettings();
      if (latest.isEnabled !== false) {
        const result = await createPendingFacebookPosts({ count: latest.postsPerDay });
        console.log(`[facebook] pending posts ready: ${result.createdCount}/${result.requestedCount}`);
      } else {
        console.log("[facebook] daily poster disabled");
      }
    } catch (error) {
      console.error("[facebook] pending post generation failed", error);
    } finally {
      if (schedulerStarted) scheduleNextRun();
    }
  }, delay);
  if (typeof timer.unref === "function") timer.unref();
};

const rescheduleFacebookDailyPoster = async () => {
  const settings = await getFacebookSettings();
  if (settings.isEnabled === false) {
    clearSchedule();
    console.log("[facebook] daily poster disabled");
    return { scheduled: false, reason: "disabled" };
  }
  await scheduleNextRun(settings);
  console.log(`[facebook] pending-post generator scheduled for ${settings.postTime || DEFAULT_POST_TIME} ${settings.timeZone || DEFAULT_TIME_ZONE}`);
  return { scheduled: true, postTime: settings.postTime || DEFAULT_POST_TIME, timeZone: settings.timeZone || DEFAULT_TIME_ZONE };
};

const startFacebookDailyPoster = async () => {
  schedulerStarted = true;
  return rescheduleFacebookDailyPoster();
};

module.exports = {
  buildPostContent,
  createPendingFacebookPosts,
  deletePublishedFacebookPost,
  getFacebookSettings,
  publishFacebookPost,
  publicFacebookSettings,
  serializeFacebookPost,
  rescheduleFacebookDailyPoster,
  startFacebookDailyPoster,
  updateFacebookSettings,
};
