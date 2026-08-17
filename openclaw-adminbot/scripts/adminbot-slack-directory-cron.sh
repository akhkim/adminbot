#!/usr/bin/env bash
# Refreshes the Slack channel directory, shaped for an OpenClaw cron `command` job.
#
# Prints one JSON array of every human member of ADMINBOT_SLACK_DIRECTORY_CHANNELS (defaulting to
# the three lab channels) with their Slack id, names, timezone, picture and -- given
# users:read.email -- their profile email.
#
# Read-only by design: it never writes to the roster. Joining this to members is
# scripts/adminbot-import-member-sheet.ts's job, which cannot overwrite or create.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "slack channel directory" || exit 1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$ROOT/node_modules/.bin/tsx" "$ROOT/scripts/adminbot-slack-channel-directory.ts" --json
