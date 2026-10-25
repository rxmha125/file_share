import "dotenv/config";
import express from "express";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
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
const GUEST_SECRET = process.env.GUEST_SECRET || "dtray-dev-secret-change-me";

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

// Dtray is a private drive, not a public site. Keep it out of search engines:
// X-Robots-Tag covers every response (including /api and file redirects) even
// where a crawler ignores robots.txt or never sees the HTML <meta> tags.
app.use((req, res, next) => {
  res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive, nosnippet, noimageindex");
  next();
});

// ---------------------------------------------------------------------------
// Guest identity
//
// Today a visitor gets an anonymous guest account. The server issues a signed
// guest id + token, the browser stores it, and every upload/list/delete is
// scoped to that guest. When real accounts arrive later, this becomes the
// session layer — the ownership model below is already the right shape.
// ---------------------------------------------------------------------------
const GUEST_STORE = new Map(); // guestId -> { token, created, files:Set }
const GUEST_TTL = 1000 * 60 * 60 * 24 * 365; // 1 year

function newGuestId() {
  return "g_" + crypto.randomBytes(12).toString("hex");
}

function newToken() {
  return crypto.randomBytes(24).toString("hex");
}

function signGuest(guestId) {
  return crypto.createHmac("sha256", GUEST_SECRET).update(guestId).digest("hex");
}

function createGuest() {
  const id = newGuestId();
  const token = newToken();
  GUEST_STORE.set(id, { token, created: Date.now(), files: new Set() });
  return { id, token, created: Date.now() };
}

function getGuest(req) {
  const id = req.get("x-guest-id");
  const token = req.get("x-guest-token");
  if (!id || !token) return null;
  const rec = GUEST_STORE.get(id);
  if (!rec) return null;
  if (rec.token !== token) return null;
  if (Date.now() - rec.created > GUEST_TTL) return null;
  return { id, ...rec };
}

function requireGuest(req, res, next) {
  const g = getGuest(req);
  if (!g) {
    return res.status(401).json({ error: "Guest session invalid or expired", code: "NO_GUEST" });
  }
  req.guest = g;
  next();
}

// In-memory tracking of multipart uploads (uploadId → parts)
const activeUploads = new Map();

// ---------------------------------------------------------------------------
// Guest session endpoints
// ---------------------------------------------------------------------------

// Create (or re-create) a guest account. The browser calls this on first
// visit and persists the returned credentials locally.
app.post("/api/guest", (req, res) => {
  try {
    const guest = createGuest();
    res.json({
      guestId: guest.id,
      token: guest.token,
      created: guest.created,
      signature: signGuest(guest.id),
    });
  } catch (err) {
    console.error("Guest create error:", err);
    res.status(500).json({ error: "Could not create guest session", detail: err.message });
  }
});

// Validate the stored guest credentials. The client calls this on boot to
// confirm its saved session is still good before showing the app.
app.get("/api/guest/verify", requireGuest, (req, res) => {
  res.json({
    guestId: req.guest.id,
    created: req.guest.created,
    fileCount: req.guest.files.size,
  });
});

// ---------------------------------------------------------------------------
// Multipart upload (large files)
// ---------------------------------------------------------------------------

// 1. Client calls this to start a multipart upload — server returns uploadId + key
app.post("/api/upload/init", requireGuest, async (req, res) => {
  try {
    const name = (req.query.name || "file").toString().slice(0, 200);
    const type = req.query.type || "application/octet-stream";
    const key = safeKey(name);

    const multi = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
        ContentType: type,
        Metadata: { guest: req.guest.id },
      })
    );

    const uploadId = multi.UploadId;
    activeUploads.set(uploadId, { key, parts: [], name, type, guestId: req.guest.id });

    res.json({ uploadId, key, name });
  } catch (err) {
    console.error("Init error:", err);
    res.status(500).json({ error: "Init failed", detail: err.message });
  }
});

// 2. Client sends each chunk as a separate POST — body is raw chunk bytes, never exceeds 90MB
app.post("/api/upload/chunk", requireGuest, async (req, res) => {
  try {
    const uploadId = req.query.uploadId;
    const partNumber = parseInt(req.query.part, 10);
    const meta = activeUploads.get(uploadId);

    if (!meta) {
      return res.status(400).json({ error: "Invalid or expired uploadId" });
    }
    if (meta.guestId !== req.guest.id) {
      return res.status(403).json({ error: "Upload belongs to another session" });
    }

    // Collect the chunk body into a buffer (max 90MB — under Cloudflare's 100MB limit)
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    const result = await s3.send(
      new UploadPartCommand({
        Bucket: R2_BUCKET_NAME,
        Key: meta.key,
        PartNumber: partNumber,
        UploadId: uploadId,
        Body: body,
      })
    );

    meta.parts.push({ PartNumber: partNumber, ETag: result.ETag });

    res.json({ partNumber, etag: result.ETag, size: body.length });
  } catch (err) {
    console.error("Chunk error:", err);
    res.status(500).json({ error: "Chunk upload failed", detail: err.message });
  }
});

// 3. Client calls this when all chunks are done — server completes the multipart upload
app.post("/api/upload/complete", requireGuest, async (req, res) => {
  try {
    const uploadId = req.query.uploadId;
    const meta = activeUploads.get(uploadId);

    if (!meta) {
      return res.status(400).json({ error: "Invalid or expired uploadId" });
    }
    if (meta.guestId !== req.guest.id) {
      return res.status(403).json({ error: "Upload belongs to another session" });
    }

    // Sort parts by part number before completing
    const parts = meta.parts.sort((a, b) => a.PartNumber - b.PartNumber);

    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: R2_BUCKET_NAME,
        Key: meta.key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts,
        },
      })
    );

    activeUploads.delete(uploadId);
    req.guest.files.add(meta.key);

    res.json({
      url: `${R2_PUBLIC_BASE_URL}/${meta.key}`,
      name: meta.name,
      key: meta.key,
    });
  } catch (err) {
    console.error("Complete error:", err);
    // Try to abort the multipart upload to clean up
    try {
      const meta = activeUploads.get(req.query.uploadId);
      if (meta) {
        await s3.send(
          new AbortMultipartUploadCommand({
            Bucket: R2_BUCKET_NAME,
            Key: meta.key,
            UploadId: req.query.uploadId,
          })
        );
        activeUploads.delete(req.query.uploadId);
      }
    } catch {}
    res.status(500).json({ error: "Complete failed", detail: err.message });
  }
});

// Old single-shot upload (kept for small files under 90MB — skips chunking overhead)
app.post("/api/upload", requireGuest, async (req, res) => {
  try {
    const name = (req.query.name || "file").toString().slice(0, 200);
    const type = req.headers["content-type"] || "application/octet-stream";
    const key = safeKey(name);

    const { Upload } = await import("@aws-sdk/lib-storage");
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: R2_BUCKET_NAME,
        Key: key,
        Body: req,
        ContentType: type,
        Metadata: { guest: req.guest.id },
      },
      queueSize: 4,
      partSize: 1024 * 1024 * 8,
    });

    await upload.done();
    req.guest.files.add(key);

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

// List files — scoped to the requesting guest's own uploads
app.get("/api/files", requireGuest, async (req, res) => {
  try {
    const data = await s3.send(
      new ListObjectsV2Command({
        Bucket: R2_BUCKET_NAME,
        MaxKeys: 1000,
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
app.delete("/api/files/:key", requireGuest, async (req, res) => {
  try {
    const key = decodeURIComponent(req.params.key);
    await s3.send(
      new DeleteObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,
      })
    );
    req.guest.files.delete(key);
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
