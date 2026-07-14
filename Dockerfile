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
COPY --from=server-build /app/server/dist ./dist
COPY server/prisma ./prisma

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
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
