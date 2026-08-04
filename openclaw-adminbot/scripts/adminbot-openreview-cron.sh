#!/usr/bin/env bash
# One reviewing-cycle pass, shaped for an OpenClaw cron `command` job.
#
# The job spec is stored in the cron database and shown in the Control UI, so the
# service token must not live in it: this script reads it from the mode-600 env file
# instead. stdout becomes the cron run summary, and a non-zero exit is what makes the
# run show up as failed rather than silently green, so the summary is kept to one line
# followed by the raw payload.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "openreview cycle" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'openreview cycle: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
# Sending stays opt-in at the deployment level; without the flag the pass still runs,
# records what it would have done, and reports it.
if [[ "${ADMINBOT_OPENREVIEW_SEND:-}" == "1" ]]; then
  SEND="true"
else
  SEND="false"
fi

response="$(
  curl --silent --show-error --max-time 900 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H 'Content-Type: application/json' \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    --data "{\"send\":${SEND}}" \
    "http://127.0.0.1:${PORT}/openreview/cycle/run"
)" || {
  printf 'openreview cycle: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'openreview cycle: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list, and fail the run when the pass reported errors so a
# misconfiguration surfaces as a red job instead of a green one nobody reads.
SEND="$SEND" python3 - "$body" <<'PY'
import json, os, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"openreview cycle: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

actioned = [
    outcome
    for outcome in result.get("outcomes", [])
    if outcome.get("status") != "no_milestone_due"
]
errors = result.get("errors", [])
skipped = result.get("skipped", [])
mode = "sent" if os.environ.get("SEND") == "true" else "dry-run"

print(
    f"openreview cycle ({mode}): {result.get('venues', 0)} venue(s), "
    f"{len(actioned)} milestone(s) actioned, {len(skipped)} venue(s) skipped, "
    f"{len(errors)} error(s)"
)
for outcome in actioned:
    print(
        f"  {outcome.get('venue_id')} [{outcome.get('role')}] "
        f"{outcome.get('milestone_key')} -> {outcome.get('status')}"
        + (f" ({outcome['detail']})" if outcome.get("detail") else "")
    )
for entry in skipped:
    print(f"  skipped {entry.get('venue_id')} [{entry.get('role')}]: {entry.get('reason')}")
for entry in errors:
    print(f"  error {entry.get('venue_id', '-')}: {entry.get('reason')}: {entry.get('error')}")

raise SystemExit(1 if errors else 0)
PY
