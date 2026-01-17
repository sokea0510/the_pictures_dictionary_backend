// backend/src/server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { connectDB } = require("./db");

const authRoutes = require("./routes/auth");
const meRoutes = require("./routes/me");
const publicRoutes = require("./routes/public");
const adminRoutes = require("./routes/admin");
const changeRoutes = require("./routes/changeRequests");

const app = express();
app.use(helmet());
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});
app.use(express.json({ limit: "4mb" }));
app.use(morgan("dev"));

const origins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (origins.length === 0) return cb(null, true);
      return origins.includes(origin) ? cb(null, true) : cb(new Error("CORS blocked"));
    },
    credentials: true,
    maxAge: 600
  })
);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/change-requests", changeRoutes);

const port = Number(process.env.PORT || 8080);

connectDB(process.env.MONGO_URI)
  .then(() => app.listen(port, () => console.log(`[api] http://localhost:${port}`)))
  .catch((e) => {
    console.error("[db] failed", e);
    process.exit(1);
  });
