#!/usr/bin/env bash
# Run captun smoke-test steps. Usage:
#   ./scripts/smoke-test.sh              # steps 0-5 (local)
#   ./scripts/smoke-test.sh step-3       # one step
#   ./scripts/smoke-test.sh list
#   ./scripts/smoke-test.sh stop

set -euo pipefail

DIR="$(cd "$(dirname "$0")/smoke" && pwd)"

list_steps() {
  cat <<'EOF'
Steps (run in order for local smoke):

  step-0-build                    pnpm build
  step-1-deploy-dry-run-workers   captun deploy --dry-run
  step-2-deploy-dry-run-wildcard  captun deploy --dry-run --route '*.captun.example.com/*'
  step-3-wrangler-dev             background wrangler dev (:8787)
  step-4-http-origin              background python http.server (:3456)
  step-5-tunnel-local             captun + curl via local wrangler dev
  step-6-tunnel-remote            captun + curl via SMOKE_SERVER_URL (deployed Worker)
  step-stop                       kill background processes

Local all-in-one:  ./scripts/smoke-test.sh
Remote tunnel only: SMOKE_SERVER_URL=https://... ./scripts/smoke-test.sh step-6

State/logs: $CAPTUN_SMOKE_DIR (default /tmp/captun-smoke)
EOF
}

run_step() {
  local step="$1"
  local script="$DIR/${step}.sh"
  [[ -f "$script" ]] || fail "unknown step: $step (try: ./scripts/smoke-test.sh list)"
  bash "$script"
}

main() {
  local cmd="${1:-all}"
  case "$cmd" in
    list) list_steps ;;
    stop) run_step step-stop ;;
    all)
      run_step step-0-build
      run_step step-1-deploy-dry-run-workers
      run_step step-2-deploy-dry-run-wildcard
      run_step step-3-wrangler-dev
      run_step step-4-http-origin
      run_step step-5-tunnel-local
      run_step step-stop
      ;;
    step-*)
      run_step "$cmd"
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      list_steps
      exit 1
      ;;
  esac
}

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
main "$@"
