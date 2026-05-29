const buildProfileId = (user) => {
  const raw = String(user?._id || "guest-player").trim().replace(/\s+/g, "-");
  const name = String(user?.name || user?.email || "Guest Player");
  const source = `${raw}-${name}`;
  let hash = 0;
  for (let i = 0; i < source.length; i += 1) {
    hash = (hash * 31 + source.charCodeAt(i)) >>> 0;
  }
  return String(hash % 100000000).padStart(8, "0");
};

const toGomokuProfile = (user, { online = false } = {}) => {
  const name = String(user?.name || user?.email || "Guest Player").trim();
  return {
    id: String(user._id),
    profileId: buildProfileId(user),
    name,
    fullName: name,
    avatarUrl: user.avatarUrl || "",
    level: 12,
    country: "PLAYER",
    rating: 1320,
    online: !!online,
    color: "from-sky-500 to-indigo-600",
  };
};

module.exports = { buildProfileId, toGomokuProfile };
