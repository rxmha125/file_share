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

Guest state is held in memory on the server (`GUEST_STORE`). Uploads and deletes require a valid guest session, and multipart uploads carry a `guest` metadata tag on the R2 object.

**Current limitation:** `GET /api/files` lists every object in the bucket, not just the caller's. That is deliberate for now — the drive is effectively shared, and existing files predate guest tagging, so filtering by guest would hide them. Scoping the listing per guest is the next step once the tag is backfilled; see `requireGuest` and the `Metadata: { guest }` on upload in `server.js`.

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

- Two-tone shell — the sidebar and topbar share one surface and read as a single connected frame; content sits on a darker inset panel with a 16px top radius.
- Flat surfaces, no gradients, no coloured borders on containers. The only shadows are on the popup menu and the upload tray.
- Icons are **[Hugeicons](https://hugeicons.com)** (stroke-rounded, free set), compiled into an inline SVG sprite. See below.
- Follows system light/dark by default; the toggle pins a theme in `localStorage` under `dtray.theme`.
- Drag-drop anywhere on the page, paste-to-upload, and a copyable error banner at the top of the content area.

## Icons

Icons come from `@hugeicons/core-free-icons` and are compiled to a `<symbol>` sprite that gets inlined into `public/index.html` between the `ICON_SPRITE:START` / `ICON_SPRITE:END` markers.

```bash
npm install          # pulls the devDependency
npm run icons        # rebuild public/assets/icons.sprite.html + re-inline it
```

To add an icon, add an entry to the `ICONS` map in `tools/build_icons.mjs` (sprite id → Hugeicons module name) and re-run `npm run icons`. The sprite is committed, so the app runs without the package installed.

## Brand assets

`public/assets/` holds the web-ready Dtray lockups. They are generated from the approved source artwork by `tools/prep_assets.py`, which crops the transparent margins and emits:

- `dtray-logo-dark-text.png` — for light backgrounds
- `dtray-logo-white-text.png` — for dark backgrounds (the wordmark must flip with the theme)
- `dtray-symbol*.png` — the mark alone, at several sizes
- `favicon.png`

## Notes

- No login required — the guest account is created automatically.
- The file list auto-refreshes every 15s.
- Downloads are served straight from the CDN (`t-cdn.zenvostudios.com`), so they don't consume tunnel bandwidth.
