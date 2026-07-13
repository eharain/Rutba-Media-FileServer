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
| `ALLOW_REGISTRATION` | `false` | Allow open self-service `POST /_api/auth/register`. The **first** account is always allowed (bootstrap admin) regardless. |
| `SESSION_TTL_DAYS` | `30` | Login session lifetime |
| `READ_AUTH_MODE` | `public` | `public` (open, as today) · `mixed` (private files need auth) · `private` (all reads need auth). *Reserved — enforcement lands with the read-auth phase; currently reads stay public.* |

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
| `GET  /_api/auth/me` | bearer | Current user + roles |
| `GET  /_api/users` | admin | List users |
| `POST /_api/users` | admin | Create user `{email, username, password, role?}` |
| `POST /_api/users/:id/roles` | admin | Grant a role `{role}` |
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
| `GET  /_api/stats` | admin | File count, storage bytes, trashed, users |
| `GET  /_api/storage` | admin | Storage volumes with free/total space + placement policy |

¹ First account always allowed; subsequent self-registration needs `ALLOW_REGISTRATION=true`.

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
