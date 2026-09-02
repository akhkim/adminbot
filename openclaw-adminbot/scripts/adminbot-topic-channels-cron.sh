#!/usr/bin/env bash
# One pass of the topic channels, shaped for an OpenClaw cron job.
#
# Asks Slack which #discussion-xxx and #meeting-xxx channels exist, and hands the list to the
# service, which decides who belongs in each from their stated interests and the projects they are
# on. Idempotent through Slack: already_in_channel is success, so a member who is already there
# costs one call and changes nothing.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "topic channels" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'vector roster sync: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-topic-channels-sync.ts" "$@"
