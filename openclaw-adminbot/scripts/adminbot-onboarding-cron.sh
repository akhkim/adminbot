#!/usr/bin/env bash
# Onboarding-nudge confirmation loop, shaped like adminbot-deadline-cron.sh for OpenClaw cron
# `command` jobs so it can run on a schedule and from the Control UI's Tasks & Tools tab.
#
# One pass does both halves per member: record a confirming ✅ reaction on the newest nudge DM as
# a step completion, and re-nudge anyone whose newest nudge is older than the cadence. Confirmation
# is checked before the cadence, so a member who reacted is never re-nudged by the same run.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"

usage() {
  cat <<'EOF'
Usage: adminbot-onboarding-cron.sh <task> [step]

Tasks:
  confirm-preview [step]   Show what a pass would confirm or re-nudge; sends and writes nothing
  confirm [step]           Record ✅ reactions and re-nudge stale members (sends DMs, writes roster)

step is an onboarding step id and defaults to linkedin.
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${ADMINBOT_PYTHON:-/usr/bin/python3}"

task="${1:-}"
step="${2:-linkedin}"
[[ -n "$task" ]] || {
  usage >&2
  exit 2
}

adminbot_load_cron_env "onboarding $task" || exit 1

case "$task" in
  confirm-preview)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot_onboarding_confirm.py" --step "$step"
    ;;
  confirm)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot_onboarding_confirm.py" --step "$step" --live
    ;;
  *)
    printf 'unknown task: %s\n' "$task" >&2
    usage >&2
    exit 2
    ;;
esac
