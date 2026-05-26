#!/usr/bin/env bash
# Tunnel to a deployed Worker (set SMOKE_GATEWAY and optional CAPTUN_TOKEN).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
cd "$ROOT"

GATEWAY="${SMOKE_GATEWAY:?Set SMOKE_GATEWAY (e.g. https://captun.account.workers.dev)}"

PIDFILE="$STATE_DIR/tunnel-remote.pid"
LOG="$STATE_DIR/tunnel-remote.log"
stop_pid "$PIDFILE"

log "captun $HTTP_PORT --name $SMOKE_NAME --gateway $GATEWAY"
if [[ -n "${CAPTUN_TOKEN:-}" ]]; then
  $CAPTUN_BIN "$HTTP_PORT" --name "$SMOKE_NAME" --gateway "$GATEWAY" --token "$CAPTUN_TOKEN" >"$LOG" 2>&1 &
else
  $CAPTUN_BIN "$HTTP_PORT" --name "$SMOKE_NAME" --gateway "$GATEWAY" >"$LOG" 2>&1 &
fi
echo $! >"$PIDFILE"
wait_for_log "$LOG" "Press Ctrl+C to close tunnel" 30
CURL_URL="${SMOKE_TUNNEL_URL:-$(grep -E '^[[:space:]]*https?://[^[:space:]]+$' "$LOG" | tail -n 1 | tr -d '[:space:]' || true)}"
CURL_URL="${CURL_URL%/}/"
[[ -n "$CURL_URL" ]] || fail "could not infer tunnel URL from $LOG"

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
