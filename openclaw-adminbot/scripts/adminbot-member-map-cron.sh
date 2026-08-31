#!/usr/bin/env bash
# One member-map location pass, shaped for an OpenClaw cron `command` job.
#
# Re-reads every member's Slack profile location -- a workspace location field where one is set,
# otherwise the city carried by their timezone's IANA name -- and stamps it as `slack_location`.
#
# Scheduled because that stamp is the map's *first* source, ahead of last-login country and the
# roster location, and it was the only one of the three that could not refresh itself. The other
# two keep up on their own: a login stamps a country every time somebody signs in, and the roster
# value changes when a member edits their profile. So a stale Slack stamp does not read as missing
# data, it reads as a confident wrong answer that outranks the fresher value underneath it -- which
# is the exact failure refreshMemberMap's own "cleared rather than left stale" rule exists to
# prevent, and that rule only runs when this does.
#
# Sits just after the 05:45 Slack channel directory pass and the 05:40 ID/timezone sync, so the
# three Slack reads of the morning finish together rather than being spread across the day.
#
# The service token is enough here: the route takes no input at all. Which members are read comes
# from the roster and what comes back comes from Slack, so there is no caller-supplied content for
# the member-session gate to protect.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "member map refresh" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'member map refresh: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 300 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/member-map/refresh"
)" || {
  printf 'member map refresh: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# 503 is "this deployment has no Slack location reader configured", which is a deployment choice
# rather than a failure of today's run -- same handling as the venue index watch.
if [[ "$status" == "503" ]]; then
  printf 'member map refresh: not configured (HTTP %s)\n%s\n' "$status" "$body"
  exit 0
fi

if [[ "$status" != "200" ]]; then
  printf 'member map refresh: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"member map refresh: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

checked = result.get("checked", 0)
updated = result.get("updated", 0)

# "0 updated" is the ordinary result and worth printing rather than staying silent: it is the
# difference between "nobody moved" and "the pass never ran", which is the whole point of it
# being on a schedule at all.
print(f"member map refresh: {checked} member(s) checked, {updated} location(s) changed")
raise SystemExit(0)
PY
