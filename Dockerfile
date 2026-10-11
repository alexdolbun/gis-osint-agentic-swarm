# gis-osint-agentic-swarm — one image, two targets
#
#   docker build -t gis-osint-swarm .                 # runtime (default)
#   docker build --target gate -t gis-osint-swarm-gate .
#
# Runtime deps are only bun + bash. The swarm itself is dependency-free: WebCrypto
# for signatures, pure math for geo, one LRU for every cache. Nothing here
# reaches a paid GIS provider.

FROM oven/bun:1.2-debian AS base
WORKDIR /app
ENV NODE_ENV=production \
    BUN_INSTALL_CACHE_DIR=/tmp/bun-cache

# ── deps (dev only: typescript + @types/bun, for typecheck/QAA) ───────────────
FROM base AS deps
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# ── runtime: source + tooling, non-root, no network required in demo mode ─────
FROM base AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY cloudflare ./cloudflare
COPY data ./data
COPY docs ./docs
COPY tests ./tests
COPY README.md LICENSE ./
RUN mkdir -p out backups && chown -R bun:bun /app
USER bun

ENV SWARM_MODE=demo \
    SWARM_CITIES=6 \
    SWARM_CONCURRENCY=8 \
    SWARM_RATE_PER_MIN=120 \
    SWARM_OUT=out

# Deterministic offline swarm run. Override with:
#   docker run --rm gis-osint-swarm bun run swarm --live --cities 12
CMD ["bash", "-lc", "if [ \"$SWARM_MODE\" = live ]; then bun run swarm --live --cities \"$SWARM_CITIES\" --concurrency \"$SWARM_CONCURRENCY\" --rate \"$SWARM_RATE_PER_MIN\" --out \"$SWARM_OUT\"; else bun run swarm --offline --demo --cities \"$SWARM_CITIES\" --concurrency \"$SWARM_CONCURRENCY\" --out \"$SWARM_OUT\"; fi"]

# ── gate: the full CI gate, inside the image ──────────────────────────────────
FROM deps AS gate
COPY . .
RUN chmod +x scripts/*.sh
CMD ["bash", "scripts/ci-gate.sh"]
