#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
LOG="$STATE_DIR/step-1-workers-dev-dry-run.log"
log "captun deploy --dry-run (workers.dev)"
$CAPTUN_BIN deploy --dry-run --token smoke-dry-run-token >"$LOG" 2>&1
grep -q "Dry run complete" "$LOG" || fail "see $LOG"
pass "workers.dev dry-run (log: $LOG)"
