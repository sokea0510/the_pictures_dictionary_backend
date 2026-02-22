const PushSubscription = require("../models/PushSubscription");

let webPushLib = null;
try {
  // Optional at runtime until dependency is installed.
  webPushLib = require("web-push");
} catch {
  webPushLib = null;
}

let configured = false;
let warned = false;

const getConfig = () => {
  const publicKey = process.env.WEB_PUSH_PUBLIC_KEY || "";
  const privateKey = process.env.WEB_PUSH_PRIVATE_KEY || "";
  const subject = process.env.WEB_PUSH_SUBJECT || "mailto:admin@example.com";
  return { publicKey, privateKey, subject };
};

const ensureConfigured = () => {
  if (configured) return true;
  const { publicKey, privateKey, subject } = getConfig();
  if (!webPushLib || !publicKey || !privateKey) {
    if (!warned) {
      warned = true;
      console.warn("[push] web push disabled (missing dependency or VAPID keys)");
    }
    return false;
  }
  webPushLib.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
};

const isWebPushReady = () => {
  const { publicKey, privateKey } = getConfig();
  return Boolean(webPushLib && publicKey && privateKey);
};

const getWebPushPublicKey = () => getConfig().publicKey;

const sendWebPushToSubscriptions = async (subscriptions, payload = {}) => {
  if (!ensureConfigured()) return { sent: 0, failed: 0 };
  if (!Array.isArray(subscriptions) || !subscriptions.length) return { sent: 0, failed: 0 };

  const body = JSON.stringify({
    title: payload.title || "Picture Dictionary",
    body: payload.body || "",
    icon: payload.icon || "/apple-touch-icon.png",
    badge: payload.badge || "/favicons.png",
    data: payload.data || {},
    tag: payload.tag || payload.type || "general",
  });

  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (doc) => {
      try {
        await webPushLib.sendNotification(
          {
            endpoint: doc.endpoint,
            keys: {
              p256dh: doc.keys?.p256dh || "",
              auth: doc.keys?.auth || "",
            },
          },
          body
        );
        sent += 1;
      } catch (err) {
        failed += 1;
        const code = Number(err?.statusCode || 0);
        if (code === 404 || code === 410) {
          await PushSubscription.deleteOne({ _id: doc._id });
        }
      }
    })
  );

  return { sent, failed };
};

const sendWebPushToUser = async (userId, payload = {}) => {
  if (!userId) return { sent: 0, failed: 0 };
  const subscriptions = await PushSubscription.find({ userId }).lean();
  return sendWebPushToSubscriptions(subscriptions, payload);
};

const sendWebPushToUsers = async (userIds = [], payload = {}) => {
  const validIds = Array.from(new Set((userIds || []).filter(Boolean).map(String)));
  if (!validIds.length) return { sent: 0, failed: 0 };
  const subscriptions = await PushSubscription.find({ userId: { $in: validIds } }).lean();
  return sendWebPushToSubscriptions(subscriptions, payload);
};

module.exports = {
  getWebPushPublicKey,
  isWebPushReady,
  sendWebPushToUser,
  sendWebPushToUsers,
};
