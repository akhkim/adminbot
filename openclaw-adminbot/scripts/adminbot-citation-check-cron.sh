#!/usr/bin/env bash
# Starts a citation-check sweep over the OpenReview account's own submissions, shaped for an
# OpenClaw cron job.
#
# The sweep runs in the service's background -- a first pass over a PI's history is hours of
# public-database lookups -- so this only starts it and reports what the previous sweep did. Every
# version is checked once whatever the cadence: a running sweep is not restarted, and a version
# already checked is never downloaded again. Half-hourly so a fix uploaded near a deadline is
# checked while there is still time to act on it.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "citation checks" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'citation checks: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/openreview/citation-checks/run"
)" || {
  printf 'citation checks: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# Off until the deployment opts in (ADMINBOT_OPENREVIEW_CITATION_CHECKS=1); a feature nobody
# enabled is not a failing job.
if [[ "$status" == "503" ]]; then
  printf 'citation checks: disabled on this deployment\n'
  exit 0
fi

if [[ "$status" != "202" ]]; then
  printf 'citation checks: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"citation checks: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

if result.get("started"):
    print(
        f"citation checks: sweep started, {result.get('pending', 0)} of "
        f"{result.get('submissions', 0)} submission(s) need a check"
    )
else:
    print("citation checks: previous sweep still running")
last = result.get("last_sweep")
if last:
    print(
        f"  last sweep {last.get('started_at')}: {last.get('checked', 0)} checked, "
        f"{last.get('flagged', 0)} flagged, {last.get('failed', 0)} failed, "
        f"{last.get('reused', 0)} reused"
    )
PY
