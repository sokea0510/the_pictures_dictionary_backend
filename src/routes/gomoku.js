const express = require("express");
const mongoose = require("mongoose");
const { authRequired } = require("../middleware/auth");
const User = require("../models/User");
const GomokuFriend = require("../models/GomokuFriend");
const { buildProfileId, toGomokuProfile } = require("../utils/gomokuProfiles");
const { isProfileOnline, sendToProfile } = require("../gomokuSocket");

const router = express.Router();

const escapeRegExp = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const participantKey = (a, b) => [String(a), String(b)].sort().join(":");
const userSelect = "name email avatarUrl isActive updatedAt";

const idString = (value) => String(value?._id || value || "");

const profileForUser = (user) => ({
  ...toGomokuProfile(user, { online: isProfileOnline(buildProfileId(user)) }),
  isSelf: false,
});

const scoreForUser = (friendship, currentUserId) => {
  const requesterWins = Number(friendship.requesterWins || 0);
  const receiverWins = Number(friendship.receiverWins || 0);
  return idString(friendship.requester) === String(currentUserId)
    ? { me: requesterWins, opponent: receiverWins }
    : { me: receiverWins, opponent: requesterWins };
};

const friendshipPayload = (friendship, otherUser, currentUserId) => ({
  friendshipId: String(friendship._id),
  status: friendship.status,
  requester: idString(friendship.requester),
  receiver: idString(friendship.receiver),
  score: scoreForUser(friendship, currentUserId),
  friend: {
    ...profileForUser(otherUser),
    friendshipId: String(friendship._id),
    friendshipScore: scoreForUser(friendship, currentUserId),
  },
});

const findUserByProfileId = async (profileId) => {
  const q = String(profileId || "").trim();
  if (!/^\d{8}$/.test(q)) return null;
  const users = await User.find({ isActive: true }).select(userSelect).sort({ updatedAt: -1 }).limit(5000);
  return users.find((user) => buildProfileId(user) === q) || null;
};

router.get("/profiles/search", authRequired, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const limit = Math.max(1, Math.min(Number(req.query.limit || 12), 25));
  const currentUserId = String(req.user.id || "");
  const baseFilter = { isActive: true, _id: { $ne: req.user.id } };

  let users = [];
  if (q) {
    const tokens = q.split(/\s+/).filter(Boolean).slice(0, 5);
    const tokenFilters = tokens.map((token) => {
      const rx = new RegExp(escapeRegExp(token), "i");
      return { $or: [{ name: rx }, { email: rx }] };
    });
    users = await User.find({
      ...baseFilter,
      ...(tokenFilters.length ? { $and: tokenFilters } : {}),
    })
      .select(userSelect)
      .sort({ updatedAt: -1 })
      .limit(limit * 3);

    if (/^\d{1,8}$/.test(q)) {
      const pool = await User.find(baseFilter).select(userSelect).sort({ updatedAt: -1 }).limit(5000);
      const padded = q.padStart(8, "0");
      const byId = pool.filter((user) => buildProfileId(user).includes(q) || buildProfileId(user) === padded);
      const seen = new Set(users.map((user) => String(user._id)));
      for (const user of byId) if (!seen.has(String(user._id))) users.push(user);
    }
  } else {
    users = await User.find(baseFilter).select(userSelect).sort({ updatedAt: -1 }).limit(limit);
  }

  const profiles = [];
  const seen = new Set([currentUserId]);
  for (const user of users) {
    const id = String(user._id);
    if (seen.has(id)) continue;
    seen.add(id);
    profiles.push(profileForUser(user));
    if (profiles.length >= limit) break;
  }

  res.json({ profiles });
});

router.get("/friends", authRequired, async (req, res) => {
  const userId = req.user.id;
  const friendships = await GomokuFriend.find({
    status: "accepted",
    $or: [{ requester: userId }, { receiver: userId }],
  })
    .populate("requester", userSelect)
    .populate("receiver", userSelect)
    .sort({ acceptedAt: -1, updatedAt: -1 });

  const friends = friendships
    .map((friendship) => {
      const other = String(friendship.requester?._id) === String(userId) ? friendship.receiver : friendship.requester;
      if (!other) return null;
      return friendshipPayload(friendship, other, userId);
    })
    .filter(Boolean);

  res.json({ friends });
});

router.post("/friends/invite", authRequired, async (req, res) => {
  const targetUserId = String(req.body?.userId || "").trim();
  const targetProfileId = String(req.body?.profileId || "").trim();
  let receiver = null;
  if (mongoose.isValidObjectId(targetUserId)) receiver = await User.findOne({ _id: targetUserId, isActive: true }).select(userSelect);
  if (!receiver && targetProfileId) receiver = await findUserByProfileId(targetProfileId);
  if (!receiver) return res.status(404).json({ message: "Profile not found" });
  if (String(receiver._id) === String(req.user.id)) return res.status(400).json({ message: "Cannot invite yourself" });

  const requester = await User.findById(req.user.id).select(userSelect);
  if (!requester) return res.status(404).json({ message: "Requester not found" });

  const key = participantKey(req.user.id, receiver._id);
  let friendship = await GomokuFriend.findOne({ participantsKey: key });
  if (!friendship) {
    friendship = await GomokuFriend.create({ requester: req.user.id, receiver: receiver._id, participantsKey: key, status: "pending" });
  } else if (friendship.status === "declined") {
    friendship.requester = req.user.id;
    friendship.receiver = receiver._id;
    friendship.status = "pending";
    friendship.declinedAt = null;
    await friendship.save();
  }

  const from = { ...toGomokuProfile(requester, { online: true }), friendshipId: String(friendship._id) };
  sendToProfile(buildProfileId(receiver), { type: "invite_received", friendshipId: String(friendship._id), from });

  res.json({ friendship: friendshipPayload(friendship, receiver, req.user.id) });
});

router.post("/friends/:id/accept", authRequired, async (req, res) => {
  const friendship = await GomokuFriend.findById(req.params.id);
  if (!friendship) return res.status(404).json({ message: "Friend request not found" });
  if (String(friendship.receiver) !== String(req.user.id)) return res.status(403).json({ message: "Only the receiver can accept" });
  friendship.status = "accepted";
  friendship.acceptedAt = new Date();
  friendship.declinedAt = null;
  await friendship.save();

  const requester = await User.findById(friendship.requester).select(userSelect);
  const receiver = await User.findById(friendship.receiver).select(userSelect);
  if (requester && receiver) {
    sendToProfile(buildProfileId(requester), {
      type: "friend_accepted",
      friendshipId: String(friendship._id),
      friend: friendshipPayload(friendship, receiver, requester._id).friend,
      score: scoreForUser(friendship, requester._id),
    });
  }
  res.json({ friendship: friendshipPayload(friendship, requester, req.user.id) });
});

router.post("/friends/:id/score", authRequired, async (req, res) => {
  const friendship = await GomokuFriend.findById(req.params.id);
  if (!friendship) return res.status(404).json({ message: "Friendship not found" });
  if (friendship.status !== "accepted") return res.status(400).json({ message: "Friendship is not accepted" });
  const isRequester = String(friendship.requester) === String(req.user.id);
  const isReceiver = String(friendship.receiver) === String(req.user.id);
  if (!isRequester && !isReceiver) return res.status(403).json({ message: "Only players can update this score" });

  const requester = await User.findById(friendship.requester).select(userSelect);
  const receiver = await User.findById(friendship.receiver).select(userSelect);
  if (!requester || !receiver) return res.status(404).json({ message: "Player not found" });

  const matchId = String(req.body?.matchId || "").trim().slice(0, 200);
  const scoredMatchIds = Array.isArray(friendship.scoredMatchIds) ? friendship.scoredMatchIds : [];
  const alreadyScored = matchId && scoredMatchIds.includes(matchId);
  const submittedScore = req.body?.score || {};
  const submittedMe = Number(submittedScore.me);
  const submittedOpponent = Number(submittedScore.opponent);

  if (Number.isFinite(submittedMe) && Number.isFinite(submittedOpponent) && submittedMe >= 0 && submittedOpponent >= 0) {
    if (isRequester) {
      friendship.requesterWins = Math.max(Number(friendship.requesterWins || 0), Math.floor(submittedMe));
      friendship.receiverWins = Math.max(Number(friendship.receiverWins || 0), Math.floor(submittedOpponent));
    } else {
      friendship.receiverWins = Math.max(Number(friendship.receiverWins || 0), Math.floor(submittedMe));
      friendship.requesterWins = Math.max(Number(friendship.requesterWins || 0), Math.floor(submittedOpponent));
    }
  } else if (!alreadyScored) {
    const winnerProfileId = String(req.body?.winnerProfileId || "").trim();
    if (winnerProfileId === buildProfileId(requester)) friendship.requesterWins = Number(friendship.requesterWins || 0) + 1;
    else if (winnerProfileId === buildProfileId(receiver)) friendship.receiverWins = Number(friendship.receiverWins || 0) + 1;
    else return res.status(400).json({ message: "Winner profile is not in this friendship" });
  }

  if (matchId && !alreadyScored) {
    scoredMatchIds.push(matchId);
    friendship.scoredMatchIds = scoredMatchIds.slice(-120);
  }

  await friendship.save();
  res.json({ ok: true, duplicate: !!alreadyScored, score: scoreForUser(friendship, req.user.id) });
});

router.post("/friends/:id/decline", authRequired, async (req, res) => {
  const friendship = await GomokuFriend.findById(req.params.id);
  if (!friendship) return res.status(404).json({ message: "Friend request not found" });
  if (String(friendship.receiver) !== String(req.user.id)) return res.status(403).json({ message: "Only the receiver can decline" });
  friendship.status = "declined";
  friendship.declinedAt = new Date();
  await friendship.save();
  res.json({ ok: true });
});

module.exports = router;
