# Deploying the media service

Two targets — pick per site.

## A) VPS (Docker behind the shared Caddy) — recommended for rutba.pk
Masters live in a Docker volume; the migration populates them. No external access needed.

Two modes, one command each. **Origin-only** is the plain masters-only resize origin —
no database, no console, no accounts:

```bash
docker network create edge 2>/dev/null || true            # shared with the ERP Caddy
cd deploy
MEDIA_UPLOAD_TOKEN='<strong-secret>' docker compose up -d --build
```

**Full platform** adds MySQL and everything gated behind it — accounts + RBAC, the
`/_ui/` console, file index & search, audit trail, share links, trash & recovery, the
`/_dav/` WebDAV mount and the background job queue:

```bash
cd deploy
cp ../.env.example .env        # set MEDIA_UPLOAD_TOKEN and MYSQL_PASSWORD at minimum
docker compose -f docker-compose.yml -f docker-compose.platform.yml up -d --build
```
The database and its schema are created on first boot; the **first account you register
becomes the admin**:
```bash
curl -sX POST https://images.rutba.pk/_api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","username":"you","password":"<strong>"}'
```
Then open **`https://images.rutba.pk/_ui/`** and log in. Mount the store as a network
drive from `https://images.rutba.pk/_dav/` using the same credentials.

**Persistence.** Three named volumes must outlive the container: `media_masters`
(the masters), `media_db` (accounts, index, audit) and `media_trash` (recoverable
deletes — `TRASH_DIR=/data/trash` is set explicitly for exactly this reason). Only
`media_cache` is safe to discard.

**Pre-existing masters.** Files copied or mounted in directly are served correctly but
are invisible to the index until they are scanned. After bringing up full-platform
mode over an existing master directory, run a scan (console → Storage → *Scan
volumes*, or `POST /_api/jobs` with `{"type":"scan"}`), or set `SCAN_ON_BOOT=1`.
Add `Caddyfile.snippet` to the edge Caddy and reload:
```
images.rutba.pk { reverse_proxy image-server:3000 }
```
DNS: `images.rutba.pk A -> <VPS IP>`. Then populate + rewrite the DB:
```bash
cd ../migrate && npm install
node migrate.js --db-client mysql --db-host <mysql> --db-name pos_db --db-user pos_user \
  --db-pass '****' --media-base https://images.rutba.pk --upload-token '<same secret>' \
  --uploads-dir /path/to/strapi/public --formats compact --dry-run   # then drop --dry-run
```
> Shortcut to skip copying files: mount the existing Strapi uploads volume read-only as the
> master dir (see the commented line in `docker-compose.yml`) — then only the DB rewrite is needed.

## B) Hostinger Business hosting (Node.js app) — for images.trustlist.uk
hPanel → the domain → **Node.js**: Node 18+, startup `server.js`, **Run NPM Install** (sharp),
app root = upload folder. Set env `UPLOAD_TOKEN`, `MASTER_DIR`, `CACHE_DIR`, `CACHE_MAX_BYTES`.
Masters arrive via the migration script's authenticated `PUT`. (Details in the root `README.md`.)

## Wire Strapi (both sites)
Install the provider (`../provider`), then in `config/plugins.js`:
```js
upload: { config: {
  provider: 'strapi-provider-upload-media',
  providerOptions: { baseUrl: env('MEDIA_BASE_URL'), uploadToken: env('MEDIA_UPLOAD_TOKEN'), skipVariants: true },
}}
```
and add the media host to `strapi::security` CSP `img-src`/`media-src` in `config/middlewares.js`.
Point the apps' image origin (`NEXT_PUBLIC_IMAGE_URL`) at the media host and rebuild.
