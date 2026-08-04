#!/usr/bin/env bash
# One pass of the hourly email processor, shaped for an OpenClaw cron `command` job.
#
# This replaces the jinesis-adminbot-email.timer that install-user-services.sh now deletes, so the
# schedule lives in the cron database and shows up in the Control UI's Cron tab with its run history
# and last error. The processor prints its JSON summary and exits non-zero when a message failed, so
# the run surfaces as red rather than silently green; this wrapper only supplies the environment the
# systemd unit used to hand it.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "email automation" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'email automation: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

# The unit set these alongside the env file; the reimbursement/receipt passes shell out to python.
export NODE_ENV="${NODE_ENV:-production}"
export PYTHONPATH="${PYTHONPATH:-$HOME/.local/share/jinesis-adminbot/python-libs}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-email-automation.ts"
