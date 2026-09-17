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
