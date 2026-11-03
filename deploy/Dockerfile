# Fleet's production images, built from the repo root by docker-compose.prod.yml:
#   server  the API and the worker (one image, two commands); the API applies migrations
#   web     the built web app behind nginx, which also passes /api on to the API
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
# Prisma's engines need OpenSSL, which the slim image leaves out.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.34.9 --activate
WORKDIR /app

# Every workspace manifest, so a frozen install sees the whole lockfile. The Prisma schema
# comes too: packages/db runs `prisma generate` when it installs.
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY apps/mobile/package.json apps/mobile/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/server/package.json packages/server/
COPY packages/db/prisma packages/db/prisma

# ── Build ─────────────────────────────────────────────────────────────────────
FROM manifests AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@carbooking/api..." --filter "@carbooking/worker..." --filter "@carbooking/web..."
COPY . .
RUN pnpm --filter @carbooking/api build && pnpm --filter @carbooking/worker build

# Vite bakes VITE_* into the bundle at build time, so they come in as build arguments.
ARG VITE_API_URL=/api
ARG VITE_AUTH_MODE=entra
ARG VITE_ENTRA_CLIENT_ID=
ARG VITE_ENTRA_TENANT_ID=
ARG VITE_ENTRA_API_SCOPE=
ARG VITE_ENTRA_NATIVE_REDIRECT=ke.co.fleet.app://auth
ARG VITE_GOOGLE_MAPS_API_KEY=
ARG VITE_GOOGLE_MAPS_MAP_ID=
ARG VITE_VAPID_PUBLIC_KEY=
ARG VITE_ALLOW_WEB_TRIPS=false
ARG VITE_APP_NAME=Fleet
RUN VITE_API_URL=$VITE_API_URL VITE_AUTH_MODE=$VITE_AUTH_MODE \
    VITE_ENTRA_CLIENT_ID=$VITE_ENTRA_CLIENT_ID VITE_ENTRA_TENANT_ID=$VITE_ENTRA_TENANT_ID \
    VITE_ENTRA_API_SCOPE=$VITE_ENTRA_API_SCOPE VITE_ENTRA_NATIVE_REDIRECT=$VITE_ENTRA_NATIVE_REDIRECT \
    VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY VITE_GOOGLE_MAPS_MAP_ID=$VITE_GOOGLE_MAPS_MAP_ID \
    VITE_VAPID_PUBLIC_KEY=$VITE_VAPID_PUBLIC_KEY VITE_ALLOW_WEB_TRIPS=$VITE_ALLOW_WEB_TRIPS \
    VITE_APP_NAME=$VITE_APP_NAME \
    pnpm --filter @carbooking/web build

# ── API and worker ────────────────────────────────────────────────────────────
FROM manifests AS server
ENV NODE_ENV=production
# Production dependencies only. The bundles in dist/ carry our own packages; these are the
# third-party ones they leave external, plus the Prisma CLI for `migrate deploy`.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@carbooking/api..." --filter "@carbooking/worker..."
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
# Mount points for the photo store and the WhatsApp session, owned by the user that runs.
RUN mkdir -p /data/storage /data/whatsapp-auth && chown -R node:node /data
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]

# ── Web ───────────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine AS web
COPY deploy/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
