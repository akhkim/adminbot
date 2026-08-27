#!/usr/bin/env bash
# One pass over a standing invite, shaped for an OpenClaw cron `command` job.
#
# Reconciles who is on the Monday group meeting (or the lab calendar) against the roster and files
# the removals as proposals. It removes nobody: `calendar.remove_attendees` is a T3 action, so an
# admin reads the names on the Actions tab and approves before anything reaches Google. That is
# deliberate -- uninviting somebody is read as a statement about whether they still belong, and the
# roster this is computed from is a spreadsheet people forget to update.
#
# Daily is the right cadence for the job even though the answer rarely changes: a member who left
# last week should not sit on next Monday's invite, and a run that finds nothing exits quietly.
#
# The service token is enough here, as it is for the other sweeps: the route takes no message and
# no recipient list. Both are derived from the event's own attendee list and the roster.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "meeting membership" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'meeting membership: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
SURFACE="${1:-group_meeting}"
case "$SURFACE" in
  group_meeting | lab_calendar) ;;
  *)
    printf 'meeting membership: unknown surface %s (expected group_meeting or lab_calendar)\n' \
      "$SURFACE" >&2
    exit 2
    ;;
esac

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"surface\":\"${SURFACE}\"}" \
    "http://127.0.0.1:${PORT}/meetings/invite-membership/run"
)" || {
  printf 'meeting membership: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'meeting membership: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. An unrecognized attendee is printed individually rather than
# counted: it is an address on the meeting that no roster row explains, which is either somebody
# missing from the roster or a guest nobody recorded, and both want a human to look once.
python3 - "$body" "$SURFACE" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"meeting membership: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

surface = sys.argv[2]
remove = result.get("remove", [])
keep = result.get("keep", [])
unrecognized = result.get("unrecognized", [])
proposal = result.get("proposal_id")

if not remove:
    print(f"meeting membership ({surface}): nothing to remove; {len(keep)} attendee(s) belong")
else:
    print(
        f"meeting membership ({surface}): proposed removing {len(remove)} of "
        f"{len(remove) + len(keep)} attendee(s) — approve {proposal} to apply"
    )
    for entry in remove:
        print(f"  remove {entry.get('member_name')} <{entry.get('email')}>: {entry.get('reason')}")

for email in unrecognized:
    print(f"  unrecognized (kept): {email}")

raise SystemExit(0)
PY
