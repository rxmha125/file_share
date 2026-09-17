# file_share

No-auth file sharing web app. Drop a file, get a public link. Files are stored on Cloudflare R2 and served via your CDN.

## Stack

- Node.js + Express
- `@aws-sdk/client-s3` (R2 is S3-compatible)
- Multer for upload buffering
- Vanilla HTML/JS frontend — no frameworks, no build step

## Setup

1. Copy `.env.example` to `.env` and fill in your Cloudflare R2 credentials.
2. Install deps:
   ```
   npm install
   ```
3. Run:
   ```
   npm start
   ```
4. Open http://localhost:3000

## Endpoints

- `POST /api/upload` — multipart upload (`file` field), up to 2GB
- `GET /api/files` — list objects in the bucket
- `DELETE /api/files/:key` — delete an object

## Notes

- No auth. Anyone with the URL can upload and delete.
- The frontend follows system light/dark mode, auto-refreshes the file list every 15s, supports drag-drop and paste-to-upload.
- Errors (upload failed, CORS, network) are shown in a copyable log panel at the top of the page.

## R2 CORS setup (required for presigned uploads)

The browser uploads files **directly to R2** via a presigned PUT URL, which is a cross-origin request. You must configure CORS on the bucket in the Cloudflare dashboard:

**Cloudflare Dashboard → R2 → `moongram-images` → Settings → CORS Policy → Add rule:**

| Field | Value |
|---|---|
| Allowed Origins | `*` (or your Vercel domain) |
| Allowed Methods | `GET`, `PUT`, `HEAD` |
| Allowed Headers | `*` |
| Expose Headers | `ETag` |
| Max Age Seconds | `3600` |

Without this, uploads fail with a CORS preflight error in the browser console.

## Deploying to Vercel

1. Push to `main` — Vercel auto-deploys.
2. Set the 6 `R2_*` environment variables in Vercel (Project → Settings → Environment Variables).
3. Ensure R2 CORS is configured (above).
