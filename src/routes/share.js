const express = require("express");
const mongoose = require("mongoose");
const Item = require("../models/Item");
const Category = require("../models/Category");
const BlogPost = require("../models/BlogPost");

const router = express.Router();
const BOT_UA_RE =
  /(facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|discordbot|googlebot|bingbot)/i;
const FB_APP_ID = String(process.env.FB_APP_ID || "939774335893836").trim();
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
  return "image/jpeg";
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

router.get("/item/:itemId", async (req, res) => {
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
  const descriptionParts = [
    toText && toText !== "-" ? `${fromText} means ${toText}` : "",
    categoryLabel ? `Category: ${categoryLabel}` : "",
    String(item.description || "").trim(),
  ].filter(Boolean);
  const description = descriptionParts.join(" - ") || "Learn words with pictures, translation, and voice support.";
  const webBase = frontEndBase(req);
  const imageUrl = absoluteImageUrl(req, item.imageUrl || item.imageThumbUrl);
  const fallbackImage = String(process.env.SHARE_FALLBACK_IMAGE || "").trim()
    || `${webBase}/apple-touch-icon.png`;
  const ogImage = imageUrl || fallbackImage;

  const appUrlParams = new URLSearchParams();
  if (resolvedCategoryId && mongoose.Types.ObjectId.isValid(resolvedCategoryId)) {
    appUrlParams.set("categoryId", resolvedCategoryId);
  }
  appUrlParams.set("itemId", itemId);
  appUrlParams.set("from", from);
  appUrlParams.set("to", to);
  const appUrl = `${webBase}/dictionary?${appUrlParams.toString()}`;
  const canonicalShareUrl = `${requestPublicBase(req)}/share/item/${encodeURIComponent(itemId)}?categoryId=${encodeURIComponent(resolvedCategoryId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

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
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    ${FB_APP_ID ? `<meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}" />` : ""}
    ${FB_PAGE_URL ? `<meta property="article:publisher" content="${escapeHtml(FB_PAGE_URL)}" />` : ""}
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:type" content="image/jpeg" />
    <meta property="og:image:alt" content="${escapeHtml(title)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImage)}" />
    <meta name="twitter:image:src" content="${escapeHtml(ogImage)}" />
  </head>
  <body>
    <p>Redirecting to <a href="${escapeHtml(appUrl)}">item details</a>...</p>
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
  const title = String(post.title || "Picture Dictionary Blog").trim();
  const description =
    stripText(post.excerpt).slice(0, 280) ||
    stripText(post.content).slice(0, 280) ||
    "Read education, language, health, and learning articles from Picture Dictionary.";
  const imageUrl = absoluteImageUrl(req, post.coverImageUrl);
  const fallbackImage = String(process.env.SHARE_FALLBACK_IMAGE || "").trim()
    || `${webBase}/apple-touch-icon.png`;
  const ogImage = imageUrl || fallbackImage;
  const appUrl = `${webBase}/blog/${encodeURIComponent(slug)}`;
  const canonicalShareUrl = `${requestPublicBase(req)}/share/blog/${encodeURIComponent(slug)}`;
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
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    ${FB_APP_ID ? `<meta property="fb:app_id" content="${escapeHtml(FB_APP_ID)}" />` : ""}
    ${FB_PAGE_URL ? `<meta property="article:publisher" content="${escapeHtml(FB_PAGE_URL)}" />` : ""}
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalShareUrl)}" />
    <meta property="og:image" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:secure_url" content="${escapeHtml(ogImage)}" />
    <meta property="og:image:type" content="${escapeHtml(imageTypeFromUrl(ogImage))}" />
    <meta property="og:image:alt" content="${escapeHtml(post.coverImageAlt || title)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
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
