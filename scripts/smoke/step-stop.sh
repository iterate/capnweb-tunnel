#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
stop_pid "$STATE_DIR/tunnel.pid"
stop_pid "$STATE_DIR/tunnel-remote.pid"
stop_pid "$STATE_DIR/wrangler.pid"
stop_pid "$STATE_DIR/http.pid"
log "stopped background processes (state: $STATE_DIR)"
