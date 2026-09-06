# Multi-stage build (spec §19): production dependencies are installed in their
# own layer so the final image carries no build toolchain or dev packages.

FROM node:20-bookworm-slim AS deps
WORKDIR /app

# bcrypt and sharp ship prebuilt binaries for this platform, but keep the build
# tools available in case a native rebuild is needed on an unusual arch.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-bookworm-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# dumb-init reaps zombies and forwards SIGTERM to Node, which the graceful
# shutdown handler in server.js depends on.
RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY scripts ./scripts

# Uploads and logs are the only writable paths; everything else stays read-only
# to the unprivileged runtime user.
RUN mkdir -p uploads logs && chown -R node:node uploads logs

USER node
EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
