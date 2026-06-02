# Media service image — Node + sharp, masters-only resize/cache server.
# Build context is the repo root (see deploy/docker-compose.yml: context: ..).
FROM node:22-slim AS base
WORKDIR /app

# Install only runtime deps (sharp). Copy the lockfile too so the build is
# reproducible via `npm ci`. package.json lists sharp as the sole dependency.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MASTER_DIR=/data/masters \
    CACHE_DIR=/data/cache

EXPOSE 3000

# Liveness: hit the built-in /_health endpoint (no curl/wget needed on slim).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# UPLOAD_TOKEN, CACHE_MAX_BYTES, CORS_ORIGIN, VARIANTS etc. provided at runtime.
CMD ["node", "server.js"]
