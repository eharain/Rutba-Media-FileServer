# Deploying the media service

Two targets — pick per site.

## A) VPS (Docker behind the shared Caddy) — recommended for rutba.pk
Masters live in a Docker volume; the migration populates them. No external access needed.

```bash
docker network create edge 2>/dev/null || true            # shared with the ERP Caddy
cd deploy
MEDIA_UPLOAD_TOKEN='<strong-secret>' docker compose up -d --build
```
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
