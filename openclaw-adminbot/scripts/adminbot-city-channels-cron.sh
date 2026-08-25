#!/usr/bin/env bash
# One city-channel pass, shaped for an OpenClaw cron `command` job.
#
# Adds members to #group-<city> for any city with four or more of them, once each, and tells them
# where they were put and how to leave. A member who leaves stays left -- the stamp on the record is
# what stops the next pass putting them back.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no member or channel list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "city channel sync" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'city channel sync: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/members/city-channels/sync"
)" || {
  printf 'city channel sync: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'city channel sync: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"city channel sync: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

groups = result.get("groups", [])
invited = result.get("invited", [])
skipped = result.get("skipped", [])

print(
    f"city channel sync: {len(invited)} member(s) added across {len(groups)} city channel(s), "
    f"{len(skipped)} skipped"
)
for group in groups:
    print(f"  #{group.get('channel')}: {group.get('members')} member(s) in {group.get('place')}")
for entry in invited:
    print(f"  added {entry.get('member_id')} to #{entry.get('channel')}")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
