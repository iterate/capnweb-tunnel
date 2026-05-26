#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
LOG="$STATE_DIR/step-2-wildcard-dry-run.log"
log "captun deploy --dry-run (wildcard route)"
$CAPTUN_BIN deploy --dry-run --route '*.captun.example.com/*' --token smoke-dry-run-token >"$LOG" 2>&1
grep -q "Dry run complete" "$LOG" || fail "see $LOG"
grep -q 'https://gateway.captun.example.com' "$LOG" || fail "wildcard gateway not inferred — see $LOG"
pass "wildcard dry-run (log: $LOG)"
