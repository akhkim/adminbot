#!/usr/bin/env bash
# One poster print pass, shaped for an OpenClaw cron `command` job.
#
# For every conference site with an accepted lab paper, files the reminders due today (three
# weeks, one week and two days before the print deadline) and, once the deadline arrives, the
# aggregated print list for the batch's printer. Everything it files is a `slack.send_message`
# proposal waiting for an admin; nothing reaches Slack from this script.
#
# The service token is enough: the run route takes nothing from the caller and recomputes every
# batch from state, so a repeated run files nothing new.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "poster print" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'poster print: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/poster-printing/scheduled-run"
)" || {
  adminbot_curl_failure "poster print" "$?" "$PORT"
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'poster print: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"poster print: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

print(
    "poster print: "
    f"{result.get('reminders_filed', 0)} reminder(s) and {result.get('handoffs_filed', 0)} print list(s) "
    f"filed for approval, {result.get('withdrawn', 0)} withdrawn, "
    f"{result.get('skipped_unreachable', 0)} skipped (no Slack or do-not-contact)"
)
PY
