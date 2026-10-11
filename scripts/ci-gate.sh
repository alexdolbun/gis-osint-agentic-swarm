#!/usr/bin/env bash
# ci-gate.sh — the one gate that must pass before anything is deployed or
# pushed. It is deliberately narrow and fast, and it fails loudly.
#
#   bash scripts/ci-gate.sh
#
# Gates:
#   G1  typecheck          — no type errors anywhere (src, cloudflare, scripts, tests)
#   G2  QAA suite          — cache, auth, load, conductor, agents, alpha, policy
#   G3  open-stack policy  — NO paid/proprietary GIS provider host in shipped code
#   G4  open origin pinned — the edge worker actually serves tiles.openfreemap.org
#   G5  cache floor        — bench hit rate stays above the 60% economic floor
#   G6  swarm smoke        — a full offline conductor run completes with 0 failures
set -uo pipefail

cd "$(dirname "$0")/.."

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "== G1 typecheck =="
if bunx tsc --noEmit; then ok "typecheck clean"; else bad "typecheck"; fi

echo "== G2 QAA suite =="
if bun test 2>&1 | tail -4; then ok "QAA suite"; else bad "QAA suite"; fi

echo "== G3 open-stack policy (shipped code only) =="
# Hostnames only — prose elsewhere may name a competitor without violating the mandate.
BANNED='api\.mapbox\.com|tiles\.mapbox\.com|mapbox://|maps\.googleapis\.com|maps\.google\.com|maptiler\.com|stadiamaps\.com|cartocdn\.com|arcgisonline\.com|tomtom\.com|hereapi\.com|virtualearth\.net|maps\.yandex'
if hits=$(grep -rInE "$BANNED" src cloudflare scripts --exclude=ci-gate.sh 2>/dev/null) && [ -n "$hits" ]; then
  echo "$hits"; bad "paid GIS provider host present in shipped code"
else
  ok "no paid GIS provider host in src/, cloudflare/, scripts/"
fi

echo "== G4 open origin pinned =="
if grep -q 'tiles\.openfreemap\.org' cloudflare/gis-edge-worker.ts; then ok "edge worker pins the open origin"; else bad "edge worker missing open origin"; fi

echo "== G5 cache floor =="
if bun run scripts/cache-bench.ts 2>&1 | tail -3; then ok "cache bench above floor"; else bad "cache bench below floor"; fi

echo "== G6 swarm smoke (offline, deterministic) =="
if bun run scripts/run-swarm.ts --offline --demo --cities 4 >/tmp/ci-swarm.log 2>&1; then
  ok "conductor run completed"; grep -E '^(tasks=|cache:|alpha:)' /tmp/ci-swarm.log | sed 's/^/        /'
else
  bad "conductor run failed"; tail -25 /tmp/ci-swarm.log
fi

echo
echo "gate summary: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
