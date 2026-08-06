#!/usr/bin/env bash
# One refresh of the Vector sponsor spreadsheet, shaped for an OpenClaw cron `command` job.
#
# Monthly cadence: the sheet only has to be current enough that our sponsor contact reads a live
# roster when he decides whether to extend or remove an account. Sharing was done by hand once and
# is not re-done here. Secrets come from the env file, never the cron spec, which is stored in the
# database and rendered in the Control UI's Cron tab.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "vector roster sync" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'vector roster sync: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-vector-roster-sync.ts" "$@"
