#!/usr/bin/env bash
# One daily Slack directory sync, shaped for an OpenClaw cron `command` job.
#
# The point of the pass is timezones: /members/directory/refresh-slack re-reads Slack's `tz` for
# every linked member and stamps it onto `timezone`, which is what the calendar's zone ladder and
# every scheduling view read. Slack is the only source that updates itself when somebody travels or
# moves, so a stale zone silently mis-schedules meetings until the member notices.
#
# Two other things ride along because the route does them in one pass, not because a daily
# cadence is needed for their own sake: `slack_user_id` is backfilled by email for members the
# roster never linked (a member with no id has no timezone to read), and 7-day message counts are
# re-tallied.
#
# The service token is enough here: the route takes nothing from the caller -- no member list, no
# message, no content -- and computes everything from roster state plus Slack. Same reasoning as
# adminbot-mandatory-fields-cron.sh.
#
# Nothing here overwrites a member's zone with a guess. The service clears a stored timezone only
# when Slack *answered* and had none; a failed lookup leaves the previous value alone, so a bad
# night on the Slack API cannot blank the roster.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "slack directory sync" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'slack directory sync: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

# Generous timeout: the route is one Slack API call per linked member (~200) plus one read per
# tracked channel, and a slow workspace should not be reported as an unreachable service.
response="$(
  curl --silent --show-error --max-time 900 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/members/directory/refresh-slack"
)" || {
  printf 'slack directory sync: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'slack directory sync: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. `checked` is the honest denominator: it counts members Slack
# actually answered for, which is why it can be lower than the number of linked members without
# the run having failed.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"slack directory sync: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

checked = result.get("timezonesChecked", 0)
updated = result.get("timezonesUpdated", 0)
resolved = result.get("idsResolved", 0)
activity = result.get("activityChecked", 0)

print(
    f"slack directory sync: {updated} timezone(s) changed across {checked} member(s) checked; "
    f"{resolved} slack id(s) newly linked, {activity} activity count(s) refreshed"
)

raise SystemExit(0)
PY
