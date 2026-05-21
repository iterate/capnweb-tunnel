#!/usr/bin/env bash
# Tunnel to a deployed Worker (set SMOKE_SERVER_URL and optional CAPTUN_SECRET).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

SERVER_URL="${SMOKE_SERVER_URL:?Set SMOKE_SERVER_URL (e.g. https://captun.account.workers.dev)}"

if [[ "$SERVER_URL" == *"{name}"* ]]; then
  CURL_URL="${SERVER_URL//\{name\}/$SMOKE_NAME}"
else
  CURL_URL="${SERVER_URL%/}/${SMOKE_NAME}/"
fi
CURL_URL="${CURL_URL%/}/"

PIDFILE="$STATE_DIR/tunnel-remote.pid"
LOG="$STATE_DIR/tunnel-remote.log"
stop_pid "$PIDFILE"

log "captun $HTTP_PORT --name $SMOKE_NAME --server-url $SERVER_URL"
if [[ -n "${CAPTUN_SECRET:-}" ]]; then
  $CAPTUN_BIN "$HTTP_PORT" --name "$SMOKE_NAME" --server-url "$SERVER_URL" --secret "$CAPTUN_SECRET" >"$LOG" 2>&1 &
else
  $CAPTUN_BIN "$HTTP_PORT" --name "$SMOKE_NAME" --server-url "$SERVER_URL" >"$LOG" 2>&1 &
fi
echo $! >"$PIDFILE"
wait_for_log "$LOG" "Press Ctrl+C to close tunnel" 30

log "curl $CURL_URL"
BODY="$STATE_DIR/curl-remote-body.txt"
CODE="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 15 "$CURL_URL" || true)"
stop_pid "$PIDFILE"

if [[ "$CODE" != "200" ]]; then
  cat "$LOG" >&2
  cat "$BODY" >&2 || true
  fail "curl got HTTP $CODE (expected 200)"
fi
pass "remote tunnel + curl -> 200"
