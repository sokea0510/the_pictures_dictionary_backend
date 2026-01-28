// backend/src/utils/translate.js

const { notifyUsersByRole } = require("./notifications");
const TranslationSettings = require("../models/TranslationSettings");
const TranslationUsage = require("../models/TranslationUsage");

let TranslateClient;
let TranslateTextCommand;
try {
  ({ TranslateClient, TranslateTextCommand } = require("@aws-sdk/client-translate"));
} catch {
  TranslateClient = null;
  TranslateTextCommand = null;
}

const providerOrder = () => {
  const raw = process.env.TRANSLATION_PROVIDERS || "azure,google,aws,libre";
  return raw
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
};

const state = {
  lastProvider: "",
  lastNotifyAt: {},
  lastUsageNotifyAt: {},
  settingsCache: { data: null, fetchedAt: 0 },
};

const notifySwitch = async ({ from, to, error }) => {
  const key = `${from || "none"}->${to}`;
  const now = Date.now();
  const last = state.lastNotifyAt[key] || 0;
  if (now - last < 30 * 60 * 1000) return;
  state.lastNotifyAt[key] = now;
  await notifyUsersByRole(["owner"], "systemAlerts", {
    type: "system_alert",
    title: "Translation provider switched",
    body: `Switched from ${from || "none"} to ${to}. Reason: ${error}`,
    link: "/settings/translation",
    status: "warning",
    meta: { from, to },
  });
};

const toAzure = (code) => (code ? String(code).toLowerCase() : "");
const toGoogle = (code) => (code ? String(code).toLowerCase() : "");
const toAws = (code) => (code ? String(code).toLowerCase() : "");
const toLibre = (code) => (code ? String(code).toLowerCase() : "");

const MONTHLY_LIMITS = {
  azure: 2000000,
  google: 500000,
  aws: 2000000,
  libre: null,
};

const pick = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
};

const getSettings = async () => {
  const ttlMs = 60 * 1000;
  const now = Date.now();
  if (state.settingsCache.data && now - state.settingsCache.fetchedAt < ttlMs) {
    return state.settingsCache.data;
  }
  let doc = await TranslationSettings.findOne().lean();
  if (!doc) doc = { providers: {} };

  const providers = {
    azure: {
      key: pick(doc.providers?.azure?.key, process.env.AZURE_TRANSLATOR_KEY),
      region: pick(doc.providers?.azure?.region, process.env.AZURE_TRANSLATOR_REGION),
      endpoint: pick(doc.providers?.azure?.endpoint, process.env.AZURE_TRANSLATOR_ENDPOINT),
    },
    google: {
      key: pick(doc.providers?.google?.key, process.env.GOOGLE_TRANSLATE_KEY),
    },
    aws: {
      accessKeyId: pick(doc.providers?.aws?.accessKeyId, process.env.AWS_ACCESS_KEY_ID),
      secretAccessKey: pick(doc.providers?.aws?.secretAccessKey, process.env.AWS_SECRET_ACCESS_KEY),
      region: pick(doc.providers?.aws?.region, process.env.AWS_REGION),
      sessionToken: pick(doc.providers?.aws?.sessionToken, process.env.AWS_SESSION_TOKEN),
    },
    libre: {
      url: pick(doc.providers?.libre?.url, process.env.LIBRETRANSLATE_URL),
      apiKey: pick(doc.providers?.libre?.apiKey, process.env.LIBRETRANSLATE_API_KEY),
    },
  };

  const data = { providers };
  state.settingsCache = { data, fetchedAt: now };
  return data;
};

const canUseAzure = (config) => config.key && config.region;
const canUseGoogle = (config) => config.key;
const canUseAws = (config) =>
  TranslateClient &&
  TranslateTextCommand &&
  config.accessKeyId &&
  config.secretAccessKey &&
  config.region;
const canUseLibre = (config) => config.url || config.apiKey;

const translateAzure = async ({ text, source, target, config }) => {
  const endpoint = config.endpoint || "https://api.cognitive.microsofttranslator.com";
  const apiVersion = "3.0";
  const qs = new URLSearchParams({ "api-version": apiVersion, to: toAzure(target) });
  if (source && source !== "auto") qs.set("from", toAzure(source));
  const res = await fetch(`${endpoint.replace(/\/$/, "")}/translate?${qs.toString()}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": config.key,
      "Ocp-Apim-Subscription-Region": config.region,
    },
    body: JSON.stringify([{ Text: text }]),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "Azure translation failed.");
  const translatedText = data?.[0]?.translations?.[0]?.text || "";
  return translatedText;
};

const translateGoogle = async ({ text, source, target, config }) => {
  const apiKey = config.key;
  const endpoint = "https://translation.googleapis.com/language/translate/v2";
  const body = {
    q: text,
    target: toGoogle(target),
    format: "text",
  };
  if (source && source !== "auto") body.source = toGoogle(source);
  const res = await fetch(`${endpoint}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || "Google translation failed.");
  const translatedText = data?.data?.translations?.[0]?.translatedText || "";
  return translatedText;
};

const translateAws = async ({ text, source, target, config }) => {
  if (!TranslateClient || !TranslateTextCommand) {
    throw new Error("AWS Translate SDK not available.");
  }
  const client = new TranslateClient({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      sessionToken: config.sessionToken || undefined,
    },
  });
  const command = new TranslateTextCommand({
    Text: text,
    SourceLanguageCode: source && source !== "auto" ? toAws(source) : "auto",
    TargetLanguageCode: toAws(target),
  });
  const data = await client.send(command);
  return data?.TranslatedText || "";
};

const translateLibre = async ({ text, source, target, config }) => {
  const apiBase = config.url || "https://libretranslate.com";
  const apiKey = config.apiKey || "";
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: text,
      source: source || "auto",
      target: toLibre(target),
      format: "text",
      api_key: apiKey || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "LibreTranslate failed.");
  return data?.translatedText || "";
};

const providerFns = {
  azure: translateAzure,
  google: translateGoogle,
  aws: translateAws,
  libre: translateLibre,
};

const isAvailable = {
  azure: canUseAzure,
  google: canUseGoogle,
  aws: canUseAws,
  libre: canUseLibre,
};

const updateUsage = async ({ provider, chars }) => {
  const yearMonth = new Date().toISOString().slice(0, 7);
  await TranslationUsage.findOneAndUpdate(
    { provider, yearMonth },
    { $inc: { chars } },
    { upsert: true, new: true }
  );

  const limit = MONTHLY_LIMITS[provider] || null;
  if (!limit) return;
  const usage = await TranslationUsage.findOne({ provider, yearMonth }).lean();
  const used = usage?.chars || 0;
  const pct = used / limit;
  const level = pct >= 1 ? "exhausted" : pct >= 0.8 ? "warning" : "";
  if (!level) return;

  const key = `${provider}:${yearMonth}:${level}`;
  const now = Date.now();
  const last = state.lastUsageNotifyAt[key] || 0;
  if (now - last < 30 * 60 * 1000) return;
  state.lastUsageNotifyAt[key] = now;
  await notifyUsersByRole(["owner"], "systemAlerts", {
    type: "system_alert",
    title: "Translation usage alert",
    body: `${provider.toUpperCase()} usage is at ${Math.round(pct * 100)}% of the monthly limit.`,
    link: "/settings/translation",
    status: level === "exhausted" ? "error" : "warning",
    meta: { provider, used, limit },
  });
};

const translateText = async ({ text, source, target }) => {
  const errors = [];
  let usedProvider = "";
  const providers = providerOrder();
  const settings = await getSettings();

  for (const provider of providers) {
    const available = isAvailable[provider];
    const fn = providerFns[provider];
    const config = settings.providers?.[provider] || {};
    if (!available || !available(config)) continue;
    if (!fn) continue;
    try {
      const translatedText = await fn({ text, source, target, config });
      usedProvider = provider;
      if (state.lastProvider && state.lastProvider !== usedProvider) {
        await notifySwitch({
          from: state.lastProvider,
          to: usedProvider,
          error: errors[errors.length - 1]?.message || "fallback",
        });
      }
      await updateUsage({ provider: usedProvider, chars: String(text || "").length });
      state.lastProvider = usedProvider;
      return { translatedText, provider: usedProvider };
    } catch (err) {
      errors.push({ provider, message: err?.message || "Translation failed." });
    }
  }

  if (state.lastProvider) {
    await notifySwitch({
      from: state.lastProvider,
      to: "none",
      error: errors[errors.length - 1]?.message || "all providers failed",
    });
  }

  const last = errors[errors.length - 1];
  const message = last ? `${last.provider}: ${last.message}` : "No translation provider configured.";
  throw new Error(message);
};

module.exports = {
  translateText,
};
