const express = require("express");
const http = require("http");
const https = require("https");
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
  const ogImage = imageUrl || fallbackImage;
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
  const canonicalShareUrl = `${requestPublicBase(req)}/share/item/${encodeURIComponent(itemId)}?categoryId=${encodeURIComponent(resolvedCategoryId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

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
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      ${ogImage ? `<img src="${escapeHtml(ogImage)}" alt="${escapeHtml(title)}" />` : ""}
      <p><strong>Category:</strong> ${escapeHtml(categoryLabel || "Vocabulary")}</p>
      <p><strong>Definition:</strong> ${escapeHtml(String(item.description || "No description yet.").trim())}</p>
      ${categoryExplanation ? `<p><strong>Category explanation:</strong> ${escapeHtml(categoryExplanation)}</p>` : ""}
      ${examples.length ? `<section><h2>Examples</h2><ul>${examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul></section>` : ""}
      ${funFact ? `<p><strong>Fun fact:</strong> ${escapeHtml(funFact)}</p>` : ""}
      ${relatedWords.length ? `<section><h2>Related words</h2><ul>${relatedWords.map((word) => `<li>${escapeHtml(word)}</li>`).join("")}</ul></section>` : ""}
      <p>Open the interactive page: <a href="${escapeHtml(appUrl)}">item details</a>.</p>
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
