# ─────────────────────────────────────────────────────────────────────────────
# One container: the API and the built React app, served from one origin.
#
# Two flows, one image. The client is built and then served by Express as static
# files, so there is no CORS, no second deployment, and no way for the two halves to
# drift out of sync — they ship together or not at all.
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: build the client ───────────────────────────────────────────────
FROM node:20-slim AS client-build
WORKDIR /app/client

COPY client/package*.json ./
RUN npm ci

COPY client/ ./
RUN npm run build

# ── Stage 2: build the server ───────────────────────────────────────────────
FROM node:20-slim AS server-build
WORKDIR /app/server

# OpenSSL, in the BUILD stage, before `npm ci` and `prisma generate`.
#
# Not a duplicate of the runtime install below. Prisma picks its engines by
# detecting the OpenSSL version present at the time: @prisma/engines' postinstall
# (during `npm ci`) downloads the schema engine that `migrate deploy` uses, and
# `prisma generate` picks the query engine. With no openssl on the box neither
# fails — they guess debian-openssl-1.1.x and the image builds green. The runtime
# stage then has openssl 3.0.x, and every query dies with "could not locate the
# Query Engine for runtime debian-openssl-3.0.x" (and `migrate deploy` goes looking
# on the network for the schema engine it does not have). Installed BEFORE
# `npm ci`, so both engines are fetched for the OpenSSL the image actually runs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci

COPY server/ ./
# The Prisma client is generated code — it must exist before tsc runs.
RUN npx prisma generate
RUN npm run build

# ── Stage 3: the image that actually runs ───────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app/server

ENV NODE_ENV=production

# OpenSSL: Prisma's query engine needs it, and node:*-slim does not ship it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY server/package*.json ./
RUN npm ci --omit=dev

# Prisma needs the schema at runtime (migrate deploy on start) and the generated
# client, which is NOT reproducible from node_modules alone.
COPY --from=server-build /app/server/node_modules/.prisma ./node_modules/.prisma
COPY --from=server-build /app/server/node_modules/@prisma ./node_modules/@prisma

# The Prisma CLI, for `migrate deploy`. It is a devDependency, so `npm ci
# --omit=dev` leaves it out, and `npx prisma` then DOWNLOADED whatever prisma was
# latest at container start: no network, no migrations -- and a new major (7)
# against this 5.x schema. Copied from the build stage instead: exactly the
# version server/package-lock.json pins, with the schema engine that
# @prisma/engines (copied above) fetched at build time. Invoke it as
# `node node_modules/prisma/build/index.js`, never `npx`, so nothing is fetched.
COPY --from=server-build /app/server/node_modules/prisma ./node_modules/prisma
# No update-check phone-home from the CLI at container start.
ENV CHECKPOINT_DISABLE=1

COPY --from=server-build /app/server/dist ./dist
COPY server/prisma ./prisma

# Builds DATABASE_URL from POSTGRES_PASSWORD with the password percent-encoded, so
# any password works (see the file). docker-compose.yml runs everything through it.
COPY deploy/docker/with-db-url.js /app/with-db-url.js

# index.ts resolves the client at ../../client/dist relative to dist/, so it lands
# at /app/client/dist.
COPY --from=client-build /app/client/dist /app/client/dist

# Uploads stream to disk (see services/uploadFile.ts). This is EPHEMERAL container
# storage on purpose: raw merchant CSVs are never backed up and die with the
# container, which is a better PII posture than RAM or Postgres.
ENV UPLOAD_DIR=/tmp/qa-uploads
RUN mkdir -p /tmp/qa-uploads && chown node:node /tmp/qa-uploads

# Do not run as root.
USER node

EXPOSE 3001

# Migrations run at START, not at build: the database is not reachable from the
# build. `migrate deploy` is the safe command — it applies pending migrations and
# CANNOT reset or drop anything. Never `migrate dev` here; its drift check can offer
# a destructive reset, and this database has intentional drift (crossReferenceData).
#
# Single-container use: pass DATABASE_URL, or POSTGRES_PASSWORD (+ POSTGRES_HOST)
# and let with-db-url.js encode it.
CMD ["node", "/app/with-db-url.js", "sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && exec node dist/index.js"]
