#!/usr/bin/env bash
# Deadline tools, shaped for OpenClaw cron `command` jobs so they can be run from the Control UI's
# Tasks & Tools tab.
#
# Each task is one subcommand rather than one script per job: they all need the same secrets (gog
# keyring for calendar writes, OpenReview credentials for the submitted-paper stop check), and
# loading them here keeps every token out of the cron spec, which is stored in the database and
# rendered in the UI.
#
# stdout becomes the run summary and a non-zero exit turns the run red, so failures surface in the
# tab rather than looking green.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"

usage() {
  cat <<'EOF'
Usage: adminbot-deadline-cron.sh <task>

Tasks:
  calendar-conferences   Publish conference deadlines to the lab calendar (writes)
  calendar-all           Publish every tracked deadline, workshops included (writes)
  calendar-preview       Show what a full sync would change; writes nothing
  refresh-venues         Re-collect venues.json from OpenReview and regenerate the datasets
  refresh-matches        Map lab papers onto upcoming deadlines (writes matches.json)
  reminders-preview      Show which deadline reminders are due today; sends nothing
EOF
}

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${ADMINBOT_PYTHON:-/usr/bin/python3}"
export PYTHONPATH="${PYTHONPATH:-$HOME/.local/share/jinesis-adminbot/python-libs}"

task="${1:-}"
[[ -n "$task" ]] || {
  usage >&2
  exit 2
}

adminbot_load_cron_env "deadline $task" || exit 1

case "$task" in
  calendar-conferences)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-calendar.py" \
      --venue-type conference --send
    ;;
  calendar-all)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-calendar.py" --send
    ;;
  calendar-preview)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-calendar.py"
    ;;
  refresh-venues)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-collect.py"
    ;;
  refresh-matches)
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-match.py"
    ;;
  reminders-preview)
    # The reminder pass reads matches.json, which the match step produces. Without it the script
    # dies on a bare KeyError traceback in the run summary, which says nothing about what to do.
    if [[ ! -f "$REPO_ROOT/extensions/adminbot/deadlines/matches.json" ]]; then
      printf 'deadline reminders: matches.json is missing.\n' >&2
      printf 'Run the "refresh deadline matches" tool first; it needs ADMINBOT_ONGOING_SHEET_ID\n' >&2
      printf 'and ADMINBOT_READY_SHEET_ID in %s.\n' "$ADMINBOT_ENV_FILE" >&2
      exit 1
    fi
    exec "$PYTHON" "$REPO_ROOT/scripts/adminbot-deadline-reminders.py"
    ;;
  *)
    printf 'unknown task: %s\n' "$task" >&2
    usage >&2
    exit 2
    ;;
esac
