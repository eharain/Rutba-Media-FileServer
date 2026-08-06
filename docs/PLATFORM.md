# Platform layer (accounts · RBAC · metadata · audit)

This is the optional database-backed layer that turns the masters-only image origin
into a managed media platform. It is **entirely additive and gated**: with no
database configured, the server behaves byte-for-byte as before — public reads,
`UPLOAD_TOKEN`-gated writes, cluster replication, on-the-fly resize. Turn it on by
pointing the server at a MySQL database.

> Source of truth stays the filesystem. The DB holds metadata and access-control
> only; metadata writes are best-effort, so a DB outage degrades features but never
> loses or corrupts masters.

## Enabling it

Set a MySQL target (either discrete vars or a URL). Nothing else is required — the
database and all tables are created automatically on boot (idempotent schema in
[`src/schema.js`](../src/schema.js)).

```bash
# discrete
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=secret
DB_NAME=media_fileserver
# …or a single URL (DB_URL / MYSQL_URL / DATABASE_URL)
DB_URL=mysql://root:secret@127.0.0.1:3306/media_fileserver
```

`MYSQL_*` are accepted as aliases for every `DB_*` var. On a successful boot the log
prints `db on — user@host:port/name`; on failure it prints a warning and the server
keeps running with the layer **off** (masters still serve).

### Related env

| Var | Default | Meaning |
|---|---|---|
| `DB_HOST` / `MYSQL_HOST` | — | MySQL host. **Unset ⇒ whole layer off.** |
| `DB_PORT` / `MYSQL_PORT` | `3306` | Port |
| `DB_USER` / `MYSQL_USER` | `root` | User |
| `DB_PASSWORD` / `MYSQL_PASSWORD` | `` | Password |
| `DB_NAME` / `MYSQL_DATABASE` | `media` | Database (auto-created) |
| `DB_URL` / `MYSQL_URL` / `DATABASE_URL` | — | Connection URL (overrides discrete vars) |
| `DB_POOL` | `10` | Pool connection limit |
| `DB_CONNECT_RETRIES` | `0` | Boot-time connect retries, 1s apart, before degrading to origin-only. Raise it when the database starts alongside the server (compose). |
| `JOBS_ENABLED` | `true` | Run the background worker in this process |
| `JOBS_CONCURRENCY` | `2` | Jobs run at once |
| `JOBS_POLL_MS` | `1000` | Queue poll interval |
| `JOBS_MAX_ATTEMPTS` | `5` | Attempts before a job is failed for good |
| `SCAN_ON_BOOT` | `false` | Reconcile the filesystem into the index once at boot |
| `SCAN_RATE_FILES_PER_SEC` | `200` | Ceiling on scan throughput, so it never starves request-path I/O |
| `ALLOW_REGISTRATION` | `false` | Allow open self-service `POST /_api/auth/register`. The **first** account is always allowed (bootstrap admin) regardless. |
| `SESSION_TTL_DAYS` | `30` | Login session lifetime |
| `READ_AUTH_MODE` | `public` | `public` (open, as today) · `mixed` (private files need auth) · `private` (all reads need auth). **Enforced** — see below. |
| `SECURE_COOKIES` | `auto` | `Secure` on the session cookie: `auto` (when the request arrived over TLS) · `always` (also refuses WebDAV Basic auth over plain HTTP) · `never` |
| `LOGIN_MAX_FAILURES` | `10` | Failed logins per account within the window before lockout (`0` disables throttling) |
| `LOGIN_MAX_FAILURES_IP` | `5×` account | Per-IP threshold. Deliberately much higher — a tight per-IP limit locks out everyone behind one NAT. |
| `LOGIN_WINDOW_MINUTES` | `15` | Window the failures are counted over |
| `LOGIN_LOCKOUT_MINUTES` | `15` | How long a lockout lasts, measured from the last failure |
| `MFA_ENABLED` | `false` | Allow TOTP enrolment; enrolled users must present a code at login |
| `MFA_ISSUER` | `Rutba Media` | Name shown in authenticator apps |

## Web console (`/_ui/`)

A self-contained management console ships with the platform layer — no build step,
no framework, no external assets (served straight from [`web/`](../web) by
[`src/handlers/ui.js`](../src/handlers/ui.js)). Open **`/_ui/`** in a browser once the
DB layer is on; when the layer is off, `/_ui/*` returns 404 (the feature is simply
absent).

- **Sign in / bootstrap** — the first visit creates the admin account, then logs in.
- **Files** — searchable, filterable grid (by text, type, visibility, active/trashed)
  with live image thumbnails (served through the origin's own on-the-fly resize) and
  a preview modal (image/video/audio/PDF) with open · download · copy-URL · delete.
- **Upload** — drag-and-drop or picker, **multi-file/bulk** with per-file progress,
  a target folder prefix, and a public/private toggle.
- **Users** (admin) — list/create accounts and assign roles.
- **Audit** (admin) — recent activity, plus live storage/user stats in the header.
- Light/dark theme toggle; responsive down to mobile.

The console authenticates with the logged-in user's session token, so uploads and
deletes work **without** distributing the shared `UPLOAD_TOKEN` — an editor/admin
session is authorized for writes and the upload is attributed to that user (see
"Writes from the console" below).

### Writes from the console

Writes (`PUT`/`DELETE /<path>`) accept, in addition to the existing
`UPLOAD_TOKEN` / `X-Upload-Token` / `X-Cluster-Secret`, a **session or API bearer
token belonging to an `editor` or `admin`** (only when the DB layer is on). This is
purely additive: the Strapi provider and cluster peers keep working exactly as
before, and with no DB the write path is unchanged. Console uploads are recorded
with `owner_user_id` set to the acting user.

## Accounts & roles

- Passwords are hashed with scrypt (built-in `crypto`, no native dependency).
- Login issues an opaque bearer token; only its SHA-256 is stored in `sessions`, so a
  DB leak yields no usable tokens. Long-lived integration tokens (`api_tokens`) work
  the same way.
- Roles: `admin` (everything) ⊇ `editor` (write) ⊇ `viewer` (read). The **first**
  registered account is automatically `admin`.

Authenticate any `/_api/*` request with `Authorization: Bearer <token>` or the `sid`
cookie set at login.

## Control-plane API (`/_api/*`)

All JSON. Returns `503 {error:"db_disabled"}` when the DB layer is off. This
namespace never collides with media paths (like `/_health`).

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /_api/auth/register` | open¹ | Create account → `{user, token, roles}` |
| `POST /_api/auth/login` | — | `{login, password}` → `{user, token, roles}` (+ `sid` cookie) |
| `POST /_api/auth/logout` | bearer | Invalidate the session |
| `GET  /_api/auth/me` | bearer | Current user + roles + MFA state |
| `POST /_api/auth/password` | bearer | Change own password `{old_password, new_password}` (revokes other sessions) |
| `POST /_api/auth/mfa/setup` | bearer | Begin TOTP enrolment → `{secret, otpauth_url}` |
| `POST /_api/auth/mfa/enable` | bearer | Finish enrolment `{code}` → `{recovery_codes}` (shown once) |
| `POST /_api/auth/mfa/disable` | bearer | Turn TOTP off `{password}` |
| `POST /_api/auth/mfa/recovery` | bearer | Re-issue recovery codes `{password}` |
| `GET  /_api/tokens` | bearer | List own API tokens (never the secret) |
| `POST /_api/tokens` | bearer | Mint one `{name, expires_in_days?}` → plaintext, once |
| `DELETE /_api/tokens/:id` | owner/admin | Revoke a token |
| `GET  /_api/users` | admin | List users |
| `POST /_api/users` | admin | Create user `{email, username, password, role?}` |
| `DELETE /_api/users/:id` | admin | Delete a user — `?files=orphan` (default) or `?files=reassign&to=<id>` |
| `POST /_api/users/:id/status` | admin | Enable/disable `{status}` (disabling revokes live sessions) |
| `POST /_api/users/:id/password` | admin | Reset a password `{new_password}` (revokes all their sessions) |
| `POST /_api/users/:id/mfa/reset` | admin | Turn off a user's TOTP (lost-authenticator recovery) |
| `POST /_api/users/:id/roles` | admin | Grant a role `{role}` |
| `DELETE /_api/users/:id/roles/:role` | admin | Revoke a role (last-admin guarded; revokes their sessions) |
| `GET  /_api/files` | any user | List/search index: `?q=&type=&visibility=&status=&tag=&limit=&offset=` |
| `GET  /_api/files/duplicates` | any user | Files grouped by identical `sha256` (+ reclaimable bytes) |
| `GET  /_api/files/metadata?path=` | any user | Extracted EXIF/media metadata for a file |
| `GET  /_api/files/tags?path=` | any user | A file's tags |
| `PUT  /_api/files/tags` | editor | Replace a file's tags `{path, tags:[]}` |
| `GET  /_api/tags` | any user | All tags with file counts |
| `POST /_api/users/:id/quota` | admin | Set/clear a user's storage quota `{bytes\|null}` |
| `POST /_api/shares` | editor | Create a share link (see below) |
| `GET  /_api/shares` | any user | List own share links (admin: all) |
| `DELETE /_api/shares/:id` | owner/admin | Revoke a link |
| `POST /_api/files/restore` | editor | Restore a trashed file `{path}` |
| `POST /_api/files/purge` | editor | Permanently delete a trashed file `{path}` |
| `POST /_api/trash/empty` | admin | Permanently delete everything in the trash |
| `GET  /_api/audit` | admin | Recent audit events |
| `GET  /_api/stats` | admin | File count, storage bytes, trashed, missing, users, job summary |
| `GET  /_api/storage` | admin | Storage volumes with free/total space + placement policy |
| `GET  /_api/jobs` | admin | Background jobs: `?state=&type=&limit=&offset=` + worker info |
| `POST /_api/jobs` | admin | Queue a job `{type, payload?}` → `202 {job}` |
| `GET  /_api/jobs/:id` | admin | One job with its progress/result |
| `POST /_api/jobs/:id/cancel` | admin | Cancel a queued or running job |
| `POST /_api/jobs/:id/retry` | admin | Re-queue a finished job with attempts reset |
| `GET  /_api/files/versions?path=` | any user | Retained copies of a master + the retention policy |
| `GET  /_api/files/versions/:n?path=` | any user | Download one retained version |
| `POST /_api/files/versions/restore` | editor | Make a version live again `{path, version}` |
| `DELETE /_api/files/versions/:n?path=` | editor | Delete one retained version |
| `GET/PUT /_api/files/fields` | any user / editor | Custom metadata values for a file |
| `GET  /_api/folders` | any user | Folder rows (`?parent=` to scope) |
| `POST /_api/folders/sync` | editor | Materialize folder rows from the indexed paths |
| `POST /_api/folders/move` | editor | Move/rename a subtree `{path, to}` |
| `GET/POST /_api/collections` | any user / editor | List / create collections |
| `DELETE /_api/collections/:id` | editor | Delete a collection (files untouched) |
| `GET/POST /_api/collections/:id/files` | any user / editor | List members / `{add:[], remove:[]}` by path |
| `GET/POST /_api/fields` · `DELETE /_api/fields/:id` | any user / admin | Custom field definitions |
| `GET/POST /_api/renditions` · `DELETE /_api/renditions/:name` | any user / admin | Named resize presets |
| `GET/POST /_api/searches` · `DELETE /_api/searches/:id` | bearer | Saved filter sets |
| `POST /_api/bulk` | editor | Apply an action to everything matching a filter, as a job |
| `GET/POST /_api/comments` · `PATCH`/`DELETE /_api/comments/:id` | bearer | Per-asset discussion |
| `GET  /_api/notifications` · `POST /_api/notifications/read` | bearer | In-app notifications |

¹ First account always allowed; subsequent self-registration needs `ALLOW_REGISTRATION=true`.

## The index, and the scan that completes it

Every master gets a row in `files` — that row is what search, tags, shares, quotas,
duplicates and the console all read. Rows are keyed by `path_hash` (the sha256 of the
full path) and record which storage `volume_id` holds the bytes.

**A row is created by every way a master can arrive:** an HTTP `PUT`, a WebDAV write,
an origin pull-through, a cluster peer pull — and, for bytes that appeared on disk
without passing through the server at all, by a **scan**.

That last case is the common one in a real deployment: masters copied in with rsync,
restored from a backup, or a Strapi uploads volume mounted straight in. Those files
are served correctly but are invisible to the platform until they are indexed:

```bash
curl -X POST https://media.example.com/_api/jobs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"scan"}'
```
or console → **Jobs** → *Scan all volumes*, or `SCAN_ON_BOOT=1` to reconcile once at
every boot.

A scan walks every volume and reconciles it against the index:

| On disk | In the index | Result |
|---|---|---|
| present | absent | indexed, and queued for metadata extraction |
| present, size/mtime changed | present | row refreshed, metadata re-extracted |
| absent | present | marked **`missing`** — never deleted |

`missing` is deliberately not a delete: the row may carry tags, share links and
comments, and the bytes may simply be on an unmounted volume. Restore the file and
the next scan flips it back to `active`. List them with `/_api/files?status=missing`.

Scans are **resumable** (a killed scan continues from its recorded progress rather
than starting over) and **rate-limited** (`SCAN_RATE_FILES_PER_SEC`) so reconciling a
large library never starves live requests.

## Read authorization (`READ_AUTH_MODE`)

| Mode | Behavior |
|---|---|
| `public` *(default)* | Reads are open to everyone — byte-for-byte the original origin, and the enforcement path costs nothing. |
| `mixed` | Public-visibility masters stay open; `private` ones need a permitted caller. |
| `private` | Every read needs one, decided before the master is even resolved. |

A caller is permitted by any of:

1. **`X-Cluster-Secret`** — a sibling node. Pull-on-miss is a GET against a peer, so
   without this grant, turning on private reads would silently break replication.
2. **`UPLOAD_TOKEN`** (as `Authorization: Bearer` or `X-Upload-Token`) — the Strapi
   provider and the migration script, which already write with it.
3. **A session or API token** for any account with a role.

**Share links are the fourth way in, by design.** `/_s/<token>` streams the file
itself, and the share *is* the explicit grant — which is what makes it the right way
to hand out a private file without handing out credentials. A refusal is `401`, not
`403`: the caller may simply not have sent the credential it has.

Visibility comes from the per-file `X-Visibility` sidecar if one exists, else the
`PRIVATE_PATHS` rule.

## Accounts, sessions and second factors

- **Passwords** are scrypt-hashed. A self-service change requires the current
  password and **signs out every other session** — that is the point of changing it.
  An admin reset needs no old password and signs out all of them.
- **Login throttling** counts failures per account and per IP over a sliding window,
  and locks from the *last* failure, so hammering a locked account keeps it locked.
  A `429` carries `Retry-After`. A missing MFA code is deliberately **not** counted:
  the password held, and locking someone out for fumbling a 30-second code is a
  denial of service against your own users.
- **TOTP** (`MFA_ENABLED=1`) is standard RFC 6238 — HMAC-SHA1, 6 digits, 30-second
  step — so any authenticator app works. Enrolment is two steps: `setup` mints the
  secret, and nothing turns on until a working code proves the app is really
  configured. Ten single-use recovery codes are issued at that moment and never
  shown again; an admin can clear MFA for a user who has lost both.
- **API tokens** are the credential for scripts, CI and WebDAV. The plaintext is
  returned once and only its sha256 is stored. An MFA-enrolled account **cannot** use
  WebDAV Basic auth with its password — Basic has nowhere to carry a code — so it
  authenticates with an API token as the password instead.
- **Sessions** die on logout, on expiry, on a password change, on a role revocation,
  and when the account is disabled. The `sweep` job removes expired rows on a
  schedule rather than leaving them until someone happens to present the token.

**Deleting a user never deletes files.** `?files=orphan` (the default) clears the
owner and keeps every row, its tags and its shares; `?files=reassign&to=<id>`
transfers ownership, and with it the bytes counted against that user's quota. The
last active admin cannot be disabled, demoted or deleted — an installation with no
admin cannot make one.

## Managing the library

Once every asset has a row, those rows become manageable as a library rather than a
file listing.

**Versions.** A `PUT` over an existing master used to destroy the previous bytes.
Now the outgoing copy is moved aside *before* the new one lands — the same discipline
as the trash, and stored beside it under `<TRASH_DIR>/versions`, outside every served
volume so a retained copy is never reachable at its original URL. Restoring a version
retains the current bytes first, so a restore is itself undoable. Retention is capped
by count (`VERSION_RETAIN_COUNT`, default 3) and optionally age
(`VERSION_RETAIN_DAYS`); an uncapped version store is a disk leak with good
intentions. Replicated writes from a cluster peer are excluded — the originating node
already kept the history, and duplicating it per node multiplies the cost by the size
of the cluster.

**Folders** are real rows now, not just path prefixes. `POST /_api/folders/sync`
materializes them from the paths already indexed, and `POST /_api/folders/move`
renames or moves a whole subtree through the same `masterops` WebDAV uses — so
placement, indexing, cache purge and replication behave identically to any other
write.

**Collections** are sets that cut across paths — a campaign, a client, a release. An
asset lives in exactly one folder and belongs to any number of collections, which is
the whole reason both exist.

**Custom metadata** lets an installation model its own taxonomy: define fields
(`text`, `number`, `date`, `enum`, `multi`, `bool`), set values per asset, and filter
on them with `?field=<key>&field_value=<v>` alongside the built-in filters. Values are
written to the column their type deserves, so a date filter is a date comparison.

**Named renditions** replace a memorized query string: `?rendition=web-hero` instead
of `?w=1600&h=900&fit=cover&q=82&fm=webp`. Pure metadata over the resize engine that
already exists — retune the definition later and every URL downstream teams shipped
follows. An explicit query parameter still wins, so a rendition is a default, not a
cage; an unknown name is a `404` rather than a silent full-size image.

**Bulk operations** (`POST /_api/bulk`) apply `tag` / `untag` / `collection_add` /
`collection_remove` / `delete` / `extract` / `enrich` to everything matching a filter,
as a job. The filter is built by the *same* code that powers `GET /_api/files`
(`handlers/filequery.js`) — deliberately, so the set you previewed is exactly the set
that gets touched. Saved searches persist a filter set by name.

**Comments** are threaded per asset and can be resolved. Posting one notifies the
people already involved — the asset's owner and everyone who has commented on it —
and nobody else, because a notification feed that includes the whole installation is
useless within a week.

## Background jobs

One queue carries everything that must not block a request: scans, metadata
extraction, and the transcode/enrichment/scrub work that later phases add.

- **Gated twice.** No database ⇒ no queue at all. `JOBS_ENABLED=0` keeps the queue
  (jobs can be enqueued and inspected) but runs nothing in *this* process.
- **Crash-safe.** A worker claims a job under a lease; if it dies, the lease expires
  and the job returns to the queue. Failures back off exponentially up to
  `JOBS_MAX_ATTEMPTS`.
- **Deduplicated.** Queuing work that is already pending returns the existing job, so
  "scan now" clicked five times is one scan.
- **Capability-aware.** A process only claims job types it has handlers for, so a node
  without ffmpeg leaves transcode work for a node that has it instead of failing it.

> Workers sharing a queue are assumed to share a view of the storage volumes. Clustering
> replicates *files* between nodes, not database rows — each node runs its own database
> and its own queue.

## Share links (`/_s/<token>`)

`POST /_api/shares` mints a public link to an indexed file — the controlled-access
way to hand a file to someone without exposing the raw master path or any
credentials. It works even for `private`-visibility masters and is forward-compatible
with a future private read-auth mode (a share is an explicit grant).

Body: `{ path | file_id, permission?, password?, expires_in_days?, max_downloads? }`

| Field | Effect |
|---|---|
| `permission` | `view` (inline, default) or `download` (forces an attachment download) |
| `password` | Protects the link — visitors get an unlock page; the served bytes require `?pw=` |
| `expires_in_days` | Link returns **410 Gone** after this many days |
| `max_downloads` | Link returns **410** once the cap is hit (enforced atomically, race-free) |

The response returns the `token`, an absolute `url`, and a `relativeUrl`. Anyone can
then `GET /_s/<token>`; each serve increments `download_count` and is audited
(`share_access`). Revoke instantly with `DELETE /_api/shares/:id`. In the console,
create a link from a file's preview ("🔗 Share link") and manage them under **Shares**.

## WebDAV (`/_dav/`)

The whole master store — across all storage volumes — is mountable as a network
drive over WebDAV (RFC 4918, class 1 + minimal locking). Own namespace, so the
public media/upload routes are untouched; gated on the DB layer and on by default
(`WEBDAV_ENABLED=false` to disable, then `/_dav/*` is 404).

- **Auth:** HTTP Basic against platform accounts — **use HTTPS** (Basic sends
  credentials base64-encoded). Reads (GET/HEAD/PROPFIND/OPTIONS/LOCK) need `viewer`+;
  writes (PUT/DELETE/MKCOL/MOVE/COPY/PROPPATCH) need `editor`+.
- **Methods:** OPTIONS, PROPFIND (Depth 0/1), PROPPATCH (accept-and-ignore, for
  Windows timestamps), GET/HEAD (Range-aware), PUT, DELETE, MKCOL, MOVE, COPY,
  LOCK/UNLOCK (advisory). File writes reuse `masterops` — placement across volumes,
  checksum, EXIF/probe indexing, trash-aware delete, cluster replication — so a DAV
  upload is indistinguishable from an API/console upload. Directory listings are the
  **union across volumes** (default first wins).

Mount examples (behind HTTPS at `https://media.example`):
- **Windows:** Map network drive → `https://media.example/_dav/` → sign in with your
  account.
- **macOS Finder:** Go → Connect to Server → `https://media.example/_dav/`.
- **rclone:** `rclone config` → type `webdav`, url `https://media.example/_dav/`,
  vendor `other`, your user/pass.
- **Linux:** `davfs2` → `mount -t davfs https://media.example/_dav/ /mnt/media`.

## Tags

Files can carry free-form tags for organization and search. `PUT /_api/files/tags
{path, tags:[]}` replaces a file's full tag set (names are trimmed, lower-cased,
deduped, capped at 64 chars); `GET /_api/files/tags?path=` reads them, `GET
/_api/tags` lists every tag with its file count, and `GET /_api/files?tag=<name>`
filters the index by tag. In the console, edit a file's tags as chips in its preview
and filter the grid with the **# tag** box (autocompletes from existing tags).

## Media metadata (EXIF)

Every raster upload is decoded once with `sharp`; its dimensions, format and colour
space — plus parsed **EXIF** (camera make/model, lens, capture time, ISO, exposure,
aperture, focal length, GPS) — are stored in `file_metadata` (full parsed blob in
`raw`). `GET /_api/files/metadata?path=` returns it, and the console shows a **📷
Metadata** panel (with a GPS→map link) in the file preview. Extraction is
best-effort: images without EXIF still record format/dimensions, and a parse failure
never fails the upload. Needs the optional `exif-reader` dependency (bundled).

## Storage quotas

Each user has an optional `storage_quota_bytes` (null = unlimited). **Session
uploads** (a logged-in editor/admin using their own token) are metered against the
sum of that user's active files; token/cluster/Strapi-provider uploads have no owner
and are **unmetered**. An over-quota upload is rejected **413** — pre-checked against
`Content-Length` before the body is stored, with a post-write backstop for chunked
uploads (the file is rolled back so it is never served, replicated, or indexed).
Admins set a quota with `POST /_api/users/:id/quota {bytes|null}` or in the console
(Users → **Quota**), and `GET /_api/auth/me` returns the caller's `{usedBytes,
quotaBytes}`.

## Trash & Recovery

With the DB layer on, `DELETE /<path>` **moves** the master into a trash area
(`TRASH_DIR`, default a `.media-trash` sibling of `MASTER_DIR`) and marks the `files`
row `trashed`, instead of unlinking it. The bytes leave `MASTER_DIR`, so the file
404s and cluster peers still receive their delete — but it can be brought back:

- `POST /_api/files/restore {path}` — moves the bytes back, re-activates the row,
  restores a private sidecar if needed, and re-replicates the master to peers.
- `POST /_api/files/purge {path}` — deletes the retained bytes and the row for good.
- `POST /_api/trash/empty` — purges everything trashed (admin).

In the console, trashed files (Files → Status: **Trashed**) show **♻️ Restore** and
**🗑 Delete forever** in their preview, plus an admin **Empty trash** button.

The trash dir is deliberately **outside** `MASTER_DIR` so trashed bytes are never
servable, and a **sibling** of it so the move is an atomic same-volume rename (with a
copy+unlink fallback across volumes). Without a DB, `DELETE` hard-unlinks exactly as
before — trash needs the `files` row as its manifest. Replicated deletes (from a
peer) always hard-unlink; trash is a primary-node recovery concept.

### Related env

| Var | Default | Meaning |
|---|---|---|
| `TRASH_DIR` | `<MASTER_DIR>/../.media-trash` | Where deleted masters are retained (DB layer only) |

## Duplicate detection

Every upload is hashed (sha256) as it streams and the checksum is stored on the
`files` row (image uploads also capture pixel `width`/`height`). `GET
/_api/files/duplicates` returns groups of files sharing a checksum plus the total
reclaimable bytes; the console surfaces this under Files → **🔎 Duplicates**. Hashing
adds no extra disk read (it piggybacks on the existing upload stream) and is skipped
entirely when the upload is rejected.

### Example

```bash
# bootstrap the admin account
curl -X POST localhost:3000/_api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"admin@rutba.pk","username":"admin","password":"Secret123!"}'
# → {"user":{...},"token":"<TOKEN>","roles":["admin"]}

# search the file index
curl localhost:3000/_api/files?q=logo \
  -H "authorization: Bearer <TOKEN>"
```

## What this unlocks (feature-listing mapping)

This layer is the foundation the DAM/cloud-file feature taxonomy depends on. Live now:

- **File Management** — File Upload, File Download, File Preview, Drag & Drop Upload,
  Bulk Upload, Folder Organization (path prefixes) via the console; **Duplicate
  Detection** (sha256, live); **Trash & Recovery** (restore/purge/empty, live).
- **Media Management** — Image/Video/Audio/Document preview + Thumbnail Generation
  (image resize **and video poster frames**), **Media Conversion** (image formats +
  **on-demand video transcode**) surfaced in the console grid & preview; **Metadata
  Management** (image EXIF + **video/audio duration, codecs, dimensions** via ffprobe).
- **Security** — User Authentication, Role-Based Access Control, User Permissions,
  Audit Logs (`audit_log`), **Secure File Sharing** + **Password-Protected Links**.
- **Collaboration** — **Link Sharing** (view/download, expiry, download caps).
- **Integrations** — REST API (`/_api`), S3 pull-through source, **WebDAV** (mount
  the store as a network drive).
- **Administration** — User Management, **Storage Quotas** (per-user, enforced),
  Storage Monitoring (`/_api/stats` + **`/_api/storage` multi-volume free space**),
  System Logs (audit), **Restore Files** (trash).
- **Search** — File listing, Full-Text/Metadata Search, File-Type Filters, **Tag
  Search** (`/_api/files?tag=`).
- **Mobile Access** — Responsive Web Interface, Mobile File Upload/Preview (the
  console is responsive).

Schema is already in place (unused until each feature ships) for: folders, tags,
file versions, shareable/password-protected links, and comments — i.e. Folder
Organization, Version Control, Tag Search, Secure/Password-Protected Sharing, and
File Comments.

## Design guarantees

1. **Off ⇒ unchanged.** No `DB_HOST` ⇒ `createDb()` returns an inert stub; every
   handler runs its original path. The full 26-test suite passes with the DB off.
2. **Best-effort indexing.** `fileindex.js` swallows DB errors, so a PUT/DELETE never
   fails because of the database.
3. **Isolated namespace.** New surface lives under `/_api/`; media routing is
   untouched.
