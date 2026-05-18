#!/usr/bin/env bash
# Shared helpers for captun smoke-test steps.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STATE_DIR="${CAPTUN_SMOKE_DIR:-/tmp/captun-smoke}"
CAPTUN_BIN="${CAPTUN_BIN:-node $ROOT/dist/cli.mjs}"
HTTP_PORT="${SMOKE_HTTP_PORT:-3456}"
WRANGLER_PORT="${SMOKE_WRANGLER_PORT:-8787}"
SMOKE_NAME="${SMOKE_NAME:-smoke-test}"

mkdir -p "$STATE_DIR"

log() { printf '==> %s\n' "$*"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

wait_for_log() {
  local file="$1"
  local pattern="$2"
  local timeout="${3:-90}"
  local i=0
  while (( i < timeout )); do
    if [[ -f "$file" ]] && grep -q "$pattern" "$file"; then
      return 0
    fi
    sleep 1
    (( i++ )) || true
  done
  fail "timed out after ${timeout}s waiting for '$pattern' in $file"
}

stop_pid() {
  local pidfile="$1"
  [[ -f "$pidfile" ]] || return 0
  local pid
  pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  rm -f "$pidfile"
}
