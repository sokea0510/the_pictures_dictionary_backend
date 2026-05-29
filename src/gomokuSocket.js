const crypto = require("crypto");
const { verifyToken } = require("./utils/jwt");
const User = require("./models/User");
const { buildProfileId, toGomokuProfile } = require("./utils/gomokuProfiles");

const clientsByProfileId = new Map();
const profileByProfileId = new Map();

const getOnlineProfileIds = () => new Set(clientsByProfileId.keys());
const isProfileOnline = (profileId) => clientsByProfileId.has(String(profileId || ""));

const sendFrame = (socket, payload) => {
  if (!socket || socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  socket.write(Buffer.concat([header, data]));
};

const decodeFrame = (buffer) => {
  if (!buffer || buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  if (opcode === 0x8) return { type: "close" };
  if (opcode !== 0x1) return null;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;
  const payload = buffer.subarray(offset, offset + length);
  const decoded = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) decoded[i] = mask ? payload[i] ^ mask[i % 4] : payload[i];
  try {
    return { type: "message", data: JSON.parse(decoded.toString("utf8")) };
  } catch {
    return null;
  }
};

const broadcastOnlineProfiles = () => {
  const profiles = Array.from(profileByProfileId.values()).map((profile) => ({ ...profile, online: true }));
  for (const sockets of clientsByProfileId.values()) {
    for (const socket of sockets) sendFrame(socket, { type: "online_profiles", profiles });
  }
};

const addClient = (profileId, socket, profile) => {
  const set = clientsByProfileId.get(profileId) || new Set();
  set.add(socket);
  clientsByProfileId.set(profileId, set);
  profileByProfileId.set(profileId, { ...profile, online: true });
  socket.gomokuProfileId = profileId;
  socket.gomokuProfile = profile;
  sendFrame(socket, { type: "connected", profile: { ...profile, online: true } });
  broadcastOnlineProfiles();
};

const removeClient = (socket) => {
  const profileId = socket.gomokuProfileId;
  if (!profileId) return;
  const set = clientsByProfileId.get(profileId);
  if (set) {
    set.delete(socket);
    if (!set.size) {
      clientsByProfileId.delete(profileId);
      profileByProfileId.delete(profileId);
    }
  }
  broadcastOnlineProfiles();
};

const sendToProfile = (profileId, payload) => {
  const sockets = clientsByProfileId.get(String(profileId || ""));
  if (!sockets?.size) return false;
  for (const socket of sockets) sendFrame(socket, payload);
  return true;
};

const handleMessage = (socket, message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "ping") {
    sendFrame(socket, { type: "pong", at: Date.now() });
    return;
  }
  if (message.type === "invite_profile") {
    const ok = sendToProfile(message.toProfileId, {
      type: "invite_received",
      from: socket.gomokuProfile,
    });
    sendFrame(socket, { type: "invite_sent", toProfileId: message.toProfileId, ok });
    return;
  }
  if (message.type === "ask_play") {
    const ok = sendToProfile(message.toProfileId, {
      type: "play_request",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
    });
    sendFrame(socket, { type: "play_request_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "play_accept") {
    const ok = sendToProfile(message.toProfileId, {
      type: "play_accepted",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
    });
    sendFrame(socket, { type: "play_accept_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "rematch_request") {
    const ok = sendToProfile(message.toProfileId, {
      type: "rematch_request",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
    });
    sendFrame(socket, { type: "rematch_request_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "rematch_accept") {
    const ok = sendToProfile(message.toProfileId, {
      type: "rematch_accepted",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
    });
    sendFrame(socket, { type: "rematch_accept_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "gomoku_move") {
    const row = Number(message.row);
    const col = Number(message.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    const ok = sendToProfile(message.toProfileId, {
      type: "gomoku_move",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
      row,
      col,
      player: Number(message.player) || 0,
    });
    sendFrame(socket, { type: "gomoku_move_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "gomoku_undo") {
    const row = Number(message.row);
    const col = Number(message.col);
    if (!Number.isInteger(row) || !Number.isInteger(col)) return;
    const ok = sendToProfile(message.toProfileId, {
      type: "gomoku_undo",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
      row,
      col,
      player: Number(message.player) || 0,
    });
    sendFrame(socket, { type: "gomoku_undo_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
    return;
  }
  if (message.type === "gomoku_chat") {
    const text = String(message.text || "").trim().slice(0, 120);
    if (!text) return;
    const ok = sendToProfile(message.toProfileId, {
      type: "gomoku_chat",
      from: socket.gomokuProfile,
      matchId: typeof message.matchId === "string" ? message.matchId : "",
      text,
      at: Date.now(),
    });
    sendFrame(socket, { type: "gomoku_chat_sent", toProfileId: message.toProfileId, ok, matchId: typeof message.matchId === "string" ? message.matchId : "" });
  }
};

const initGomokuSocket = (server) => {
  server.on("upgrade", async (req, socket) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname !== "/api/gomoku/socket") return;
      const key = req.headers["sec-websocket-key"];
      if (!key) return socket.destroy();
      const token = url.searchParams.get("token") || "";
      const payload = verifyToken(token);
      const user = await User.findById(payload.id).select("name email avatarUrl isActive");
      if (!user || !user.isActive) return socket.destroy();
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write([
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "",
        "",
      ].join("\r\n"));
      const profileId = buildProfileId(user);
      addClient(profileId, socket, toGomokuProfile(user, { online: true }));
      socket.on("data", (buffer) => {
        const frame = decodeFrame(buffer);
        if (frame?.type === "close") return socket.end();
        if (frame?.type === "message") handleMessage(socket, frame.data);
      });
      socket.on("close", () => removeClient(socket));
      socket.on("error", () => removeClient(socket));
    } catch {
      socket.destroy();
    }
  });
};

module.exports = { initGomokuSocket, getOnlineProfileIds, isProfileOnline, sendToProfile };
