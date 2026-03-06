# ---- Builder Stage ----
FROM node:24-alpine AS builder

# Install build tools required for re2 native module
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (layer caching)
# --ignore-scripts avoids triggering `prepare` (build) before source is copied
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild

# Copy source and build
COPY src/ ./src/
COPY tsconfig.json tsconfig.build.json ./
COPY scripts/ ./scripts/
COPY assets/ ./assets/
RUN npm run build

# Remove dev dependencies (keep pre-compiled native modules)
RUN npm prune --production

# ---- Release Stage ----
FROM node:24-alpine

ENV NODE_ENV=production

# Labels for Docker MCP Catalog
LABEL org.opencontainers.image.title="Filesystem MCP" \
      org.opencontainers.image.description="MCP server for local filesystem access — read, write, search, diff, patch, and manage files. Designed for LLMs and AI agents to interact with the filesystem safely and efficiently." \
      org.opencontainers.image.source="https://github.com/j0hanz/filesystem-mcp" \
      org.opencontainers.image.licenses="MIT" \
      io.modelcontextprotocol.server.name="io.github.j0hanz/filesystem-mcp"

# Create non-root user
RUN adduser -D mcp

WORKDIR /app

# Copy built artifacts and pre-compiled dependencies from builder
COPY --from=builder /app/dist ./dist/
COPY --from=builder /app/node_modules ./node_modules/
COPY --from=builder /app/package.json ./
COPY --from=builder /app/assets ./assets/

USER mcp

ENTRYPOINT ["node", "dist/index.js"]
