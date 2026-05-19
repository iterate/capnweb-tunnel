#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"
LOG="$STATE_DIR/step-2-wildcard-dry-run.log"
log "captun deploy --dry-run (wildcard route)"
$CAPTUN_BIN deploy --dry-run --route '*.tunnels.example.com/*' --secret smoke-dry-run-secret >"$LOG" 2>&1
grep -q "Dry run complete" "$LOG" || fail "see $LOG"
grep -q '{name}.tunnels.example.com' "$LOG" || fail "wildcard URL not inferred — see $LOG"
pass "wildcard dry-run (log: $LOG)"
