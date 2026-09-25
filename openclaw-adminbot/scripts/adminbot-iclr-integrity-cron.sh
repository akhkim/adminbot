#!/usr/bin/env bash
# Starts the ICLR pre-deadline integrity sweep (Pangram AI-text score + stored citation results),
# shaped for an OpenClaw cron job.
#
# Hourly. Each uploaded version is scored once, so the cadence costs nothing between uploads and
# picks up every re-upload in the last hours before the deadline within the hour. It also raises
# an alert for a version whose citation check (adminbot-citation-checks, half-hourly) has finished
# since the last run.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "ICLR integrity checks" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'ICLR integrity checks: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/openreview/integrity-checks/run"
)" || {
  printf 'ICLR integrity checks: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# Off until the deployment opts in (ADMINBOT_ICLR_INTEGRITY_CHECKS=1 and PANGRAM_API_KEY); a
# feature nobody enabled is not a failing job.
if [[ "$status" == "503" ]]; then
  printf 'ICLR integrity checks: disabled on this deployment\n'
  exit 0
fi

if [[ "$status" != "202" ]]; then
  printf 'ICLR integrity checks: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"ICLR integrity checks: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

if result.get("ended_at"):
    print(f"ICLR integrity checks: ended at {result['ended_at']}; nothing more is checked")
elif result.get("started"):
    print(
        f"ICLR integrity checks: sweep started, {result.get('pending', 0)} of "
        f"{result.get('submissions', 0)} ICLR submission(s) need a score"
    )
else:
    print("ICLR integrity checks: previous sweep still running")
last = result.get("last_sweep")
if last:
    print(
        f"  last sweep {last.get('started_at')}: {last.get('scored', 0)} scored, "
        f"{last.get('reused', 0)} reused, {last.get('failed', 0)} failed, "
        f"{last.get('alerts', 0)} alert(s) sent"
    )
PY
