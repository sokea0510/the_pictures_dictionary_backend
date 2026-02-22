const express = require("express");
const { authRequired } = require("../middleware/auth");
const PushSubscription = require("../models/PushSubscription");
const { getWebPushPublicKey, isWebPushReady, sendWebPushToUser } = require("../utils/webPush");

const router = express.Router();

const isValidSubscription = (sub) => {
  return Boolean(
    sub &&
      typeof sub.endpoint === "string" &&
      sub.endpoint &&
      sub.keys &&
      typeof sub.keys.p256dh === "string" &&
      sub.keys.p256dh &&
      typeof sub.keys.auth === "string" &&
      sub.keys.auth
  );
};

router.get("/public-key", (_req, res) => {
  const publicKey = getWebPushPublicKey();
  res.json({ publicKey, configured: Boolean(publicKey && isWebPushReady()) });
});

router.post("/subscribe", authRequired, async (req, res) => {
  if (!isWebPushReady()) {
    return res.status(503).json({ message: "Web push is not configured on server." });
  }

  const subscription = req.body?.subscription;
  if (!isValidSubscription(subscription)) {
    return res.status(400).json({ message: "Invalid subscription payload." });
  }

  await PushSubscription.findOneAndUpdate(
    { endpoint: subscription.endpoint },
    {
      $set: {
        userId: req.user.id,
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
        },
        userAgent: req.get("user-agent") || "",
        platform: String(req.body?.platform || ""),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.json({ ok: true });
});

router.post("/unsubscribe", authRequired, async (req, res) => {
  const endpoint = String(req.body?.endpoint || "");
  if (!endpoint) return res.status(400).json({ message: "Missing endpoint." });
  await PushSubscription.deleteOne({ userId: req.user.id, endpoint });
  res.json({ ok: true });
});

router.post("/test", authRequired, async (req, res) => {
  if (!isWebPushReady()) {
    return res.status(503).json({ message: "Web push is not configured on server." });
  }

  const result = await sendWebPushToUser(req.user.id, {
    type: "push_test",
    title: "Push is enabled",
    body: "Your Picture Dictionary PWA can receive push notifications.",
    data: { link: "/settings/notifications" },
  });

  res.json({ ok: true, ...result });
});

module.exports = router;
