#!/usr/bin/env bash
# One pass of the recommendation-letter deadline reminder, shaped for an OpenClaw cron job.
#
# Mails the head professor the letter requests coming due in the next three days -- the same queue
# My Desk shows, read against the clock. One mail per pass however many letters are due, and each
# request is said once per deadline, so a doubled crontab cannot turn this into a daily nag.
#
# Quiet on a morning with nothing close: the run reports zero and sends nothing.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no recipient, no text and no request list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "rec letter reminders" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'rec letter reminders: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/logistics/rec-letter-reminders/run"
)" || {
  printf 'rec letter reminders: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'rec letter reminders: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A letter that is due is worth naming in the run history: this is
# the one mail that goes to the professor's own inbox, so "what did it say" should be answerable
# from the run rather than only from her mailbox.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"rec letter reminders: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

reminded = result.get("reminded", [])
recipient = result.get("recipient")

if not reminded:
    print("rec letter reminders: nothing due in the window")
    raise SystemExit(0)

print(f"rec letter reminders: {len(reminded)} letter(s) mailed to {recipient}")
for entry in reminded:
    print(
        f"  {entry.get('member_id')} due {str(entry.get('deadline_at'))[:10]} "
        f"(in {entry.get('days_until')} day(s))"
    )

raise SystemExit(0)
PY
