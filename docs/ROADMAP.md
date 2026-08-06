# Roadmap

Where this project stands and what it takes to reach the product it's aiming at: an
indexed, AI-enriched digital asset platform with real video management and
enterprise-scale storage.

Derived from a full review of `README.md`, `SPEC.md`, [`PLATFORM.md`](PLATFORM.md),
[`deploy/`](../deploy), [`src/`](../src), [`web/`](../web) and [`test/`](../test) on
**2026-08-06**, plus the strategic direction set the same day: **index the assets and
build asset management with integrated AI · video management and streaming ·
large-scale disk support**.

Phases are ordered by dependency, not appetite. Phase 0 fixes what is broken for
anyone deploying today. Phase 1 makes it safe to change anything. **Phase 2 is the
hinge** — a complete asset index and the background worker that maintains it, which
every later phase rides on. Phases 3–7 build the product; Phase 8 is new ground.

**Sizing** — `S` ≈ a focused sitting · `M` ≈ a day of work with tests · `L` ≈ a
multi-day feature with its own design decisions · `XL` ≈ a subsystem worth its own
design doc.

## Standing invariants

Every item below inherits the rules the codebase already lives by. They are not
negotiable per-phase, and they apply to the AI and video work exactly as they apply
to the DB layer:

1. **Additive + gated.** A new feature must not change existing behavior when its
   backend is unconfigured. No `DB_HOST` ⇒ the server is byte-for-byte the original
   masters-only origin. No ffmpeg ⇒ videos stream as-is. No AI provider key ⇒ no
   enrichment, no new columns populated, no console tabs. No extra volumes ⇒
   single-volume.
2. **Filesystem is the source of truth.** The DB holds metadata and access control
   only. Indexing stays best-effort — a DB outage degrades features, never masters.
   **AI output is metadata, never a mutation of a master.**
3. **Reserved namespaces.** New surface goes under `/_api`, `/_ui`, `/_s`, `/_dav`
   or a new underscore-prefixed mount. Media path keys are never shadowed.
4. **Proven by tests.** Nothing is "done" until a committed test covers it in CI and
   the whole suite is green.
5. **Nothing blocks a request that can run in the background.** Enrichment,
   transcoding, scanning and scrubbing are jobs, not request-path work.

---

## Phase 0 — Make the documented product deployable

The docs describe a DAM with a web console, trash recovery and a database. None of
that survives the shipped deploy path. This is the only phase that fixes things
which are outright broken today.

| # | Item | Size | Detail |
|---|---|---|---|
| 0.1 | **Ship `web/` in the Docker image** | S | [`deploy/Dockerfile`](../deploy/Dockerfile) copies only `server.js` and `src/`. [`src/handlers/ui.js`](../src/handlers/ui.js) serves the console from `<repo>/web`, so `/_ui/` 404s in every container deploy. Add `COPY web ./web`. |
| 0.2 | **Persist the trash directory** | S | [`src/config.js`](../src/config.js) derives `trashDir` as a sibling of `masterDir` → `/data/.media-trash`. Compose mounts `/data/masters` and `/data/cache` only, so `/data` is the container's writable layer and every "recoverable" delete dies on `docker compose up --build`. Mount `/data` or a dedicated volume, and set `TRASH_DIR` explicitly. |
| 0.3 | **Teach compose the platform layer** | M | No `DB_*`, `TRASH_DIR`, `WEBDAV_ENABLED` or `STORAGE_*` anywhere in [`deploy/`](../deploy), and no MySQL service. Add an optional `db` service and a documented "origin-only vs full platform" split, so both modes are one command. |
| 0.4 | **Fix the Hostinger upload list** | S | `README.md` step 3 says upload `server.js` + `package.json`; `src/` and `web/` are both required at runtime. |
| 0.5 | **Add `.env.example`** | S | ~30 env vars exist with no single reference artifact, and each phase below adds more. Group by feature, mark every block optional/gated. |

**Done when:** a clean `docker compose up` serves `/_ui/`, survives a rebuild with
trash intact, and a second documented profile brings up origin-only mode with no DB.

---

## Phase 1 — Earn the right to change things

Roughly two-thirds of the codebase by line count has no committed test. The platform
layer was validated during development by smoke scripts that lived in scratchpad
directories; **those files no longer exist**. Everything from Phase 2 onward is a
large change to that layer.

| # | Item | Size | Detail |
|---|---|---|---|
| 1.1 | **Commit a platform test suite** | L | New `test/platform.js` booting the app against a throwaway database and dropping it after. Cover: register/login/logout/me, RBAC denials per role, `/_api/files` search + filters, tags, duplicates, quotas (413 + rollback), shares (password, expiry, download cap, revoke), trash restore/purge/empty, multi-volume placement and union reads, ffmpeg poster/transcode, WebDAV verb matrix. |
| 1.2 | **Harden the test harness** | S | [`test/test.js`](../test/test.js) waits ≤5s for health then runs assertions regardless — on a loaded machine that reports 18 misleading assertion failures instead of one "server never started". Hard-fail on timeout; raise the budget for cold Windows/CI starts. |
| 1.3 | **MySQL service in CI** | M | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) has no database, so 1.1 could not run there. Add a `mysql` service container and a second job for the platform suite; keep the DB-less job as the "off ⇒ unchanged" guarantee. |
| 1.4 | **Stop hardcoding check counts** | S | The CI comment says "22-check suite", the suite is 26, and the README quotes its own number. Print the total from the runner and reference the suite, not a literal. |

**Done when:** both CI jobs are green on 18/20/22.x, the DB-less job proves invariant
1, and the platform job covers every `/_api` route in [`PLATFORM.md`](PLATFORM.md).

---

## Phase 2 — Index every asset, and build the worker that does it

**This is the hinge phase.** Asset management, AI enrichment, video packaging and
scale hardening all assume "every byte on disk has a row, and background work has
somewhere to run." Today neither is true.

**The index is incomplete by construction.** `recordPut` is called from exactly two
places — [`write.js:188`](../src/handlers/write.js#L188) and
[`masterops.js:59`](../src/masterops.js#L59) — both on the HTTP write path. There is
no scanner. So three classes of master are served correctly and are **invisible** to
the console, to search, and to everything downstream:

- Masters placed on disk directly — rsync, a restored backup, a migration, or a
  mounted Strapi volume. [`deploy/docker-compose.yml`](../deploy/docker-compose.yml)
  *recommends exactly this* as the "shortcut to skip copying files", which produces a
  completely empty index.
- Masters fetched by origin pull-through — `fetchstore` persists them, nothing indexes them.
- Masters pulled from a cluster peer on miss — same path, same gap.

| # | Item | Size | Detail |
|---|---|---|---|
| 2.1 | **Background job queue + worker** | L | A `jobs` table (type, payload, state, attempts, priority, lease, error) and an in-process worker pool with a concurrency cap, backoff, lease expiry, and a `/_api/jobs` admin view. Gated: no DB ⇒ no queue. **Everything async in Phases 2, 5, 6 and 7 is a job type here** — scan, enrich, transcode, scrub. Build it once. |
| 2.2 | **Filesystem scanner / reconciler** | L | Walk every storage volume and reconcile against `files`: index unknown masters, mark rows whose bytes vanished, refresh size/mtime drift. Runs as a job — on demand from the console, on a schedule, and optionally once at boot. Must be resumable, rate-limited so it never starves request-path I/O, and correct across volumes. |
| 2.3 | **Index the pull-through paths** | S | Have `fetchstore` (and therefore [`origin.js`](../src/origin.js) and [`cluster.js`](../src/cluster.js) pull-on-miss) record a fetched master the same way an upload does. Small change, closes two of the three invisibility holes permanently. |
| 2.4 | **Add `files.volume_id`** | M | The row doesn't record which volume holds the bytes, so [`resolveRead`](../src/storage.js#L57-L65) must `stat` every volume serially on **every request**. Record placement at write time, backfill in the scanner, and let the index answer "which volume" — the prerequisite for 7.1. |
| 2.5 | **Fix the path-collision integrity bug** | M | [`schema.js:127`](../src/schema.js#L127) declares `UNIQUE KEY uq_files_path (path(255))` on a `VARCHAR(1024)` column. Two distinct paths sharing a 255-char prefix collide, and `recordPut`'s `ON DUPLICATE KEY UPDATE` then **overwrites the other file's row** — silent metadata loss, no error. Add an indexed `path_hash` (sha256 of the full path) as the real uniqueness key. |
| 2.6 | **Extraction on index, not just on upload** | M | EXIF/ffprobe extraction currently happens only inline on upload. Make it a job so scanned-in and pulled-in assets get the same metadata, and so a failed extraction retries instead of being lost. |

**Done when:** pointing the server at a directory of 50k pre-existing files and
running one scan produces a complete, searchable index — and killing the process
mid-scan and restarting resumes cleanly.

---

## Phase 3 — Close the half-built, and harden the accounts

Features that are documented, schema'd, or config-parsed but not reachable — plus
the controls a multi-user, internet-facing file server is expected to have. Nothing
here is exploited by a bug; all of it is a gap between the docs and the code.

| # | Item | Size | Detail |
|---|---|---|---|
| 3.1 | **Enforce or reject `READ_AUTH_MODE`** | L | [`src/config.js`](../src/config.js) parses `public`/`mixed`/`private` and **nothing else in the tree reads it**. `READ_AUTH_MODE=private` boots cleanly and leaves every master world-readable. Either implement enforcement in [`read.js`](../src/handlers/read.js) — with share tokens as explicit grants and a decision on how cluster peers authenticate — or fail fast at boot on any non-`public` value until it lands. **Decide this before Phase 8.** |
| 3.2 | **Mint API tokens** | M | `api_tokens` is read by [`auth.js`](../src/auth.js) and documented as the integration path, but no `INSERT` exists anywhere and there is no endpoint. Add `POST/GET/DELETE /_api/tokens`, show the plaintext once, plus console UI. Unblocks scripted, CI and AI-worker integrations without handing out session tokens. |
| 3.3 | **Password change and reset** | M | The only `UPDATE users` statements set `storage_quota_bytes`. Add self-service change (old password required, other sessions invalidated) and admin-initiated reset. |
| 3.4 | **User disable, delete, role revocation** | M | `users.status` is displayed in the console and written by nothing; the route table grants roles and never removes them. Add enable/disable (revoking live sessions), delete, and `DELETE /_api/users/:id/roles/:role` with a last-admin guard. |
| 3.5 | **Login throttling** | M | `login_failed` is audited and nothing rate-limits it. Per-account and per-IP backoff with lockout, driven off the existing `audit_log`. |
| 3.6 | **Session expiry sweeper** | S | Sessions are removed only on logout or on the next touch of that exact token; `idx_sessions_expires` exists and nothing sweeps it. Add a periodic purge job (Phase 2.1) for expired `sessions` and `api_tokens`. |
| 3.7 | **`Secure` cookie flag + WebDAV transport guard** | S | The `sid` cookie in [`api.js`](../src/handlers/api.js) is `HttpOnly; SameSite=Lax` with no `Secure`, so it travels in the clear on a non-TLS deployment. WebDAV Basic auth has the same exposure — [`PLATFORM.md`](PLATFORM.md) warns to use HTTPS but nothing enforces it. |
| 3.8 | **MFA (TOTP)** | L | `users.mfa_enabled` / `mfa_secret` exist and are surfaced by `publicUser()`; nothing ever sets them. Enrollment, verification at login, recovery codes, admin reset. Gated, off by default. |

---

## Phase 4 — Asset management on top of the index

With Phase 2 done, every asset has a row. This phase makes those rows manageable as
a library rather than a file listing. `folders`, `file_versions` and `comments` have
**zero references** outside [`schema.js`](../src/schema.js) — they were laid down for
this and are spent here.

| # | Item | Size | Detail |
|---|---|---|---|
| 4.1 | **Version control** | L | `file_versions` is unused, so a `PUT` over an existing master destroys the previous bytes. Retain prior versions (reusing the trash area's storage discipline), list/restore/purge per file, retention capped by count or age. The highest-value unused table. |
| 4.2 | **Real folders** | M | Folders are path prefixes only; `files.folder_id` and the whole `folders` table are never written. Materialize folder rows, support rename/move of a subtree, per-folder ownership, and folder-scoped share links (`shares.folder_id` already exists and is unreachable). |
| 4.3 | **Collections** | M | Cross-cutting sets independent of path — a campaign, a client, a release. The organizing primitive a DAM needs that folders can't express, and the natural unit for bulk AI enrichment and bulk share. |
| 4.4 | **Custom metadata schemas** | L | Per-account field definitions (text, number, date, enum, multi-select) attached to assets, searchable alongside EXIF and tags. What turns "a file server with tags" into an asset catalog an organization can model its own taxonomy in. Also the write target for AI-suggested fields in Phase 5. |
| 4.5 | **Bulk operations + saved searches** | M | Select-all-matching-filter, then tag / move / share / delete / re-enrich as one job. Persist a filter set as a named saved search. Both need the queue from 2.1 for anything above a few hundred assets. |
| 4.6 | **Named renditions** | M | The resize engine already produces arbitrary variants on demand; expose *named* ones ("web-hero", "email-thumb", "print") so downstream teams request a rendition rather than memorizing query strings. Pure metadata over existing machinery. |
| 4.7 | **File comments + notifications** | M | `comments` is unused. Threaded comments per asset in the API and console. Notification delivery is a separate decision — in-app first, email later. |

---

## Phase 5 — AI enrichment

Every asset gets machine-generated metadata: tags, captions, alt text, extracted
document text, transcripts, and semantic search vectors. **All of it is metadata —
masters are never modified.** Enrichment runs as job types on the Phase 2.1 queue,
gated entirely on an API key being configured.

### What the Claude API gives you directly

| Capability | How | Notes |
|---|---|---|
| Auto-tagging, captions, alt text | Vision — image content blocks (base64 or URL) | Claude Opus 5 and Sonnet 5 are high-resolution tier: **2576 px on the long edge, up to ~4784 image tokens per image** |
| Document text + structured extraction | PDF `document` blocks, base64 or Files API | 32 MB request cap; 600 pages (100 on 200K-context models) |
| Guaranteed-shape output | `output_config.format` with a JSON schema | Validated at the API — no parsing, no retry loop for malformed JSON |
| Bulk backfill at half price | Message Batches API | Up to 100k requests / 256 MB per batch, most complete within an hour, results retained 29 days, **50% cost reduction** |
| Cheap repeated instructions | Prompt caching | Cache reads ~0.1× input price |

**Two capabilities Claude does not provide, which need their own decision:**

- **Embeddings.** There is no Anthropic embeddings endpoint. Semantic/similarity
  search needs a separate vector source (a local model, or another provider) and a
  place to put the vectors — MySQL as `BLOB` with brute-force cosine is viable into
  the low hundreds of thousands of assets; beyond that it wants a real vector index.
- **Audio.** Claude takes images and documents, not audio. Transcription needs a
  separate speech-to-text engine; Claude then works on the resulting transcript
  (summaries, topic tags, chapter marks). The ffmpeg stack already in the repo
  extracts the audio track for whichever engine gets chosen.

| # | Item | Size | Detail |
|---|---|---|---|
| 5.1 | **Provider layer + gating** | M | `src/ai.js` following the [`sharp.js`](../src/sharp.js) / [`ffmpeg.js`](../src/ffmpeg.js) graceful-degrade pattern. Uses the official `@anthropic-ai/sdk`. No key ⇒ every enrichment job type is unregistered and the console tab is absent. Per-account spend caps and a hard monthly ceiling from day one. |
| 5.2 | **Enrichment schema** | M | `file_ai` (caption, alt text, description, confidence, model id, prompt version, cost, timestamps) plus `file_ai_tags` kept **distinct from human `file_tags`** so a person's tags are never silently overwritten by a model's. Every row records which model and prompt version produced it, so a re-run is auditable and a bad prompt is revocable. |
| 5.3 | **Image enrichment job** | L | Tags, caption, alt text, detected text, suggested custom-metadata values (4.4) — one structured-output call per asset. **Send a resized variant, not the master**: the origin already generates them, and bounding the long edge is the single biggest cost lever. Cache the taxonomy/instruction prefix; keep the per-asset image after the last cache breakpoint. |
| 5.4 | **Document enrichment job** | M | PDFs and office documents → extracted text, summary, entities, suggested tags. Feeds the same `file_ai` row and makes document bodies searchable, which the current index cannot do at all. |
| 5.5 | **Transcription + video understanding** | L | Extract audio with the existing ffmpeg stack → external STT → store a timestamped transcript → Claude for summary, topic tags and chapter marks. Transcripts become WebVTT caption tracks for Phase 6, closing the loop between the two phases. |
| 5.6 | **Batch backfill** | M | Enriching an existing library is exactly the Batches API's shape: submit up to 100k assets per batch at half price, poll, ingest results keyed by `custom_id`. Make this the default path for anything over a few hundred assets and keep the live path for new uploads. |
| 5.7 | **Semantic search** | L | Embed captions + transcripts + extracted text, store the vectors, and add a `?similar=<path>` / natural-language mode to `/_api/files`. Blocked on the embeddings decision above. |
| 5.8 | **Review UI + human override** | M | Console surface for AI output: accept, edit, reject, promote an AI tag to a human tag, re-run one asset or a whole collection. Nothing a model produced should be indistinguishable from what a person asserted. |
| 5.9 | **Cost accounting** | S | Per-job and per-account token and dollar accounting from `usage`, surfaced in the console. Without it, 5.3 and 5.6 are unbudgetable. |

**Model choice is yours, and it's the main cost dial.** Default to `claude-opus-5`
($5 / $25 per MTok, 1M context). `claude-sonnet-5` ($3 / $15, currently $2 / $10
introductory through 2026-08-31) and `claude-haiku-4-5` ($1 / $5, 200K context) are
the cheaper tiers if bulk classification quality holds on your library — worth a
sweep on a sample before committing. One caveat with real teeth for this workload:
**the minimum cacheable prompt prefix differs by model** — 512 tokens on Opus 5,
1024 on Sonnet 5, **4096 on Haiku 4.5**. A compact taxonomy prompt that caches on
Opus will silently fail to cache on Haiku, and the per-asset saving evaporates
exactly where volume makes it matter most. Also note the Batches API is available on
the first-party Claude API (and Claude Platform on AWS) but **not** on Bedrock,
Vertex or Foundry — if the deployment target is one of those, 5.6 needs a different
plan.

---

## Phase 6 — Video management and streaming

Today: poster frames, ffprobe metadata, and a **blocking** one-shot `?transcode=<h>`
that holds the connection and a CPU for the whole render — [`README.md`](../README.md)
honestly calls it "heavy; the first request blocks while it renders." That is a
demo, not video management. Everything here rides the Phase 2.1 queue.

| # | Item | Size | Detail |
|---|---|---|---|
| 6.1 | **Async transcode jobs** | M | Move [`mediavariant.js`](../src/mediavariant.js) rendering onto the queue: request a rendition, get `202` + a job id, poll or subscribe, serve when ready. Removes the blocking-request failure mode and makes concurrency governable. Keep the current inline path as a fallback for short clips. |
| 6.2 | **HLS/DASH packaging + ABR ladder** | XL | A configurable rendition ladder (e.g. 360/480/720/1080p), segmented output, and playlist generation under a reserved namespace. The core of real streaming: adaptive playback, instant seeking, no full-file download. Ladder definition reuses named renditions (4.6). |
| 6.3 | **Storyboard / sprite thumbnails** | M | Periodic frames as a sprite sheet plus a WebVTT track, so players show scrub previews. Cheap with ffmpeg already bundled, and a large perceived-quality win. |
| 6.4 | **Caption and subtitle tracks** | M | Upload, store and serve WebVTT/SRT per asset, multi-language, surfaced in the player. Phase 5.5 transcripts land here automatically — the two phases meet at this table. |
| 6.5 | **Player in the console** | M | Replace the plain `<video>` preview with an HLS-capable player exposing quality selection, captions, storyboard scrubbing and chapter marks. Where the whole phase becomes visible to a user. |
| 6.6 | **Signed, expiring playback URLs** | M | Share links (`/_s/`) are per-file and permanent until revoked. Streaming needs short-lived signed URLs per session, ideally per segment, so a copied playlist URL doesn't become permanent public access. Interacts directly with the 3.1 decision. |
| 6.7 | **Per-title metadata + audio tracks** | M | Duration, chapters, multiple audio tracks, language tags, aspect/rotation — surfaced in search and in the player. ffprobe already reads most of it; nothing stores or exposes it. |

---

## Phase 7 — Large-scale disk support

This is what makes it enterprise. The current multi-volume implementation is
correct and complete for a handful of volumes and a moderate file count; every item
below is a specific place where it stops scaling. All measured against the code, not
assumed.

| # | Item | Size | Detail |
|---|---|---|---|
| 7.1 | **Index-authoritative reads** | M | [`resolveRead`](../src/storage.js#L57-L65) `stat`s each volume **serially until it finds the file** — with 8 volumes on network mounts that is up to 8 round trips per request. With `files.volume_id` from 2.4, look the volume up and `stat` once, falling back to the scan only on a miss. |
| 7.2 | **Rewrite the variant cache for scale** | L | Three separate O(n) problems in [`cache.js`](../src/cache.js): [`init`](../src/cache.js#L35-L46) does a full `readdir` + per-file `stat` at boot and holds every entry in a `Map`; [`evictIfNeeded`](../src/cache.js#L65-L78) **sorts the entire index on every eviction**, repeatedly, under steady-state pressure; [`purgeForPath`](../src/cache.js#L81-L91) scans **all** keys on every PUT/DELETE. Plus a single flat directory holding millions of files. Needs a heap or bucketed LRU, a prefix index for purge, sharded subdirectories, and lazy/incremental warmup. |
| 7.3 | **Scalable listing and stats** | M | `/_api/files` uses offset pagination, which degrades badly at depth; `/_api/stats` runs `SUM`/`COUNT` across the whole table per request. Add keyset pagination and maintained counters or a periodic rollup. |
| 7.4 | **Efficient directory listing** | M | [`listDir`](../src/storage.js#L101-L120) does a `readdir` **plus a `stat` per entry, per volume** — a WebDAV listing of a 50k-file directory is 50k syscalls. Serve listings from the index where it's authoritative, and use `withFileTypes` results instead of re-`stat`ing. |
| 7.5 | **Volume drain, rebalance, evacuate** | L | Placement policies exist (`free`/`fill`/`route`) but there is no way to *move* data: no draining a failing disk, no rebalancing after adding capacity, no evacuating a volume before decommissioning it. The operation an operator needs most and currently cannot perform at all. |
| 7.6 | **Storage tiering** | L | Beyond `\|ro`: hot/warm/cold classes with automatic demotion by age or access, and transparent promotion on read. The economics of a large library — most assets are cold most of the time. |
| 7.7 | **Integrity scrub** | M | Checksums are recorded on upload and never verified again. A background scrub job re-hashes on a rotation, flags divergence, and (with clustering) can heal from a peer. Bit rot over millions of files on cheap disks is not hypothetical. |
| 7.8 | **Directory sharding for masters** | M | Masters land wherever the request path says, so a flat prefix can accumulate hundreds of thousands of entries in one directory. Offer a sharding policy for new writes that keeps directory sizes bounded without changing URL keys. |
| 7.9 | **Capacity telemetry** | S | `/_api/storage` reports free/total per volume, computed by `statfs` on demand — and `pickWriteVolume` `statfs`es every writable volume on **every new-file write**. Cache the figures, add growth-rate tracking and a projected-full-date warning. |

---

## Phase 8 — Taxonomy expansion

New surface, each independently gated. Ordered by how much existing core they reuse
— [`masterops.js`](../src/masterops.js) is already the protocol-agnostic mutation
core WebDAV rides on, so the protocol items are cheaper than they look.

| # | Item | Size | Detail |
|---|---|---|---|
| 8.1 | **Native S3 storage backend** | L | Today S3 appears only as a read-through `ORIGIN_SOURCES` fetch. Make it a first-class volume type in [`storage.js`](../src/storage.js) so masters can live in a bucket under the same placement, tiering and rebalance machinery as local disks. Pairs naturally with 7.6. |
| 8.2 | **FTP / SFTP** | L | Another front door onto `masterops`, authenticating against platform accounts exactly as WebDAV does. |
| 8.3 | **SSO / LDAP** | L | External identity feeding the same `users`/`user_roles` tables; local accounts remain the fallback. |
| 8.4 | **Multi-tenancy** | XL | The largest change: a tenant boundary through files, users, quotas, storage, audit, AI spend and jobs. Worth a design doc before any code, and cheaper the earlier the boundary is decided. |

---

## Continuous — documentation

Not a phase; every item above ships with its docs. But there is standing drift to
clear once:

- **`SPEC.md` never learned about the platform layer** — it still specifies a
  sharp-only origin, with no accounts, RBAC, `/_api`, console, shares, trash, storage
  volumes, ffmpeg or WebDAV. §6 is headed "TO BUILD" while §9 lists the same work as
  done, and §8 marks the Docker/Caddy artifacts as "TO BUILD" though
  [`deploy/`](../deploy) has shipped. Either bring it current or demote it to a
  historical record and make `README.md` + [`PLATFORM.md`](PLATFORM.md) the spec.
- **`README.md` file tree is pre-platform** — it omits `db.js`, `auth.js`,
  `schema.js`, `fileindex.js`, `storage.js`, `trash.js`, `ffmpeg.js`,
  `mediavariant.js`, `metadata.js`, `masterops.js`, all four new handlers, plus
  `web/` and `docs/`. That note is exactly where a reader would look to learn `web/`
  must ship — see 0.1.
- **`README.md` env table stops at `CORS_ORIGIN`** — missing every `DB_*`,
  `TRASH_DIR`, `STORAGE_*`, `WEBDAV_ENABLED`, `ALLOW_REGISTRATION`,
  `SESSION_TTL_DAYS`, `READ_AUTH_MODE`, `FFMPEG_PATH`/`FFPROBE_PATH` and `HOST` —
  before this roadmap adds AI, job-queue and streaming vars on top.
- **`deploy/README.md` has no platform content at all** — no DB setup, console URL,
  WebDAV mount or trash persistence.

---

## Decisions needed (not code)

Carried forward from `SPEC.md` §10, still open:

- trustlist Strapi/DB location and access, to run the migration with
  `--db-client postgres|mysql`.
- Host choice per site (Hostinger vs VPS).
- A shared `MEDIA_UPLOAD_TOKEN` (service `UPLOAD_TOKEN` = provider `uploadToken`).
- Production S3 bucket names beyond `trustlistdev`.
- Wiring the provider into each Strapi (`config/plugins.js` + CSP) and pointing the
  image origins at the media host.

Raised by this review — each one blocks a specific item:

| Decision | Blocks | Why it can't be deferred |
|---|---|---|
| **Private reads: enforce or reject?** | 3.1, and the design of 6.6 and 8.4 | Enforcing changes the contract for cluster peers, share links and the Strapi provider at once. Deciding late means designing signed playback and tenancy twice. |
| **Embeddings source** | 5.7 | No Anthropic embeddings endpoint. Local model vs external provider vs deferring semantic search entirely — and where the vectors live. |
| **Speech-to-text engine** | 5.5, and therefore 6.4 | Claude takes no audio. Self-hosted vs API changes cost, latency and the deploy footprint. |
| **AI model tier and budget ceiling** | 5.1, 5.3, 5.6 | Opus 5 / Sonnet 5 / Haiku 4.5 differ ~5× in price and in cache minimums. Needs a sample sweep on your own library, plus a hard monthly cap before any bulk run. |
| **Deployment target for AI** | 5.6 | The Batches API — the half-price bulk path — is first-party Claude API only, not Bedrock/Vertex/Foundry. |
| **Streaming protocol and ladder** | 6.2 | HLS vs DASH vs both; which rungs; storage cost of pre-generated renditions vs latency of on-demand. |
| **Deleted users' owned files** | 3.4 | Reassign to an admin, or orphan? |
| **Version retention policy** | 4.1 | By count, age, or total bytes? |
