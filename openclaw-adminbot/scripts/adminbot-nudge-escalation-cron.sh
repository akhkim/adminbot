#!/usr/bin/env bash
# One daily escalation pass, shaped for an OpenClaw cron `command` job.
#
# Opens a three-way Slack DM -- AdminBot, the head professor and the member -- for anything
# important that AdminBot asked for and nobody answered inside the window (see
# adminBotNudgeEscalateAfterDays and escalateStaleNudges()). One DM per member however many things
# are overdue, and each thing escalates once.
#
# The service token is enough here for the same reason it is on the mandatory-fields pass: the run
# route takes no message or recipient list from the caller. Both are computed entirely from the
# notification log and the head-professor setting, so there is no admin-composed content for the
# service-principal gate to protect.
#
# Exits non-zero when no head professor is configured (HTTP 409), which is the one failure worth
# waking somebody for: the whole pass is silently a no-op until that setting exists.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "nudge escalation" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'nudge escalation: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/nudges/escalate/run"
)" || {
  printf 'nudge escalation: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'nudge escalation: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"nudge escalation: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

escalated = result.get("escalated", [])
skipped = result.get("skipped", [])
members = {entry.get("member_id") for entry in escalated}

print(
    f"nudge escalation: {len(escalated)} item(s) across {len(members)} member(s), "
    f"{len(skipped)} skipped"
)
for entry in escalated:
    print(f"  escalated {entry.get('member_id')}: {entry.get('title')}")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
