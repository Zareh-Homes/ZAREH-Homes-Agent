# Back office API. Node 22.18+ runs the TypeScript sources directly (type stripping).
FROM node:22.23.3-bookworm-slim AS deps
# Prisma picks its query engine from the OpenSSL it finds at generate time; without it here it builds
# for OpenSSL 1.1 and the runtime image (OpenSSL 3) can't load it
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY brokerage-db/schema.prisma /app/brokerage-db/schema.prisma
COPY backend/package.json backend/package-lock.json ./
# Everything comes from the lockfile (including its security overrides): install, generate the client, drop dev tools
RUN npm ci --ignore-scripts && npx prisma generate --schema ../brokerage-db/schema.prisma && npm prune --omit=dev

FROM node:22.23.3-bookworm-slim
ENV NODE_ENV=production
# The running API only needs node, so the package managers bundled with the base image (and their
# dependencies) are removed from the runtime image
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home /app appuser \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app/backend
COPY --from=deps /app/backend/node_modules ./node_modules
COPY brokerage-db/schema.prisma /app/brokerage-db/schema.prisma
COPY commission-engine/src /app/commission-engine/src
COPY backend/package.json ./
COPY backend/src ./src
COPY backend/scripts ./scripts
RUN mkdir -p /var/lib/zareh/uploads && chown appuser /var/lib/zareh/uploads
USER appuser
ENV UPLOAD_DIR=/var/lib/zareh/uploads HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# The config check runs first: the container won't start with an unsafe production configuration
CMD ["sh", "-c", "node scripts/check-config.ts && exec node src/server.ts"]
