// backend/src/utils/notifications.js

const Notification = require("../models/Notification");
const User = require("../models/User");
const Item = require("../models/Item");
const { sendWebPushToUser, sendWebPushToUsers } = require("./webPush");

const isAllowed = (user, key) => {
  if (!user) return false;
  const prefs = user.notificationPreferences || {};
  if (typeof prefs[key] === "boolean") return prefs[key];
  return true;
};

const createNotification = async ({
  userId,
  type,
  title,
  body,
  link,
  imageUrl,
  status,
  meta,
}) => {
  if (!userId) return null;
  const doc = await Notification.create({
    userId,
    type,
    title: title || "",
    body: body || "",
    link: link || "",
    imageUrl: imageUrl || "",
    status: status || "",
    meta: meta || {},
  });
  await sendWebPushToUser(userId, {
    type: type || "general",
    title: title || "",
    body: body || "",
    data: {
      link: link || "",
      imageUrl: imageUrl || "",
      status: status || "",
      meta: meta || {},
    },
  }).catch(() => ({}));
  return doc;
};

const notifyUser = async (user, prefKey, payload) => {
  if (!user || !isAllowed(user, prefKey)) return null;
  return createNotification({ userId: user._id, ...payload });
};

const notifyUsersByRole = async (roles, prefKey, payload) => {
  const users = await User.find({ role: { $in: roles }, isActive: true }).select("notificationPreferences");
  const targets = users.filter((u) => isAllowed(u, prefKey));
  if (!targets.length) return [];
  const docs = targets.map((u) => ({
    userId: u._id,
    type: payload.type || "general",
    title: payload.title || "",
    body: payload.body || "",
    link: payload.link || "",
    imageUrl: payload.imageUrl || "",
    status: payload.status || "",
    meta: payload.meta || {},
  }));
  const inserted = await Notification.insertMany(docs);
  await sendWebPushToUsers(
    targets.map((u) => u._id),
    {
      type: payload.type || "general",
      title: payload.title || "",
      body: payload.body || "",
      data: {
        link: payload.link || "",
        imageUrl: payload.imageUrl || "",
        status: payload.status || "",
        meta: payload.meta || {},
      },
    }
  ).catch(() => ({}));
  return inserted;
};

const notifyCategoryFollowers = async (item, payload = {}) => {
  if (!item?.categoryId) return [];
  const categoryItems = await Item.find({ categoryId: item.categoryId }).select("_id");
  if (!categoryItems.length) return [];
  const itemIds = categoryItems.map((doc) => doc._id);
  const users = await User.find({
    isActive: true,
    favorites: { $in: itemIds },
    "notificationPreferences.favoritesUpdates": { $ne: false },
  }).select("notificationPreferences");
  if (!users.length) return [];
  const docs = users.map((u) => ({
    userId: u._id,
    type: payload.type || "category_update",
    title: payload.title || "New content added",
    body: payload.body || "New words were added to a category you follow.",
    link: payload.link || `/dictionary?categoryId=${item.categoryId}`,
    imageUrl: payload.imageUrl || item.imageUrl || "",
    status: payload.status || "",
    meta: {
      categoryId: item.categoryId,
      itemId: item._id,
    },
  }));
  const inserted = await Notification.insertMany(docs);
  await sendWebPushToUsers(
    users.map((u) => u._id),
    {
      type: payload.type || "category_update",
      title: payload.title || "New content added",
      body: payload.body || "New words were added to a category you follow.",
      data: {
        link: payload.link || `/dictionary?categoryId=${item.categoryId}`,
        imageUrl: payload.imageUrl || item.imageUrl || "",
        meta: {
          categoryId: item.categoryId,
          itemId: item._id,
        },
      },
    }
  ).catch(() => ({}));
  return inserted;
};

module.exports = {
  isAllowed,
  createNotification,
  notifyUser,
  notifyUsersByRole,
  notifyCategoryFollowers,
};
