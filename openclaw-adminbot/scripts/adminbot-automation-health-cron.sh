#!/usr/bin/env bash
# One automation health pass, shaped for an OpenClaw cron `command` job.
#
# Reads every job's heartbeats and every failed action, and tells the admins -- on their own page,
# not over Slack, which is one of the things this checks -- about each open issue once a week at
# most. The service token is enough: the route takes nothing from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "automation health" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'automation health: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/automation/health/run"
)" || {
  printf 'automation health: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"
if [[ "$status" != "200" ]]; then
  printf 'automation health: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

result = json.loads(sys.argv[1])
alerted = result.get("alerted", [])
print(f"automation health: {result.get('issues', 0)} open issue(s), {len(alerted)} newly told to {result.get('admins', 0)} admin(s)")
for key in alerted:
    print(f"  {key}")
PY
