# Rutba media server — masters-only, resize-on-request, LRU cache

A Node.js media origin for `images.rutba.pk` (reusable for `images.trustlist.uk`),
built for **Hostinger Node.js hosting** (Business Web Hosting, `77.37.37.27`) or a VPS container.

> This repo (formerly `Rutba-Media-FileServer`) now lives in the Rutba 2.0 workers tier as `workers/media` - see [rutba-workers](https://github.com/eharain/rutba-workers). It remains a standalone, self-contained product.

> **Project layout** — full spec in `SPEC.md`; what's outstanding and in what order
> in **[docs/ROADMAP.md](docs/ROADMAP.md)**.
> - `server.js` / `package.json` — the media service (this README)
> - `provider/` — Strapi upload provider (`strapi-provider-upload-media`)
> - `migrate/` — DB-driven migration (masters-only + `formats` rewrite)
> - `deploy/` — Dockerfile, compose, Caddy snippet, deploy guide
> - `test/` — automated suites: `npm test` (origin, no database) and
>   `npm run test:platform` (platform layer, needs MySQL)
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
- **Video frames & transcodes** (optional, needs ffmpeg — see below):
  - `?poster` (or `?thumb`) on a video → a still frame as an image (supports
    `w`,`h`,`fm`,`q` and `t=<seconds>` for the timestamp, default 1s). Cached like
    an image variant.
  - `?transcode=<height>` (or `?mp4=<height>`) → an on-demand H.264/AAC MP4 scaled
    to that height (144–2160), cached. Heavy; the first request blocks while it
    renders. If ffmpeg is unavailable the original is streamed instead.
- **No params** → master served as-is.

## Multiple storage volumes / mounts (optional)
Masters can be spread across several directories or mounts (extra capacity, tiering,
network shares). `MASTER_DIR` is always volume `default`; add more with
`STORAGE_VOLUMES`:
```
STORAGE_VOLUMES="disk2:/mnt/disk2 archive:/mnt/archive|ro"   # id:path, |ro = read-only
```
- **Reads** search every volume (default first), so a master on any mount is served
  and resized transparently (variants are keyed by URL path, not physical location).
- **New uploads** are placed by `STORAGE_PLACEMENT`:
  `free` (most free space, default) · `fill` (first volume with room) · `route`
  (prefix rules in `STORAGE_ROUTES`, e.g. `STORAGE_ROUTES="archive/=archive"`).
  An existing master is always replaced in place; read-only volumes never receive writes.
- Free/total space per volume is exposed at `GET /_api/storage` (admin) and in the
  console. With no extra volumes this is a single-volume system — identical to before.

## Video & audio processing (optional, ffmpeg)
If an `ffmpeg`/`ffprobe` binary is available the server can extract **video poster
frames** and **transcode** on demand (see the request styles above), and records
**duration/codecs/dimensions** for uploaded video & audio (surfaced in the console
preview and via the DB layer). Binary resolution: `FFMPEG_PATH`/`FFPROBE_PATH` →
the bundled `ffmpeg-static`/`ffprobe-static` packages → `ffmpeg`/`ffprobe` on `PATH`.
Without any binary the feature is simply off — videos stream as-is (with Range),
exactly as before.

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

## Platform layer — accounts · RBAC · metadata · audit (optional)
Point the server at a MySQL database (`DB_HOST=…` or `DB_URL=mysql://…`) to enable a
managed-platform layer on top of the origin: user accounts, roles/permissions,
sessions + API tokens, a searchable file index, an audit trail, and a JSON control
plane under `/_api/*`, and a **web console at `/_ui/`** (file browser + search,
drag-and-drop bulk upload, preview, user management, audit — no build step).
**Fully gated** — with no DB configured the server runs exactly as documented above
(public reads, token-gated writes) and `/_ui/` / `/_api/` are absent. The database and
its schema are created automatically on first boot. See
**[docs/PLATFORM.md](docs/PLATFORM.md)** for env vars, the console, the API surface,
and the **WebDAV mount** (`/_dav/` — map the whole store as a network drive).

## Clustering — share/replicate masters across nodes (optional)
Run several nodes that **share master files** (resized variants are always regenerated
locally on demand, never synced). Each node has a **role** and each file has a
**visibility**, and one rule combines them:

| | public master | private master |
|---|---|---|
| **stored / served / replicated to** | any node | `private`-role nodes only |

- **`CLUSTER_ROLE`** = `public` (internet-facing) or `private` (local/LAN). A
  public-zone node never replicates, accepts, or serves a private master.
- **`CLUSTER_PEERS`** = the sibling nodes, each tagged with its role:
  `CLUSTER_PEERS="https://images.rutba.pk|public http://nas.lan:3000|private"`.
- **`CLUSTER_SECRET`** authenticates node-to-node traffic (separate from `UPLOAD_TOKEN`).

What happens:
- **Replicate on upload (masters only).** A fresh `PUT` fans the master out to the
  peers eligible for its visibility. So a private/LAN node pushes its **public**
  uploads *up* to the public node(s), while a **private** upload stays inside the
  private/LAN zone. `DELETE` propagates the same way. (Replicated writes carry
  `X-Cluster-Replicated:1` so receivers don't re-fan-out — no loops.)
- **Pull on miss.** A node missing a master asks the peers eligible for that
  visibility, persists the hit under `MASTER_DIR`, then serves it — e.g. a private
  node fetches a public master from the public node on first request. Cluster peers
  are tried **before** `ORIGIN_SOURCES`.

**Visibility** is the request path by default — anything under a `PRIVATE_PATHS`
prefix (e.g. `PRIVATE_PATHS="private secure/docs"`) is private. An `X-Visibility:
private|public` header on upload overrides per file and is recorded in a sidecar
(and carried to peers on replication). The path rule is the cross-node authority,
so to keep a file private everywhere, place it under a `PRIVATE_PATHS` prefix.

```
# public, internet-facing node
CLUSTER_ROLE=public  CLUSTER_SECRET=…  CLUSTER_PEERS="http://nas.lan:3000|private"
# private/LAN node
CLUSTER_ROLE=private CLUSTER_SECRET=…  CLUSTER_PEERS="https://images.rutba.pk|public" PRIVATE_PATHS="private"
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
  resolve.js     #   master resolver: exact → prefix+ext-swap → cluster peers → origin
  fetchstore.js  #   download-a-master-and-persist primitive (origin + cluster)
  origin.js      #   OriginFetcher — download a missing master from a source list
  cluster.js     #   Cluster — replicate masters to peers + pull on miss (role/visibility)
  visibility.js  #   public/private rules: PRIVATE_PATHS + X-Visibility sidecar
  storage.js     #   multi-volume masters: placement policy + union reads (optional)
  masterops.js   #   protocol-agnostic master mutations (shared by HTTP + WebDAV)
  ── platform layer (all inert without a database) ──
  db.js          #   optional MySQL pool; degrades to an inert stub when unconfigured
  schema.js      #   idempotent CREATE TABLE statements applied by db.init()
  auth.js        #   scrypt passwords, hashed session/API tokens, RBAC predicates
  fileindex.js   #   best-effort `files` upserts + audit trail on every master write
  trash.js       #   Trash & Recovery — move-to-trash, restore, purge, empty
  metadata.js    #   normalize sharp/EXIF + ffprobe output into file_metadata columns
  ffmpeg.js      #   optional ffmpeg/ffprobe loader (bundled static binaries or PATH)
  mediavariant.js#   video poster frames + on-demand transcodes, cached like variants
  handlers/      #   read.js (GET/HEAD), write.js (PUT/DELETE, auth + replication),
                 #   api.js (/_api), ui.js (/_ui), share.js (/_s), webdav.js (/_dav),
                 #   videos.js (/_api/videos — video listing/folders/scan for the consumer apps)
  app.js         #   createApp(config) → { server, cache } (routing + wiring)
package.json     # deps: sharp, mysql2, exif-reader, ffmpeg-static, ffprobe-static
web/             # web console SPA (index.html + app.js + styles.css, no build step)
docs/            # PLATFORM.md (platform layer reference), ROADMAP.md
public/          # MASTER_DIR by default — put ORIGINAL files here (gitignored)
provider/        # Strapi upload provider (strapi-provider-upload-media)
migrate/         # DB-driven migration (mysql2/pg)
deploy/          # Dockerfile, compose (+ platform overlay), Caddy snippet, guide
test/            # automated suite
nextjs/          # optional <Image> loader
.env.example     # every environment variable, grouped by feature
```
> `server.js` **and** `src/` are both required at deploy time, and `web/` too if you
> want the console (the Dockerfile copies all three; Hostinger needs them alongside
> the startup file).
> The app is also exported (`require('./server.js')` → `{ createApp, loadConfig }`)
> so it can be embedded or driven from tests without spawning a process.

## Develop & test
```bash
npm install            # installs sharp at the repo root (the server needs it)
npm test               # origin suite — no database; proves the gated layers stay off
npm run test:videos    # /_api/videos control plane — stubbed services, no MySQL, no server
npm run test:platform  # platform suite — needs MySQL (see below)
npm run test:all       # all three
```
Each suite prints its own check total, so no comment, README line or CI step can
drift from the real number.

The platform suite creates a **throwaway database per run and drops it afterwards**,
so it never touches an existing one. Point it at any MySQL you don't mind it
connecting to; `DB_NAME` is deliberately ignored:
```bash
DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=secret npm run test:platform
```
With no `DB_HOST` set it prints a skip notice and exits 0, so a machine without
MySQL still runs `npm test` cleanly.

> Both suites spawn `server.js` as its own process, which resolves `sharp` from the
> **repo root**, so `npm install` at the root is required first (CI does this — see
> `.github/workflows/ci.yml`, which runs the two suites as separate jobs across
> Node 18/20/22).

## Deploy on Hostinger (hPanel → Node.js app)
1. **hPanel → `images.rutba.pk` → Node.js** (Setup Node.js App).
2. **Node 18+**, **startup file `server.js`**, **app root** = your upload folder, URL `images.rutba.pk`.
3. Upload `server.js`, `package.json`, the whole **`src/`** folder and — if you want the
   web console — **`web/`**; click **Run NPM Install** (installs `sharp`).
   All four are required at runtime: `src/` is the service itself, and `/_ui/` is served
   from `web/`.
4. Put **original** files in `public/` (or set `MASTER_DIR`). Create nothing for the cache — it's auto-made.
5. **Start/Restart**. Hostinger sets `PORT` and proxies the domain.

Verify:
```
curl -I  https://images.rutba.pk/_health
curl -sI 'https://images.rutba.pk/<name>.jpg?w=300&fm=webp'   # 200 image/webp
curl -r 0-1023 -sD - -o /dev/null https://images.rutba.pk/<name>.mp4  # 206
```

## Env config
> **[`.env.example`](.env.example) is the complete reference** — every variable,
> grouped by feature, with each optional block marked as gated. The table below
> covers the origin itself; the platform-layer vars are documented in
> [docs/PLATFORM.md](docs/PLATFORM.md) and repeated in `.env.example`.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | (Hostinger) | listen port |
| `HOST` | `0.0.0.0` | listen address |
| `UPLOAD_DIR` | `./public` | originals/masters dir — where the actual files live. Aliases: `MASTER_DIR`, `MEDIA_DIR` (first one set wins). A leading `~` expands, e.g. `UPLOAD_DIR=~/uploads/trustlist/` |
| `CACHE_DIR` | `./.cache` | variant cache dir |
| `CACHE_MAX_BYTES` | `1073741824` (1 GiB) | cache cap before LRU eviction |
| `IMAGE_QUALITY` | `80` | default output quality |
| `MAX_DIM` | `4000` | max requested width/height |
| `VARIANTS` | `{"thumbnail":245,"xsmall":64,"small":500,"medium":750,"large":1000,"xlarge":1920}` | Strapi prefix→width (mirrors Strapi breakpoints) |
| `UPLOAD_MAX_BYTES` | `268435456` (256 MiB) | max PUT body; over → 413. Alias `SIZE_LIMIT`; `0` disables |
| `ORIGIN_SOURCES` | (none) | space/comma-separated base URLs to pull a missing master from (then cache under `MASTER_DIR`). Empty → 404 on miss |
| `ORIGIN_TIMEOUT_MS` | `10000` | per-request timeout for origin fetches |
| `CLUSTER_ROLE` | `public` | this node's zone: `public` (internet-facing) or `private` (local/LAN). Gates which masters it replicates, accepts, and serves. Alias `NODE_VISIBILITY` |
| `CLUSTER_PEERS` | (none) | sibling nodes, space/comma-separated; each `<baseUrl>` or `<baseUrl>\|<role>` (role `public`/`private`, default `public`). Empty → clustering off |
| `CLUSTER_SECRET` | (none) | shared secret for node-to-node traffic (replication writes + private pulls). Distinct from `UPLOAD_TOKEN` |
| `CLUSTER_TIMEOUT_MS` | `ORIGIN_TIMEOUT_MS` or `10000` | per-request timeout for peer pulls/replication |
| `PRIVATE_PATHS` | (none) | space/comma-separated path prefixes whose masters are private (segment-aware). An `X-Visibility` header on upload overrides per file |
| `CORS_ORIGIN` | `*` | restrict if desired |
| `STORAGE_VOLUMES` | (none) | extra master volumes, `id:path` or `id:path\|ro`. Empty → single-volume |
| `STORAGE_PLACEMENT` | `free` | new-file placement: `free` \| `fill` \| `route` |
| `STORAGE_ROUTES` | (none) | prefix→volume rules for `route` placement, e.g. `archive/=archive` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | (bundled) | explicit binaries; else `ffmpeg-static`/`ffprobe-static`, else `PATH`. None → video processing off |
| `DB_HOST` … `DB_NAME` | (none) | **master switch for the platform layer.** `MYSQL_*` aliases work; `DB_URL` accepted. Unset → no accounts/`_api`/`_ui`/`_s`/`_dav`/trash |
| `DB_CONNECT_RETRIES` | `0` | boot-time connect retries (1s apart) before degrading to origin-only |
| `TRASH_DIR` | sibling of `MASTER_DIR` | recoverable deletes. **Set explicitly in containers** so it maps to a persistent volume |
| `ALLOW_REGISTRATION` | `0` | open self-service registration (the first account is always allowed) |
| `SESSION_TTL_DAYS` | `30` | session lifetime |
| `READ_AUTH_MODE` | `public` | `public` \| `mixed` \| `private` — see docs/PLATFORM.md |
| `WEBDAV_ENABLED` | `1` (with DB) | the `/_dav/` mount |

## Migration / integration (next steps)
- Copy **only masters** from the VPS Strapi uploads to `MASTER_DIR` — i.e. exclude
  `thumbnail_* small_* medium_* large_*`. That alone drops the file count from ~30k to ~5.4k.
- Point the apps' image origin at this host (`NEXT_PUBLIC_IMAGE_URL=https://images.rutba.pk`,
  Strapi upload `PUBLIC_URL`/provider) so `…/uploads/small_x.jpg` and `?w=` both resolve here.
- Optionally disable Strapi's responsive-breakpoint generation so new uploads store the master only.

## License & ownership
Dual-licensed under the GNU AGPL v3.0 (see [LICENSE](LICENSE)) and a
separate commercial license — see [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).
Copyright (C) 2026 Tech Style Ltd — [tech-style.co](https://tech-style.co).
Maintainer: Ejaz Arain &lt;eharain@yahoo.com&gt;. Commercial licensing: hello@tech-style.co.
