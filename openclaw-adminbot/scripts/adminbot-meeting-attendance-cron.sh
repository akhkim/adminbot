#!/usr/bin/env bash
# One attendance-nudge pass, shaped for an OpenClaw cron `command` job.
#
# Tells everyone on the group-meeting invite, and every full member, who has missed the last two
# meetings the lab has attendance for -- on Slack, on their dashboard, and as a popup the next time
# they open the Control UI. See sendMeetingAttendanceNudges() in extensions/adminbot/src/kernel/
# service.ts, and workflows/meetings/attendance-nudge.ts for who counts as absent.
#
# The service token is enough here (unlike /nudges/send, which refuses it): the route takes no
# message and no recipient list from the caller -- both are computed entirely from attendance
# records -- so there is no admin-composed content for the service-principal gate to protect.
#
# Safe to run as often as you like. The service keys its ledger on the *pair of meetings*, so a
# second run about the same two says nothing; a new meeting makes a new pair and speaks again.
# Daily, a few hours after the meeting usually ends, is the cadence this was written for: it gives
# a host time to export the participant CSV that the whole thing is measured from.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "meeting attendance reminder" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'meeting attendance reminder: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/meetings/attendance-nudges"
)" || {
  printf 'meeting attendance reminder: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'meeting attendance reminder: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A Slack skip does not fail the run: the member was still
# notified in AdminBot, which is the copy that matters, and one member with no linked Slack account
# must not turn every other member's reminder red.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"meeting attendance reminder: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

notified = result.get("notified", [])
already = result.get("already_told", [])
skipped = result.get("slack_skipped", [])

print(
    f"meeting attendance reminder: {len(notified)} member(s) told, "
    f"{len(already)} already told about this streak"
)
if not result.get("invite_resolved"):
    # Not an error: the roster's own full members are still covered. Worth saying, because somebody
    # who is on the invite but is not a full member was out of scope for this run.
    print("  the lab calendar could not be read, so this covered full members only")
for entry in skipped:
    print(f"  no Slack for {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
