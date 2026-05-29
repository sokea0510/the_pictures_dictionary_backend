const mongoose = require("mongoose");

const GomokuFriendSchema = new mongoose.Schema(
  {
    requester: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    participantsKey: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["pending", "accepted", "declined"], default: "pending", index: true },
    acceptedAt: { type: Date, default: null },
    declinedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GomokuFriend", GomokuFriendSchema);
