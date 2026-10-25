# Dtray

No-signup file sharing web app. Drop a file, get a public link. Files are stored on Cloudflare R2 and served via a CDN.

Brand: **Dtray** — logo assets live in `public/assets/`, sourced from `Designs/output/dtray/Final`.

## Stack

- Node.js + Express
- `@aws-sdk/client-s3` (R2 is S3-compatible)
- Vanilla HTML/JS frontend — no frameworks, no build step

## Setup

1. Copy `.env.example` to `.env` and fill in your Cloudflare R2 credentials, plus a random `GUEST_SECRET`.
2. `npm install`
3. `npm start`
4. Open http://localhost:3000

## Running it publicly (free, no credit card)

```bash
./start.sh
```

Starts the Express server on :3000 and the Cloudflare named tunnel (`fileshare`) together, serving `https://share.zenvostudios.com`.

The tunnel config lives at `~/.cloudflared/config.yml` with 600s origin timeouts so long chunk uploads don't get cut off.

## Guest accounts

Every visitor gets an anonymous guest account on first visit:

- `POST /api/guest` — creates a guest, returns `guestId` + `token`
- `GET /api/guest/verify` — validates a stored session
- The browser persists the credentials in `localStorage` under `dtray.guest.v1` and restores the same drive on return visits.

Guest state is held in memory on the server (`GUEST_STORE`). Uploads, listings and deletes are all scoped to the requesting guest, and multipart uploads carry a `guest` metadata tag on the R2 object.

This is deliberately shaped so a real account system can replace it later without reworking the upload path — the guest id becomes the account id and the token becomes the session token.

## Endpoints

All file endpoints require the guest headers `x-guest-id` and `x-guest-token`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/guest` | Create a guest account |
| `GET` | `/api/guest/verify` | Validate a guest session |
| `POST` | `/api/upload` | Single-shot upload (files under 20MB) |
| `POST` | `/api/upload/init` | Start a multipart upload |
| `POST` | `/api/upload/chunk` | Upload one part |
| `POST` | `/api/upload/complete` | Finalize the multipart upload |
| `GET` | `/api/files` | List objects in the bucket |
| `DELETE` | `/api/files/:key` | Delete an object |

## Uploads

Files under 20MB go up in one request. Larger files are split into 20MB chunks in the browser and uploaded as an R2 multipart upload.

- 20MB chunks stay well under Cloudflare's 100MB edge body limit.
- 20MB chunks also finish inside Cloudflare's 100s edge connection timeout, which larger chunks exceed (524).
- Each chunk retries up to 3 times with backoff.
- R2 requires multipart objects to be at least 5MiB — the 20MB chunk size clears that comfortably.

## UI

Drive-inspired app shell: sidebar nav, top search, list/grid toggle, per-file action menu, trash, storage meter.

- Flat surfaces, no gradients, no coloured borders on containers.
- Follows system light/dark by default; the toggle pins a theme in `localStorage` under `dtray.theme`.
- Drag-drop anywhere on the page, paste-to-upload, and a copyable error log pinned at the top of the content area.

## Notes

- No login required — the guest account is created automatically.
- The file list auto-refreshes every 15s.
- Downloads are served straight from the CDN (`t-cdn.zenvostudios.com`), so they don't consume tunnel bandwidth.
