// backend/src/utils/storage.js

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const crypto = require("crypto");

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const getEnv = (key) => (process.env[key] || "").trim();

const s3Client = () => {
  const endpoint = getEnv("S3_ENDPOINT");
  const region = getEnv("S3_REGION") || "auto";
  const accessKeyId = getEnv("S3_ACCESS_KEY");
  const secretAccessKey = getEnv("S3_SECRET_KEY");
  const forcePathStyle = getEnv("S3_FORCE_PATH_STYLE") === "true";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error("S3 credentials not configured");
  }
  return new S3Client({
    region,
    endpoint,
    forcePathStyle,
    credentials: { accessKeyId, secretAccessKey },
  });
};

const parseDataUrl = (value) => {
  const match = String(value || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  return { contentType, buffer };
};

const extFromType = (contentType) => {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/gif") return "gif";
  return "bin";
};

const publicBase = () => getEnv("S3_PUBLIC_BASE");

const buildPublicUrl = (key) => {
  const base = publicBase();
  if (base) return `${base.replace(/\/+$/, "")}/${key}`;
  const endpoint = getEnv("S3_ENDPOINT").replace(/\/+$/, "");
  const bucket = getEnv("S3_BUCKET");
  return `${endpoint}/${bucket}/${key}`;
};

const uploadImageDataUrl = async ({ dataUrl, keyPrefix }) => {
  const bucket = getEnv("S3_BUCKET");
  if (!bucket) throw new Error("S3 bucket not configured");

  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw new Error("Invalid image data");
  const { contentType, buffer } = parsed;
  if (!ALLOWED_TYPES.has(contentType)) throw new Error("Unsupported image type");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image too large");

  const ext = extFromType(contentType);
  const key = `${keyPrefix}/${crypto.randomBytes(16).toString("hex")}.${ext}`;

  const client = s3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  return { key, url: buildPublicUrl(key) };
};

module.exports = {
  uploadImageDataUrl,
};
