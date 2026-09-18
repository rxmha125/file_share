import "dotenv/config";
import express from "express";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
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
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const app = express();

// Streaming upload — pipes the raw request body straight to R2 via multipart upload.
// No body-parser, no buffering, minimal memory. Works on any real server (Render, VPS, local).
// The browser sends the file as the raw POST body with Content-Type = file MIME type.
app.post("/api/upload", async (req, res) => {
  try {
    const name = (req.query.name || "file").toString().slice(0, 200);
    const type = req.headers["content-type"] || "application/octet-stream";
    const key = safeKey(name);

    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: req, // the raw request stream — piped directly to R2
        ContentType: type,
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 8, // 8MB parts
    });

    await upload.done();

    res.json({
      url: `${R2_PUBLIC_BASE_URL}/${key}`,
      name,
      key,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: "Upload failed", detail: err.message, stack: err.stack });
  }
});

app.use(express.json());
// Serve static frontend in local dev. On Vercel/Render, static files are served by the platform.
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

function safeKey(originalName) {
  const safe = originalName
    .replace(/[^a-zA-Z0-9.\-_ ]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  const now = new Date();
  const yy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const folder1 = crypto.randomBytes(4).toString("hex"); // 8 hex chars
  const folder2 = crypto.randomBytes(2).toString("hex"); // 4 hex chars
  return `files/${yy}/${mm}/${folder1}/${folder2}/${safe}`;
}

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
        // New format: files/2026/09/a3f8c1d2/9e7b/name.mp4 → name is last segment
        // Old format: 1789689940574-a6a48407-name.mp4 → name is parts 2+
        const segments = key.split("/");
        const name = segments.length > 1
          ? segments[segments.length - 1]
          : (key.split("-").slice(2).join("-") || key);
        return {
          key,
          name,
          size: o.Size,
          url: `${R2_PUBLIC_BASE_URL}/${key}`,
          uploaded: o.LastModified,
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

// Only listen when running as a standalone server (not on Vercel serverless)
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`File share running on http://localhost:${PORT}`);
  });
}

export default app;
