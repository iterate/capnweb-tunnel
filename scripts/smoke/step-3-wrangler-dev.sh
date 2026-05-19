#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

PIDFILE="$STATE_DIR/wrangler.pid"
LOG="$STATE_DIR/wrangler-dev.log"
stop_pid "$PIDFILE"

log "Starting wrangler dev on :$WRANGLER_PORT (log: $LOG)"
./node_modules/.bin/wrangler dev --port "$WRANGLER_PORT" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
wait_for_log "$LOG" "Ready on http://" 90
pass "wrangler dev ready at http://127.0.0.1:$WRANGLER_PORT"
