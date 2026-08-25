#!/usr/bin/env bash
# One thesis-milestone pass, shaped for an OpenClaw cron `command` job.
#
# Two things, from the thesis dates members put on their own Time Availability timeline: the
# guidebook nudge two weeks before, and the reminder to the head professor to grade what was due
# five days after. Each is said once per date -- moving a thesis re-arms both, re-saving the same
# timeline does not.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no member list or message from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "thesis milestone sweep" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'thesis milestone sweep: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/members/thesis-milestones/run"
)" || {
  printf 'thesis milestone sweep: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'thesis milestone sweep: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"thesis milestone sweep: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

guidance = result.get("guidance", [])
grading = result.get("grading", [])
skipped = result.get("skipped", [])

print(
    f"thesis milestone sweep: {len(guidance)} member(s) reminded, "
    f"{len(grading)} ready to grade, {len(skipped)} skipped"
)
for entry in guidance:
    print(f"  reminded {entry.get('member_id')}: due {entry.get('date')}")
for entry in grading:
    print(f"  to grade {entry.get('member_id')}: due {entry.get('date')}")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
