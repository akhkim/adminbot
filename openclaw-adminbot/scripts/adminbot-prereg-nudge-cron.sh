#!/usr/bin/env bash
# The pre-meeting pre-registration sweep, shaped for an OpenClaw cron `command` job.
#
# Asks everyone in test-onboard batch 1, 2 or 3 -- and every full member, who counts as batch 3 --
# about the venue the lab is planning around. Somebody with nothing aimed at it is asked to
# pre-register, with the reason in front of the ask; somebody who has registered some of their
# papers is asked about the rest. A member with no batch who is not a full member is never
# addressed: those are the people the lab has not started onboarding.
#
# Run it hourly. The window is the service's, not the crontab's: the sweep sends only inside the
# twenty hours before the group meeting (contracts/group-meeting.ts), and the audit ledger stops it
# asking the same person twice before the same meeting. So an hourly job sends on one afternoon a
# week and is silent the rest of the time, and a retry or a manual press collapses into that.
#
# The service token is enough, as for the other sweeps: the route takes no message and no recipient
# list, both are derived from the roster and what has been registered.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "pre-registration nudge" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'pre-registration nudge: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
VENUE="${ADMINBOT_PREREG_VENUE:-ICLR}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"venue\":\"${VENUE}\"}" \
    "http://127.0.0.1:${PORT}/papers/pre-registration/run"
)" || {
  printf 'pre-registration nudge: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'pre-registration nudge: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Outside the window the service returns a reason rather than an error: that is the normal state
# for most of the week, and a cron run list full of red for "it is Wednesday" teaches people to
# ignore the list.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"pre-registration nudge: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

reason = result.get("skipped_reason")
if reason:
    print(f"pre-registration nudge: quiet — {reason}")
    raise SystemExit(0)

asked = result.get("asked", [])
skipped = result.get("skipped", [])
print(f"pre-registration nudge: {len(asked)} member(s) asked, {len(skipped)} skipped")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")
raise SystemExit(0)
PY
