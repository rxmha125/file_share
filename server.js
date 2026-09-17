import "dotenv/config";
import express from "express";
import multer from "multer";
import {
  S3Client,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_ENDPOINT = process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
const R2_PUBLIC_BASE_URL = process.env.R2_PUBLIC_BASE_URL;

if (!R2_ACCOUNT_ID || !R2_BUCKET_NAME || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_PUBLIC_BASE_URL) {
  console.error("Missing R2 environment variables. Copy .env.example to .env and fill in your values.");
  process.exit(1);
}

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  // Disable automatic checksums — otherwise the SDK appends x-amz-checksum-*
  // to presigned URLs, which complicates browser CORS preflights.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

// NOTE: R2 bucket CORS must be configured in the Cloudflare dashboard (the S3-compatible
// API does not implement PutBucketCors). See README for the exact CORS rule to add.

const app = express();
app.use(express.json());
// Serve static frontend in local dev. On Vercel, static files are served by the platform.
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

function safeKey(originalName) {
  const safe = originalName
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return `${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safe}`;
}

// Presign — returns a one-time PUT URL the browser uploads directly to R2 with.
// This bypasses Vercel's 4.5MB serverless body limit entirely.
app.get("/api/presign", async (req, res) => {
  try {
    const name = (req.query.name || "file").toString().slice(0, 200);
    const type = (req.query.type || "application/octet-stream").toString().slice(0, 200);
    const key = safeKey(name);

    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: type,
      }),
      { expiresIn: 600 } // 10 min
    );

    res.json({
      uploadUrl,
      key,
      publicUrl: `${R2_PUBLIC_BASE_URL}/${key}`,
      name,
    });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).json({ error: "Failed to generate upload URL", detail: err.message, stack: err.stack });
  }
});

// Legacy buffered upload — kept for small-file compatibility / local dev.
// Will fail on Vercel for files > 4.5MB due to serverless body limits. Prefer /api/presign.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 * 1024 * 2 } });
app.post("/api/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided" });
    const key = safeKey(req.file.originalname);
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype || "application/octet-stream",
      })
    );
    res.json({
      url: `${R2_PUBLIC_BASE_URL}/${key}`,
      name: req.file.originalname,
      size: req.file.size,
      key,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", detail: err.message, stack: err.stack });
  }
});

// List files
app.get("/api/files", async (req, res) => {
  try {
    const data = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        MaxKeys: 100,
      })
    );
    const items = (data.Contents || [])
      .filter((o) => o.Size > 0)
      .map((o) => {
        const key = o.Key;
        const parts = key.split("-");
        const namePart = parts.slice(2).join("-") || key;
        const ts = parseInt(parts[0], 10);
        return {
          key,
          name: namePart,
          size: o.Size,
          url: `${R2_PUBLIC_BASE_URL}/${key}`,
          uploaded: isNaN(ts) ? o.LastModified : new Date(ts),
        };
      })
      .sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
    res.json({ files: items });
  } catch (err) {
    console.error("List error:", err);
    res.status(500).json({ error: "Failed to list files", detail: err.message, stack: err.stack });
  }
});

// Delete file
app.delete("/api/files/:key", async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    await s3.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Delete failed", detail: err.message, stack: err.stack });
  }
});

// Only listen when running locally (not on Vercel serverless)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`File share running on http://localhost:${PORT}`);
  });
}

export default app;
