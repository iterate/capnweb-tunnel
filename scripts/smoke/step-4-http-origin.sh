#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

PIDFILE="$STATE_DIR/http.pid"
LOG="$STATE_DIR/http-origin.log"
stop_pid "$PIDFILE"

log "Starting python http.server on :$HTTP_PORT"
python3 -m http.server "$HTTP_PORT" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
sleep 1
pass "http origin on http://127.0.0.1:$HTTP_PORT"
