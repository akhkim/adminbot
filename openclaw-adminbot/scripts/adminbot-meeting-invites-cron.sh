#!/usr/bin/env bash
# One pass of the meeting invites, shaped for an OpenClaw cron job.
#
# Asks Slack who is in each #meeting-xxx and #proj-xxx channel and hands the lists to the service,
# which reads the calendar, matches each channel to its "Theme:" or "Proj:" event, and files a
# calendar.add_attendees proposal for the people not already on it.
#
# Nothing here invites anybody: every match is a proposal an admin approves. Putting a person on a
# recurring invite is not a thing a nightly pass gets to do quietly.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "meeting invites" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'meeting invites: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-meeting-invites-sync.ts" "$@"
