# ================= IMPL-V6 — HOST A (agent) container =================
# Multi-stage. The build stage uses the FULL node:20 image (bookworm) because
# better-sqlite3 compiles a native addon and needs python3 + a C/C++ toolchain,
# which node:20-bookworm includes (via buildpack-deps). The runtime stage is
# slim and receives the already-compiled node_modules + dist from the builder,
# so no toolchain ships in the final image. Both stages share the Debian 12
# (bookworm) glibc, so the compiled .node binary is ABI-compatible.
#
# Build context = the IMPL-V6 project root (see docker-compose.yml).
# Entry = dist/mcp/server-sse.js (package.json "start"); listens on PORT (def 3000).

# ---- build stage ------------------------------------------------------------
FROM node:20-bookworm AS build
WORKDIR /app

# Install deps against the lockfile first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# Compile TypeScript -> dist/ (package.json "build" = tsc -p tsconfig.json).
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Carry the lockfile + the already-built node_modules and dist from the builder,
# then drop dev dependencies (tsx/typescript) without recompiling anything.
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN npm prune --omit=dev

# The SqliteSaver checkpointer writes ./data/audit.db (AUDIT_DB_PATH). Make the
# dir and expose it as a volume mount point so audit history can persist.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Listen port (server-sse.ts: process.env.PORT ?? 3000).
ENV PORT=3000
EXPOSE 3000

# Container-level health check mirrors railway.json's GET /health.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/mcp/server-sse.js"]
