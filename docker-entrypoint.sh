#!/usr/bin/env bash
# docker-entrypoint.sh — map environment onto conductor flags, then exec.
#
#   SWARM_MODE=demo|live   demo = deterministic fixtures, no sockets (default)
#   SWARM_CITIES=N         how many cities to fan out over
#   SWARM_OUT=dir          artifact directory (default ./out)
set -euo pipefail

MODE="${SWARM_MODE:-demo}"
CITIES="${SWARM_CITIES:-6}"
CONC="${SWARM_CONCURRENCY:-8}"
RATE="${SWARM_RATE_PER_MIN:-120}"
OUT="${SWARM_OUT:-out}"

mkdir -p "$OUT"

case "$1" in
  bun)
    shift
    if [ "${1:-}" = "run" ] && [ "${2:-}" = "swarm" ]; then
      shift 2
      FLAGS=(--cities "$CITIES" --concurrency "$CONC" --rate "$RATE" --out "$OUT")
      if [ "$MODE" = "live" ]; then FLAGS+=(--live); else FLAGS+=(--offline --demo); fi
      echo "[entrypoint] mode=$MODE cities=$CITIES concurrency=$CONC rate/min=$RATE out=$OUT"
      exec bun run scripts/run-swarm.ts "${FLAGS[@]}" "$@"
    fi
    ;;
  gate)
    exec bash scripts/ci-gate.sh
    ;;
esac

exec "$@"
