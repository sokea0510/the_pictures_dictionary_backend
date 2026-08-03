const express = require("express");
const mongoose = require("mongoose");
const Item = require("../models/Item");
const Category = require("../models/Category");

const router = express.Router();

const SITE_URL = String(process.env.FRONTEND_URL || process.env.APP_URL || "https://picturedictionary.cloud").replace(/\/+$/, "");
const BOT_UA_RE = /(adsbot-google|mediapartners-google|google-inspectiontool|googlebot|bingbot|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|telegrambot|whatsapp|discordbot)/i;

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

const slug = (value, fallback = "entry") =>
  String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;

const normalizeLang = (value, fallback = "en") => {
  const code = String(value || "").trim().toLowerCase();
  if (!code) return fallback;
  return code === "km" ? "kh" : code === "ko" ? "kr" : code;
};

const localizedValue = (map, lang) => {
  if (!map || typeof map !== "object") return "";
  const aliases = lang === "kh" ? ["kh", "km"] : lang === "kr" ? ["kr", "ko"] : [lang];
  for (const key of aliases) {
    const value = String(map[key] || "").trim();
    if (value && value !== "-") return value;
  }
  return "";
};

const firstTranslation = (item) =>
  localizedValue(item?.translations, "en") ||
  Object.values(item?.translations || {}).map((value) => String(value || "").trim()).find(Boolean) ||
  "Picture Dictionary";

const listValues = (map, lang, limit = 5) => {
  if (!map || typeof map !== "object") return [];
  const direct = map[lang];
  const fallback = map.en;
  const value = Array.isArray(direct) && direct.length ? direct : Array.isArray(fallback) ? fallback : [];
  return value.map((entry) => stripText(entry)).filter(Boolean).slice(0, limit);
};

const absoluteUrl = (req, value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${req.protocol}://${req.get("host")}${raw.startsWith("/") ? raw : `/${raw}`}`;
};

const renderPage = ({ lang, title, description, canonicalUrl, imageUrl, appUrl, categoryLabel, item, examples, relatedWords, categoryExplanation, funFact }) => `<!doctype html>
<html lang="${escapeHtml(lang || "en")}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Picture Dictionary" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
    ${imageUrl ? `<meta property="og:image" content="${escapeHtml(imageUrl)}" />` : ""}
    <style>
      body{margin:0;background:#f6f7fb;color:#172033;font-family:Inter,Arial,sans-serif;line-height:1.65}.wrap{max-width:940px;margin:0 auto;padding:24px}.card{background:#fff;border:1px solid #dfe7e3;border-radius:24px;padding:28px;box-shadow:0 18px 50px rgba(15,23,42,.08)}h1{font-size:clamp(30px,5vw,48px);line-height:1.1;margin:0 0 16px;color:#102a25}.meta{color:#52635f;font-weight:700}.hero{width:100%;max-height:520px;object-fit:contain;background:#f1f5f9;border-radius:18px;margin:20px 0}.section{margin-top:20px;padding:18px;border:1px solid #bdebd8;border-radius:16px;background:#effcf6}.section h2{margin:0 0 8px;color:#126c52}.cta{display:inline-block;margin-top:22px;padding:12px 18px;border-radius:999px;background:#087f5b;color:#fff;text-decoration:none;font-weight:800}a{color:#087f5b}li{margin:.35rem 0}
    </style>
  </head>
  <body>
    <main class="wrap">
      <article class="card">
        <p class="meta">Picture Dictionary${categoryLabel ? ` · ${escapeHtml(categoryLabel)}` : ""}</p>
        <h1>${escapeHtml(title)}</h1>
        ${imageUrl ? `<img class="hero" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}" />` : ""}
        <p>${escapeHtml(description)}</p>
        ${item?.description ? `<div class="section"><h2>Definition</h2><p>${escapeHtml(stripText(item.description))}</p></div>` : ""}
        ${categoryExplanation ? `<div class="section"><h2>Category explanation</h2><p>${escapeHtml(categoryExplanation)}</p></div>` : ""}
        ${examples.length ? `<div class="section"><h2>Examples</h2><ul>${examples.map((example) => `<li>${escapeHtml(example)}</li>`).join("")}</ul></div>` : ""}
        ${relatedWords.length ? `<div class="section"><h2>Related words</h2><ul>${relatedWords.map((word) => `<li>${escapeHtml(word)}</li>`).join("")}</ul></div>` : ""}
        ${funFact ? `<div class="section"><h2>Fun fact</h2><p>${escapeHtml(funFact)}</p></div>` : ""}
        <a class="cta" href="${escapeHtml(appUrl)}">Open interactive dictionary</a>
      </article>
    </main>
  </body>
</html>`;

router.get("/", async (req, res) => {
  try {
    const ua = String(req.get("user-agent") || "");
    const itemId = String(req.query.itemId || "").trim();
    const categoryId = String(req.query.categoryId || "").trim();
    const from = normalizeLang(req.query.from, "en");
    const to = normalizeLang(req.query.to, "kh");

    if (!BOT_UA_RE.test(ua)) {
      return res.status(404).type("text/plain").send("Crawler SEO route only");
    }

    if (itemId && !mongoose.Types.ObjectId.isValid(itemId)) {
      return res.status(404).type("text/plain").send("Item not found");
    }
    if (categoryId && !mongoose.Types.ObjectId.isValid(categoryId)) {
      return res.status(404).type("text/plain").send("Category not found");
    }

    const item = itemId
      ? await Item.findOne({ _id: itemId, $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] }).lean()
      : null;
    const resolvedCategoryId = String(categoryId || item?.categoryId || "");
    const category = resolvedCategoryId && mongoose.Types.ObjectId.isValid(resolvedCategoryId)
      ? await Category.findOne({ _id: resolvedCategoryId, $or: [{ isEnabled: true }, { isEnabled: { $exists: false } }] }).lean()
      : null;

    if (itemId && !item) return res.status(404).type("text/plain").send("Item not found");
    if (!item && !category) return res.status(404).type("text/plain").send("Dictionary page not found");

    if (!item && category) {
      const categorySlug = slug(category.label, "category");
      return res.redirect(301, `${SITE_URL}/share/category/${encodeURIComponent(resolvedCategoryId)}/${encodeURIComponent(categorySlug)}`);
    }

    const fromText = localizedValue(item.translations, from) || firstTranslation(item);
    const toText = localizedValue(item.translations, to);
    const title = toText ? `${fromText} (${toText})` : fromText;
    const categoryLabel = String(category?.label || "").trim();
    const examples = listValues(item.examples, to, 4);
    const relatedWords = listValues(item.relatedWords, to, 8);
    const categoryExplanation = localizedValue(item.categoryExplanations, to) || localizedValue(item.categoryExplanations, "en");
    const funFact = localizedValue(item.funFacts, to) || localizedValue(item.funFacts, "en");
    const descriptionParts = [
      toText ? `${fromText} means ${toText}.` : `${fromText} picture dictionary entry.`,
      categoryLabel ? `Category: ${categoryLabel}.` : "",
      stripText(item.description),
      examples[0] ? `Example: ${examples[0]}` : "",
    ].filter(Boolean);
    const description = descriptionParts.join(" ").slice(0, 320) || "Learn words with pictures, translations, and examples.";
    const imageUrl = absoluteUrl(req, item.imageUrl || item.imageThumbUrl);
    const itemSlug = slug(fromText, "word");
    const canonicalUrl = `${SITE_URL}/share/item/${encodeURIComponent(item._id)}/${encodeURIComponent(itemSlug)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const appParams = new URLSearchParams();
    if (resolvedCategoryId) appParams.set("categoryId", resolvedCategoryId);
    appParams.set("itemId", String(item._id));
    appParams.set("from", from);
    appParams.set("to", to);
    const appUrl = `${SITE_URL}/dictionary?${appParams.toString()}`;

    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=300");
    res.type("html").send(renderPage({
      lang: to || from,
      title,
      description,
      canonicalUrl,
      imageUrl,
      appUrl,
      categoryLabel,
      item,
      examples,
      relatedWords,
      categoryExplanation,
      funFact,
    }));
  } catch (error) {
    console.error("dictionary SEO route failed", error);
    res.status(500).type("text/plain").send("Dictionary page failed");
  }
});

module.exports = router;
