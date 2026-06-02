# Media migration

Moves a Strapi site's media to the masters-only media service and rewrites the DB.
Provider-agnostic (handles both local `/uploads/...` and remote S3 layouts) — it never
parses variant filenames; it uses each `files` row's master `url` + per-format `width`.

```bash
cd migrate
npm install            # mysql2 (+ optional pg)
```

## Run
```bash
# rutba.pk (local-stored media): masters read from the Strapi public dir
node migrate.js \
  --db-client mysql --db-host 127.0.0.1 --db-port 3306 \
  --db-name pos_db --db-user pos_user --db-pass '****' \
  --media-base https://images.rutba.pk --upload-token '****' \
  --uploads-dir /srv/strapi/public \
  --formats compact --concurrency 8 [--dry-run] [--limit 50] [--verbose]

# trustlist (S3-stored media): masters fetched over HTTP from row.url (public bucket)
node migrate.js \
  --db-client postgres --db-host ... --db-name trustlist --db-user ... --db-pass '****' \
  --media-base https://images.trustlist.uk --upload-token '****' \
  --formats compact [--dry-run]
```

## What it does per `files` row
1. Resolve master bytes: `http(s)://` url → HTTP GET; `/uploads/...` → read `--uploads-dir`.
2. `PUT {media-base}/{key}` (folder preserved, e.g. `general/cover/x.jpg`, `uploads/277/x.jpeg`).
3. `url` → `{media-base}/{key}` (or relative with `--relative`).
4. `formats` → **compact** `{ size: { url:"<master>?w=<width>[&fm=<ext>]", width, height } }`,
   or **drop** (`--formats drop` → `null`).
5. Variant files are never uploaded.

## Flags
| Flag | Default | |
|---|---|---|
| `--db-client` | `mysql` | `mysql` \| `postgres` |
| `--db-host/-port/-name/-user/-pass` | — | DB connection |
| `--table` | `files` | Strapi files table |
| `--media-base` | — | e.g. `https://images.rutba.pk` (required) |
| `--upload-token` | — | = service `UPLOAD_TOKEN` (required unless `--dry-run`) |
| `--uploads-dir` | — | Strapi public dir (local media only) |
| `--uploads-url-prefix` | `/uploads` | URL prefix that maps to `--uploads-dir` |
| `--formats` | `compact` | `compact` \| `drop` |
| `--relative` | off | write `/key` URLs instead of absolute |
| `--concurrency` | `8` | parallel rows |
| `--limit` | `0` | cap rows (testing) |
| `--dry-run` | off | no writes; log intended changes |
| `--verbose` | off | per-row logging |

**Idempotent & resumable:** rows whose `url` already points at `--media-base` (or whose
formats are already compacted, in `--relative` mode) are skipped, so re-runs are safe.
Always `--dry-run` first, and back up the DB before a real run.
