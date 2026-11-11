#!/usr/bin/env bash
# One pass of the head professor's escalation digest, shaped for an OpenClaw cron job.
#
# Hourly so the digest is reliable rather than frequent: the service sends at most one per local
# day, from ADMINBOT_PROFESSOR_DIGEST_HOUR on, and only when something is waiting on her. Every
# other run that day -- and every run while the digest is switched off -- reports why it stayed
# quiet and sends nothing. A run the mailbox failed is caught up by the next one.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no recipient, no text and no item list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "professor digest" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'professor digest: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/nudges/professor-digest/run"
)" || {
  printf 'professor digest: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'professor digest: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"professor digest: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

outcome = result.get("outcome")
day = result.get("local_date")
quiet = {
    "disabled": "off on this deployment (ADMINBOT_PROFESSOR_DIGEST_ENABLED is not 1)",
    "before_send_hour": f"not yet the send hour for {day}",
    "already_sent_today": f"already sent for {day}",
    "nothing_due": f"nothing waiting on {day}",
}
if outcome in quiet:
    print(f"professor digest: {quiet[outcome]}")
    raise SystemExit(0)

counts = result.get("counts") or {}
print(
    f"professor digest: sent to {result.get('recipient')} for {day} -- "
    f"{counts.get('overdue', 0)} overdue, {counts.get('due_48h', 0)} due in 48h, "
    f"{counts.get('due_7d', 0)} due this week, {counts.get('waiting', 0)} waiting"
)
print(f"  subject: {result.get('subject')}")
raise SystemExit(0)
PY
