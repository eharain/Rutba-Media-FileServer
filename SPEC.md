# Rutba/TrustList Media File Server — Specification

## 1. Purpose & context
Two Strapi-backed sites — **rutba.pk** (ERP) and **trustlist.uk** — store media bloated by
Strapi's pre-generated responsive variants (`thumbnail_/small_/medium_/large_`): e.g. ~5.4k
originals → ~30k files / 4.9 GB. trustlist additionally used **AWS S3**; rutba.pk uses the
**local** Strapi provider.

This file server replaces that with **masters-only storage + resize-on-request + LRU cache**,
fronted by a **custom Strapi upload provider**, serving `images.rutba.pk` and
`images.trustlist.uk` (Hostinger Business hosting, IP `77.37.37.27`, Node.js app on
`process.env.PORT`; or a VPS container behind Caddy).

All pieces are implemented and tested (see §9). Project layout:
```
server.js, package.json, README.md   media service (sharp-only)
provider/                            Strapi upload provider (strapi-provider-upload-media)
migrate/                             DB-driven migration (mysql2/pg)
deploy/                              Dockerfile + compose + Caddy snippet + deploy README
test/                                automated suite (26 checks)
nextjs/                              optional <Image> custom loader (drop-formats path)
SPEC.md
```

## 2. Components
1. **Media service** (`server.js`) — HTTP server, zero runtime deps except `sharp`. ✅
2. **Strapi upload provider** (`provider/` → npm name `strapi-provider-upload-media`). ✅
3. **Migration script** (`migrate/migrate.js`) — DB-driven move of existing media to
   masters-only + `formats` rewrite. ✅ (MySQL + Postgres, `--dry-run`, idempotent).

## 3. Media service — functional spec
**Storage:** `MASTER_DIR` holds originals only. `CACHE_DIR` holds generated variants,
size-capped at `CACHE_MAX_BYTES` (default 1 GiB), **LRU-evicted** to ~80% when exceeded;
every cache hit touches the file (true LRU).

**Reads (public):**
- `GET /<path>` → serve master as-is. Non-raster/video/SVG stream with **HTTP Range** (206), never resized.
- `GET /<path>?w=&h=&fit=&q=&fm=` → resize on the fly, cache, serve.
  - `fit` ∈ `inside|cover|contain|outside|fill` (default `inside`, never upscales).
  - `fm` ∈ `jpeg|png|webp|avif|auto` (`auto` honors `Accept`). `q` 1–100 (default 80).
- `GET /<dir>/small_<name>.ext` → Strapi-prefix convenience: resize master `<name>` to the
  `small` width (map mirrors Strapi breakpoints + thumbnail:
  `thumbnail=245,xsmall=64,small=500,medium=750,large=1000,xlarge=1920`, override via `VARIANTS`).
  *Note:* prefix mapping only works when master and variant share a dir/name; the provider
  and migration instead emit `?w=` URLs, which are authoritative.
  - **Extension-swap:** the requested extension is a hint — if `<name>.<reqExt>` is absent,
    the same base name is tried against the known master formats (so `/small_x.webp` resolves
    to master `x.jpg`). Output keeps the **master's own format** (no transcode); `?fm=` still
    forces conversion.
- **Origin pull-through (optional, `ORIGIN_SOURCES`):** when a master is missing locally, it
  is downloaded from the first configured source that has it (trying the same name/format
  candidates), **persisted under `MASTER_DIR`**, then served at the requested size. No sources
  / all miss → `404`. Only the configured allow-list is fetched, at traversal-safe paths.
- **Cluster pull-through (optional, `CLUSTER_PEERS`):** tried **before** origin sources — a
  missing master is pulled from a sibling node eligible for the file's visibility (see §3a).
- `GET /_health` → `200 ok`.

**Writes (require `Authorization: Bearer $UPLOAD_TOKEN` **or** `X-Cluster-Secret:
$CLUSTER_SECRET`):**
- `PUT /<path>` (body = bytes) → store/replace a master atomically; invalidate that master's
  cached variants; replicate to eligible peers (see §3a).
- `DELETE /<path>` → remove master + purge its cached variants; propagate to peers. Idempotent (204).
- PUT bodies over `UPLOAD_MAX_BYTES` (alias `SIZE_LIMIT`, default 256 MiB, mirrors Strapi's
  `sizeLimit`; `0` disables) are rejected with **413** — checked up-front via `Content-Length`
  and mid-stream for chunked/mislabeled bodies.

**Headers:** CORS (`CORS_ORIGIN`, default `*`), `Cache-Control: public, max-age=31536000,
immutable`, `Accept-Ranges`, `X-Content-Type-Options: nosniff`. Path-traversal protected;
never serve `server.js`/dotfiles or visibility sidecars (`*.vis`).

**Env:** `PORT HOST UPLOAD_DIR CACHE_DIR CACHE_MAX_BYTES IMAGE_QUALITY MAX_DIM VARIANTS
CORS_ORIGIN UPLOAD_TOKEN UPLOAD_MAX_BYTES ORIGIN_SOURCES ORIGIN_TIMEOUT_MS CLUSTER_ROLE
CLUSTER_PEERS CLUSTER_SECRET CLUSTER_TIMEOUT_MS PRIVATE_PATHS` (`UPLOAD_DIR` aka
`MASTER_DIR`/`MEDIA_DIR`; `UPLOAD_MAX_BYTES` aka `SIZE_LIMIT`; `CLUSTER_ROLE` aka
`NODE_VISIBILITY`; `ORIGIN_SOURCES`/`CLUSTER_PEERS`/`PRIVATE_PATHS` = space/comma-separated,
default off; dir vars expand a leading `~`). Degrades to serving masters unresized if `sharp`
is missing.

## 3a. Clustering & visibility
Multiple nodes **share master files** (variants are always regenerated locally, never synced).
- **Node role** (`CLUSTER_ROLE` = `public` | `private`): `public` is internet-facing,
  `private` is local/LAN. A public-zone node never replicates, accepts, or serves a private master.
- **File visibility** (`public` | `private`): the request path by default — under any
  `PRIVATE_PATHS` prefix (segment-aware) ⇒ private. An `X-Visibility` header on upload overrides
  per file and is persisted in a `<master>.vis` sidecar (carried to peers on replication). The
  **path rule is the cross-node authority** (a not-yet-present master is classed by its path).
- **Eligibility rule** — a master of a given visibility may be stored/served/replicated to:
  public ⇒ any peer; private ⇒ `private`-role peers only, and only on a `private`-role node.
- **Replicate on write:** a fresh `PUT`/`DELETE` fans out to eligible peers (masters only). So a
  private/LAN node pushes its **public** uploads up to public node(s); **private** uploads stay
  in the private/LAN zone. Replicated writes carry `X-Cluster-Replicated:1` so receivers don't
  re-fan-out (loop-free).
- **Pull on miss:** a missing master is fetched from eligible peers (before `ORIGIN_SOURCES`),
  persisted, then served.
- **Auth:** `CLUSTER_SECRET` (header `X-Cluster-Secret`) authorizes node-to-node writes and
  private pulls — distinct from the public `UPLOAD_TOKEN`. `CLUSTER_PEERS` entries are
  `<baseUrl>[|role]` (role default `public`).

## 4. Strapi provider spec (`strapi-provider-upload-media`)
- `upload`/`uploadStream`: **master** → `PUT {baseUrl}/{folder}/{hash}{ext}`; **responsive
  variant** (`/^(thumbnail|small|medium|large)_/`) → NOT stored; sets
  `file.url = {masterUrl}?w={width}&fm={ext}` (remembers each master's URL by hash, since
  Strapi uploads the master just before its formats).
- `delete`: `DELETE {baseUrl}/{hash}{ext}` (purges the master's cached variants).
- Folder paths normalized (`"/277"` → `277`).
- Config: `provider:'strapi-provider-upload-media'`,
  `providerOptions:{ baseUrl, uploadToken, skipVariants:true }`; add media host to
  `strapi::security` CSP `img-src`/`media-src`.

## 5. Data shapes the migration MUST handle (verified real samples)
**S3 (trustlist):** master `https://trustlistdev.s3.eu-west-2.amazonaws.com/general/cover/cover-2344-Seoul_1_a.jpg`
(folder, original ext); variants at **bucket root**, **`.webp`**, named `thumbnail_<masterhash>.webp`.
S3 objects are **publicly downloadable** (no AWS creds needed).

**Local (rutba.pk):** relative urls `/uploads/277/...`, folder `/277`, variants **in the same
folder**, custom names `rutba.pk-<size>-<name>.jpeg` (e.g. `rutba.pk-large-Milky_dyeable_laces-0.jpeg`).

Variant filenames differ per provider — **the migration must not depend on them.** Each
Strapi `files` row already carries the master `url` + every format's `width`/`height`/`ext`.

## 6. Migration spec (DB-driven, provider-agnostic) — TO BUILD
For each row in Strapi's `files` table:
1. Resolve the **master** bytes from `row.url` (S3 = HTTP GET; local = read the Strapi uploads
   volume) and **PUT** it to the media service at a stable key (preserve folder, e.g.
   `general/cover/<hash>.jpg` or `uploads/277/<name>.jpeg`).
2. Rewrite `row.url` → media base + key.
3. Rewrite `row.formats` to be **small**:
   - *Compact* (default, zero frontend change): per size keep only
     `{ url: "<master>?w=<width>&fm=<ext>", width, height }`.
   - *Drop* (smallest): `formats = null` (requires frontend to build `?w=` URLs).
4. **Skip** variant objects entirely.
Idempotent + resumable (track migrated rows); dry-run mode; per-site (rutba.pk local,
trustlist S3). Needs DB access (or a dump) for each site; trustlist's Strapi/DB location TBD.

## 7. Keeping `formats` small
On-the-fly resize makes the full `formats` blob (4 sizes × ~10 fields) redundant. Prefer
**drop** (`breakpoints: {}` for new uploads + `formats=null`, frontend uses a Next.js image
loader appending `?w=`) or **compact** (`{url,width,height}`, zero frontend change). Reduce
breakpoint count for new uploads regardless.

## 8. Deployment targets
- **Hostinger Business hosting** (`images.rutba.pk`/`images.trustlist.uk` → `77.37.37.27`):
  hPanel Node.js app, startup `server.js`, Node 18+, Run NPM Install (for `sharp`), upload
  masters to `MASTER_DIR`. Needs SSH/FTP.
- **VPS** (alternative): Docker container behind Caddy reading the Strapi masters volume;
  point `images.rutba.pk` at the VPS. No file migration, more CPU. (TO BUILD: Dockerfile +
  compose/Caddy snippet.)

## 9. Tech & acceptance
- Node ≥18, `sharp` only runtime dep. No framework.
- **Acceptance — `test/test.js`, 26/26 passing:** health; provider stores master; provider
  skips variant bytes → `{master}?w=&fm=`; master served full size; `?w=` resizes (aspect
  kept, no upscale); `fm=webp` converts; provider variant URL resolves; Strapi-prefix
  variants resolve (`small`, `xsmall`); prefix extension-swap (`small_x.webp` → master `x.jpg`,
  kept jpeg); video Range → 206; `PUT`/`DELETE` → 401 without token; oversize `PUT` → 413;
  app-file blocked; 404 for missing; LRU keeps cache under cap; `provider.delete` purges
  master; origin pull-through (missing master fetched/persisted/served, nested + resize,
  prefix+ext-swap, 404 when origin lacks it); **clustering** (public master replicates
  private→public, private master stays off public node, missing public master pulled from a
  peer, `X-Cluster-Secret` authorizes a write while a bad secret → 401).
- **Migration** validated by dry-run against the real `pos_db` (rutba.pk): URLs rewritten,
  `formats` compacted (e.g. 2240 → 871 bytes on the largest row, ~61% smaller).
- **Done:** service, provider, migration (mysql/pg, dry-run, idempotent), VPS Docker +
  Caddy artifacts (`deploy/`), test suite (`test/`), Next.js loader (`nextjs/`).

## 10. Open items (for the operator)
- trustlist Strapi/DB location + access (run the migration with `--db-client postgres|mysql`).
- Choose host (Hostinger vs VPS) per site; deploy via `deploy/`.
- Set a shared `MEDIA_UPLOAD_TOKEN` (service `UPLOAD_TOKEN` = provider `uploadToken`).
- Confirm prod S3 bucket name(s) beyond `trustlistdev`.
- Wire the provider into each Strapi (`config/plugins.js` + CSP) and point image origins at the media host.
