#!/usr/bin/env bash
# One pass over the meeting artifact drop folder, shaped for an OpenClaw cron `command` job.
#
# The recording notices need no job of their own: the hourly email pass files those as it reads the
# inbox. This is the other half — the transcript and participant CSV a host exports from Zoom by
# hand and drops in Drive, which nothing pushes at us and so has to be polled.
#
# Hourly is plenty. A file dropped an hour after the meeting is attached an hour later, and the
# pass is idempotent: an artifact already folded in is skipped by file id, and one that matched no
# meeting is retried next time, because the meeting it belongs to may not have been filed yet.
#
# stdout is the run summary and a non-zero exit turns the run red in the Cron tab.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "meeting artifacts" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'meeting artifacts: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

# Named here rather than left to fail inside the pass: the folder id is the one piece of deployment
# configuration this job cannot be run without, and the message should say so before any network
# call is made.
[[ -n "${ADMINBOT_MEETING_DROP_FOLDER_ID:-}" ]] || {
  printf 'meeting artifacts: ADMINBOT_MEETING_DROP_FOLDER_ID is not set in %s.\n' \
    "${ADMINBOT_ENV_FILE:-the AdminBot env file}" >&2
  printf 'Set it to the Drive folder id hosts drop transcripts and participant CSVs into.\n' >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-meeting-artifacts.ts"
