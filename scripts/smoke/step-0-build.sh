#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
log "Building captun"
pnpm run build
pass "build complete"
