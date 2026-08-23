#!/usr/bin/env bash
# One weekly-update pass, shaped for an OpenClaw cron `command` job.
#
# Asks every author of a live paper what they did on it this week, in one Slack message per person
# listing every paper they owe a line on. What they write lands under Weekly updates on the paper
# card, which is what their coauthors read on Monday to see what moved.
#
# Run it on a Sunday. The week a person is asked about is the one containing "now" (Monday-start,
# UTC -- see contracts/paper-weekly-updates.ts), so a Sunday run asks about the week that is
# ending rather than the one about to start. Running it more than once is harmless: the service
# records who it asked about which week in the audit ledger and will not ask the same person twice
# for the same week, so an hourly crontab, a retry and a manual press all collapse into one nudge.
#
# The service token is enough here, as it is for the paperflow stage pass: the route takes no
# message and no recipient list -- both are derived from the author lists and what has already
# been filed -- so there is no admin-composed content for the member-session gate to protect.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "weekly update nudge" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'weekly update nudge: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/weekly-updates/run"
)" || {
  printf 'weekly update nudge: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'weekly update nudge: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A skip (no Slack id on file) is reported and does not fail the
# run: one member the lab cannot reach must not turn everybody else's nudge red.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"weekly update nudge: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

created = result.get("created", [])
skipped = result.get("skipped", [])
asked = result.get("asked", [])
week = result.get("week_start", "?")

print(
    f"weekly update nudge: week of {week} — {len(created)} message(s) to {len(asked)} member(s), "
    f"{len(skipped)} skipped"
)
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
