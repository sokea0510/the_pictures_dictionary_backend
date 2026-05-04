// backend/src/server.js

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const { connectDB } = require("./db");

const authRoutes = require("./routes/auth");
const meRoutes = require("./routes/me");
const publicRoutes = require("./routes/public");
const adminRoutes = require("./routes/admin");
const changeRoutes = require("./routes/changeRequests");
const uploadRoutes = require("./routes/uploads");
const pushRoutes = require("./routes/push");
const shareRoutes = require("./routes/share");
const blogRoutes = require("./routes/blog");

const app = express();
app.use(helmet());
app.use(compression());
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

const normalizeOriginHost = (value) => {
  if (!value) return "";
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.host.toLowerCase();
  } catch {
    return "";
  }
};

const isDomainHost = (host) => {
  if (!host) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (host.includes(":")) return false;
  return host.includes(".");
};

const expandEquivalentHosts = (host) => {
  if (!host) return [];
  const variants = new Set([host]);
  if (isDomainHost(host)) {
    if (host.startsWith("www.")) variants.add(host.slice(4));
    else variants.add(`www.${host}`);
  }
  return Array.from(variants);
};

const allowedHosts = Array.from(
  new Set(
    origins
      .map(normalizeOriginHost)
      .filter(Boolean)
      .flatMap(expandEquivalentHosts)
  )
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  if (origins.length === 0 || origins.includes("*")) return true;
  if (origins.includes(origin)) return true;
  const host = normalizeOriginHost(origin);
  return host ? allowedHosts.includes(host) : false;
};

const corsOptions = {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked for origin: ${origin || "unknown"}`));
  },
  credentials: true,
  maxAge: 600,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.options("*", cors(corsOptions));
app.use(cors(corsOptions));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/health", (req, res) => res.status(200).json({ ok: true }));
app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send(
    "User-agent: *\nDisallow: /\nAllow: /api/health\n"
  );
});
app.use("/share", shareRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/me", meRoutes);
app.use("/api/public", publicRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/change-requests", changeRoutes);
app.use("/api/uploads", uploadRoutes);
app.use("/api/push", pushRoutes);
app.use("/api/blog", blogRoutes);

const port = Number(process.env.PORT || 4000);

connectDB(process.env.MONGO_URI)
  .then(() => app.listen(port, () => console.log(`[api] http://localhost:${port}`)))
  .catch((e) => {
    console.error("[db] failed", e);
    process.exit(1);
  });
