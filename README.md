# Rutba media server — masters-only, resize-on-request, LRU cache

A Node.js media origin for `images.rutba.pk` (reusable for `images.trustlist.uk`),
built for **Hostinger Node.js hosting** (Business Web Hosting, `77.37.37.27`) or a VPS container.

> **Project layout** — full spec in `SPEC.md`.
> - `server.js` / `package.json` — the media service (this README)
> - `provider/` — Strapi upload provider (`strapi-provider-upload-media`)
> - `migrate/` — DB-driven migration (masters-only + `formats` rewrite)
> - `deploy/` — Dockerfile, compose, Caddy snippet, deploy guide
> - `test/` — automated suite (`cd test && npm install && node test.js`) — 22/22 passing
> - `nextjs/` — optional `<Image>` custom loader for the drop-formats path

**Why:** Strapi pre-generates `thumbnail_/small_/medium_/large_` variants for every
image — e.g. 5,428 originals → ~30k files / 4.9 GB. This server keeps **only the master
files** and **resizes on request**, caching hot variants with **LRU rotation**, so disk
stays small.

## How it works
- **`MASTER_DIR`** — originals only (source of truth).
- **`CACHE_DIR`** — generated variants; size-capped (`CACHE_MAX_BYTES`), least-recently-used
  files evicted to ~80% when full. Every cache hit "touches" the file → true LRU.
- Resize via **`sharp`**; never upscales; preserves aspect ratio. Videos / SVG / non-raster
  files stream straight from `MASTER_DIR` with **HTTP Range** (seeking), never resized.
- CORS `*`, `Cache-Control: immutable`, path-traversal protected, HEAD/OPTIONS/`/_health`.

## Request styles (both supported)
- **Query params** (modern):
  `/<path>?w=300&h=300&fit=cover&q=80&fm=webp`
  - `w`,`h` px (one or both); `fit` = `inside|cover|contain|outside|fill` (default `inside`)
  - `q` 1–100 (default 80); `fm` = `jpeg|png|webp|avif|auto` (`auto` honors `Accept`)
- **Strapi-compatible prefixes** (drop-in for existing URLs):
  `/uploads/small_<name>.jpg` → resizes master `/uploads/<name>.jpg` to the `small` width.
  Prefix→width map (default, mirrors Strapi's breakpoints + thumbnail):
  `thumbnail=245, xsmall=64, small=500, medium=750, large=1000, xlarge=1920`
  (override via `VARIANTS` env, JSON).
  - **Extension-swap:** the requested extension is a hint — if `<name>.<reqExt>`
    isn't on disk, the same base name is tried against the known master formats,
    so `/small_x.webp` resolves to master `x.jpg`. Output keeps the **master's own
    format** (no transcode); use `?fm=` to convert explicitly.
- **No params** → master served as-is.

## Missing masters → origin pull-through (optional)
When a requested master isn't on disk and `ORIGIN_SOURCES` is set, the server downloads
it from the first source that has it (trying the same name/format candidates as the
extension-swap), **persists it under `MASTER_DIR`**, then serves the requested size. On a
cold miss the master is fetched once and thereafter behaves like any local master. If no
source is configured, or none has the file, the response is `404`. Only the configured
allow-list of base URLs is ever fetched, at traversal-safe paths.
```
ORIGIN_SOURCES="https://bucket.s3.amazonaws.com https://old-strapi.example/uploads"
```

## Files
```
server.js        # entrypoint — loads config, wires the app, starts listening (node>=18)
src/             # the media service, split for reuse/testing:
  config.js      #   loadConfig(env) → immutable runtime config
  constants.js   #   MIME map, raster set, format→ext table
  sharp.js       #   optional sharp loader (degrades if missing)
  util.js        #   ~ expansion, safe path resolution, parse/hash helpers
  http.js        #   CORS headers, plain responses, Range-aware streamFile
  cache.js       #   VariantCache — on-disk LRU (size cap + eviction)
  resizer.js     #   VariantResizer — resize-on-request + concurrency de-dupe
  resolve.js     #   master resolver: exact → prefix+ext-swap → origin pull-through
  origin.js      #   OriginFetcher — download a missing master from a source list
  handlers/      #   read.js (GET/HEAD), write.js (PUT/DELETE, auth)
  app.js         #   createApp(config) → { server, cache } (routing + wiring)
package.json     # dep: sharp; `npm start` → node server.js
public/          # MASTER_DIR by default — put ORIGINAL files here (gitignored)
provider/        # Strapi upload provider (strapi-provider-upload-media)
migrate/         # DB-driven migration (mysql2/pg)
deploy/          # Dockerfile, compose, Caddy snippet, deploy guide
test/            # automated suite (17 checks)
nextjs/          # optional <Image> loader
```
> `server.js` + `src/` are both required at deploy time (e.g. the Dockerfile copies
> both, and Hostinger needs the whole `src/` folder alongside the startup file).
> The app is also exported (`require('./server.js')` → `{ createApp, loadConfig }`)
> so it can be embedded or driven from tests without spawning a process.

## Develop & test
```bash
npm install            # installs sharp at the repo root (the server needs it)
npm test               # runs the 22-check suite (installs test deps first)
```
> The suite spawns `server.js` as its own process, which resolves `sharp` from the
> **repo root**, so `npm install` at the root is required before `npm test`
> (CI does this — see `.github/workflows/ci.yml`).

## Deploy on Hostinger (hPanel → Node.js app)
1. **hPanel → `images.rutba.pk` → Node.js** (Setup Node.js App).
2. **Node 18+**, **startup file `server.js`**, **app root** = your upload folder, URL `images.rutba.pk`.
3. Upload `server.js` + `package.json`; click **Run NPM Install** (installs `sharp`).
4. Put **original** files in `public/` (or set `MASTER_DIR`). Create nothing for the cache — it's auto-made.
5. **Start/Restart**. Hostinger sets `PORT` and proxies the domain.

Verify:
```
curl -I  https://images.rutba.pk/_health
curl -sI 'https://images.rutba.pk/<name>.jpg?w=300&fm=webp'   # 200 image/webp
curl -r 0-1023 -sD - -o /dev/null https://images.rutba.pk/<name>.mp4  # 206
```

## Env config
| Var | Default | Purpose |
|---|---|---|
| `PORT` | (Hostinger) | listen port |
| `UPLOAD_DIR` | `./public` | originals/masters dir — where the actual files live. Aliases: `MASTER_DIR`, `MEDIA_DIR` (first one set wins). A leading `~` expands, e.g. `UPLOAD_DIR=~/uploads/trustlist/` |
| `CACHE_DIR` | `./.cache` | variant cache dir |
| `CACHE_MAX_BYTES` | `1073741824` (1 GiB) | cache cap before LRU eviction |
| `IMAGE_QUALITY` | `80` | default output quality |
| `MAX_DIM` | `4000` | max requested width/height |
| `VARIANTS` | `{"thumbnail":245,"xsmall":64,"small":500,"medium":750,"large":1000,"xlarge":1920}` | Strapi prefix→width (mirrors Strapi breakpoints) |
| `UPLOAD_MAX_BYTES` | `268435456` (256 MiB) | max PUT body; over → 413. Alias `SIZE_LIMIT`; `0` disables |
| `ORIGIN_SOURCES` | (none) | space/comma-separated base URLs to pull a missing master from (then cache under `MASTER_DIR`). Empty → 404 on miss |
| `ORIGIN_TIMEOUT_MS` | `10000` | per-request timeout for origin fetches |
| `CORS_ORIGIN` | `*` | restrict if desired |

## Migration / integration (next steps)
- Copy **only masters** from the VPS Strapi uploads to `MASTER_DIR` — i.e. exclude
  `thumbnail_* small_* medium_* large_*`. That alone drops the file count from ~30k to ~5.4k.
- Point the apps' image origin at this host (`NEXT_PUBLIC_IMAGE_URL=https://images.rutba.pk`,
  Strapi upload `PUBLIC_URL`/provider) so `…/uploads/small_x.jpg` and `?w=` both resolve here.
- Optionally disable Strapi's responsive-breakpoint generation so new uploads store the master only.
