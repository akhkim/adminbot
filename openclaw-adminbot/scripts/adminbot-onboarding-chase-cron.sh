#!/usr/bin/env bash
# One onboarding follow-up pass, shaped for an OpenClaw cron `command` job.
#
# Chases members whose setup checklist is still open, on the cycle's own clock: ten days after the
# checklist opened, and every two months after that. A checklist opens at registration or when the
# member's standing changes, so somebody promoted in their third year is chased about the promotion
# rather than about an account created in their first.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no message or recipient list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "onboarding chase" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'onboarding chase: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/onboarding/chase/run"
)" || {
  printf 'onboarding chase: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'onboarding chase: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"onboarding chase: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

nudged = result.get("nudged", [])
skipped = result.get("skipped", [])

print(f"onboarding chase: {len(nudged)} member(s) chased, {len(skipped)} skipped")
for entry in nudged:
    print(
        f"  chased {entry.get('member_id')}: {entry.get('open_steps')} step(s) open, "
        f"{entry.get('days_open')} days"
    )
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
