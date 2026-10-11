#!/usr/bin/env bash
# backup-sync.sh — continuous, idempotent backup of the swarm.
#
#   bash scripts/backup-sync.sh            # snapshot + commit + push (if a remote exists)
#   bash scripts/backup-sync.sh --dry      # snapshot only, no git writes
#
# Three targets, cheapest first, so a failure never loses the previous copy:
#   1. LOCAL   — a timestamped tarball under ./backups (repo tree minus node_modules)
#   2. MIRROR  — an extracted copy under ~/backups/gis-osint-agentic-swarm/ (survives a wiped repo)
#   3. GITHUB  — commit + push when an origin remote is reachable
#
# Cloudflare mirroring is delegated to wrangler: if CLOUDFLARE_API_TOKEN is set
# and the KV binding exists, the run-state artifacts are pushed to KV so the
# edge can serve the latest report without a redeploy.
set -uo pipefail

cd "$(dirname "$0")/.."
DRY=0; [ "${1:-}" = "--dry" ] && DRY=1

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BASE="$(basename "$PWD")"
mkdir -p backups
SNAP="backups/${BASE}-${STAMP}.tar.gz"

echo "== snapshot =="
tar --exclude=node_modules --exclude=.git --exclude=backups --exclude=out \
    -czf "$SNAP" . 2>/dev/null && echo "  wrote $SNAP ($(du -h "$SNAP" | cut -f1))"

MIRROR="$HOME/backups/${BASE}"
if mkdir -p "$MIRROR" 2>/dev/null && tar -xzf "$SNAP" -C "$MIRROR" 2>/dev/null; then
  echo "  mirrored to $MIRROR"
else
  echo "  mirror skipped (unwritable)"
fi

# Keep only the 30 most recent snapshots — a backup dir that grows forever is
# its own outage waiting to happen on a small disk.
ls -1t backups/*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f

if [ "$DRY" -eq 1 ]; then echo "--dry: skipping git/cloudflare"; exit 0; fi

echo "== github =="
if git rev-parse --git-dir >/dev/null 2>&1; then
  git add -A
  if git diff --cached --quiet; then
    echo "  nothing to commit"
  else
    git -c user.name="$(git config user.name || echo zo)" \
        -c user.email="$(git config user.email || echo zo@localhost)" \
        commit -q -m "swarm backup ${STAMP}: report + artifacts" && echo "  committed"
  fi
  if git remote get-url origin >/dev/null 2>&1; then
    git push -q origin HEAD 2>/dev/null && echo "  pushed to origin" || echo "  push failed (offline or no auth) — snapshot retained locally"
  else
    echo "  no origin remote configured"
  fi
else
  echo "  not a git repository"
fi

echo "== cloudflare (optional) =="
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -f out/swarm-report.json ]; then
  echo "  CLOUDFLARE_API_TOKEN present; push out/swarm-report.json to GIS_KV yourself with:"
  echo "    bunx wrangler kv key put --binding=GIS_KV alpha:feed --path=out/alpha-report.json --config cloudflare/wrangler.toml"
else
  echo "  skipped (no CLOUDFLARE_API_TOKEN or no report)"
fi
