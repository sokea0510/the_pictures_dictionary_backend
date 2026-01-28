// backend/src/seedOwner.js
require("dotenv").config();
const bcrypt = require("bcryptjs");
const { connectDB } = require("./db");
const User = require("./models/User");

async function run() {
  const { MONGO_URI, OWNER_EMAIL, OWNER_PASSWORD } = process.env;

  if (!MONGO_URI) {
    console.log("Missing MONGO_URI in .env");
    process.exit(1);
  }
  if (!OWNER_EMAIL || !OWNER_PASSWORD) {
    console.log("Missing OWNER_EMAIL or OWNER_PASSWORD in .env");
    process.exit(1);
  }

  await connectDB(MONGO_URI);

  const email = OWNER_EMAIL.trim().toLowerCase();
  const password = OWNER_PASSWORD;

  const exists = await User.findOne({ email });
  if (exists) {
    // Ensure role is owner (in case user existed)
    if (exists.role !== "owner") {
      exists.role = "owner";
      await exists.save();
      console.log("[seed] user existed; updated role to owner:", email);
    } else {
      console.log("[seed] owner exists:", email);
    }
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 10);
  await User.create({ email, passwordHash, role: "owner" });

  console.log("[seed] owner created:", email);
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
