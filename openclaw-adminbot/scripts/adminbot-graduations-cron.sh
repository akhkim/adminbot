#!/usr/bin/env bash
# One graduation pass, shaped for an OpenClaw cron `command` job.
#
# Three asks off the finishing months members keep on their own profile: the member confirming
# theirs is still right, the admins being asked to set somebody to alumni once it has passed, and
# the yearly ceremony while the year's graduates are still reachable.
#
# It never changes a status. `status` is privileged, nobody declares themselves alumni, and
# flipping it has access consequences a sweep should not perform on its own -- so this asks.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no member list or message from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "graduation sweep" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'graduation sweep: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/members/graduations/run"
)" || {
  printf 'graduation sweep: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'graduation sweep: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list; a per-recipient skip (no slack_user_id on file, etc.) is
# reported but does not fail the run -- one member with no Slack connected must not turn every
# other member's reminder red too.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"graduation sweep: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

confirmed = result.get("confirmed", [])
transitions = result.get("transitions", [])
ceremony = result.get("ceremony")
skipped = result.get("skipped", [])

print(
    f"graduation sweep: {len(confirmed)} member(s) asked to confirm, "
    f"{len(transitions)} awaiting an alumni transition, {len(skipped)} skipped"
)
for entry in confirmed:
    print(f"  asked {entry.get('member_id')}: finishing {entry.get('month')}")
for entry in transitions:
    print(f"  awaiting transition {entry.get('member_id')}: finished {entry.get('month')}")
if ceremony:
    print(f"  ceremony {ceremony.get('year')}: {ceremony.get('graduates')} graduate(s)")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
