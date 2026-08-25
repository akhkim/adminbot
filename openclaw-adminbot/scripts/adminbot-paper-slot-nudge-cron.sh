#!/usr/bin/env bash
# One paper-evidence reminder pass, shaped for an OpenClaw cron `command` job.
#
# Chases whatever each live paper still owes -- the submission link, the Drive copy, the arXiv
# page, the slides -- from the same computation the Active Papers evidence column shows, so the
# page and the nudge can never disagree about what is outstanding.
#
# The service token is enough here for the same reason it is on the mandatory-fields pass: the run
# route takes no message or recipient list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "paper slot reminder" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'paper slot reminder: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/slot-reminder/run"
)" || {
  printf 'paper slot reminder: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'paper slot reminder: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"paper slot reminder: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

created = result.get("created", [])
skipped = result.get("skipped", [])

print(f"paper slot reminder: {len(created)} member(s) nudged, {len(skipped)} skipped")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
