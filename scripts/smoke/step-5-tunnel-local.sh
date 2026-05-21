#!/usr/bin/env bash
# Tunnel to local wrangler dev (run step-3 and step-4 first).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

SERVER_URL="${SMOKE_SERVER_URL:-http://127.0.0.1:$WRANGLER_PORT}"
CURL_URL="${SERVER_URL%/}/${SMOKE_NAME}/"
PIDFILE="$STATE_DIR/tunnel.pid"
LOG="$STATE_DIR/tunnel.log"
stop_pid "$PIDFILE"

log "captun $HTTP_PORT --name $SMOKE_NAME --server-url $SERVER_URL"
$CAPTUN_BIN "$HTTP_PORT" --name "$SMOKE_NAME" --server-url "$SERVER_URL" >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
wait_for_log "$LOG" "Press Ctrl+C to close tunnel" 30

log "curl $CURL_URL"
BODY="$STATE_DIR/curl-body.txt"
CODE="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 15 "$CURL_URL" || true)"
stop_pid "$PIDFILE"

if [[ "$CODE" != "200" ]]; then
  cat "$LOG" >&2
  cat "$BODY" >&2 || true
  fail "curl got HTTP $CODE (expected 200)"
fi
pass "tunnel + curl -> 200 (log: $LOG)"
