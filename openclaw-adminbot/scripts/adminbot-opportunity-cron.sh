#!/usr/bin/env bash
# The Opportunities refresh sweep, shaped for an OpenClaw cron `command` job.
#
# A wrapper rather than the python script directly, for the reason every other job here has one:
# the sweep needs ADMINBOT_SERVICE_TOKEN to file its proposals, and the cron spec is stored in the
# database and rendered in the Control UI's Cron tab -- so the secret is loaded here instead of
# being written into the job. Registered straight from the manifest, this job would have run on
# Aurora with no token at all and exited on the first line, once a week, quietly.
#
# stdout becomes the run summary and a non-zero exit turns the run red, so a sweep that cannot
# reach the service surfaces in the tab rather than looking green.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Same interpreter the deadline jobs use: Aurora's system python has the parsing libraries these
# scripts import, and the linuxbrew one on the dev box does not.
PYTHON="${ADMINBOT_PYTHON:-/usr/bin/python3}"

usage() {
  cat <<'EOF'
Usage: adminbot-opportunity-cron.sh [refresh|preview|discover|discover-preview]

  refresh           Re-read each entry's page, file changed dates as proposals (default)
  preview           Show what refresh would file; writes nothing
  discover          Read the configured hub pages, file new candidates as pending
  discover-preview  Show what discover would file; writes nothing
EOF
}

task="${1:-refresh}"

case "$task" in
  refresh) apply="--apply" ;;
  preview) apply="" ;;
  discover) apply="--apply" ;;
  discover-preview) apply="" ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

adminbot_load_cron_env "opportunity $task" || exit 1

# Named, not just reported missing: the loader takes the first env file that exists, and on a box
# where ~/.config/jinesis-adminbot/adminbot.env exists but holds only a couple of keys it never
# reads ~/.openclaw/.env at all. "not set" sends you looking in the wrong file; "not set in <path>"
# is the whole answer.
[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'opportunity %s: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$task" "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

# The URL differs between Aurora and a dev checkout, and the service is local to both. Same port
# default the other wrappers use.
: "${ADMINBOT_URL:=http://127.0.0.1:${ADMINBOT_PORT:-8765}}"
export ADMINBOT_URL

case "$task" in
  discover | discover-preview) script="adminbot-opportunity-discover.py" ;;
  *) script="adminbot-opportunity-refresh.py" ;;
esac

# shellcheck disable=SC2086
exec "$PYTHON" "$REPO_ROOT/scripts/$script" $apply
