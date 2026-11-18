#!/usr/bin/env bash
# One pass of the scheduled Member Type changes, shaped for an OpenClaw cron job.
#
# An admin who agrees a grace period ("a week, then acquaintance") records it with
# POST /lab/scheduled-member-changes. This is what makes the change on the day: every pending
# change whose due date has come is saved exactly as the Edit member form would save it, in the
# name of the admin who scheduled it, and marked done or failed as it lands.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no member, type or date from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "scheduled member changes" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'scheduled member changes: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 600 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/lab/scheduled-member-changes/run"
)" || {
  adminbot_curl_failure "scheduled member changes" "$?" "$PORT"
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'scheduled member changes: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# A change that failed or is held is the run's news, so it turns the run red: unlike a skipped
# reminder, nothing will try it again, and somebody has to look.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"scheduled member changes: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

done = result.get("done", [])
failed = result.get("failed", [])
held = result.get("held", [])

print(f"scheduled member changes: {len(done)} done, {len(failed)} failed, {len(held)} held")
for label, entries in (("done", done), ("failed", failed), ("held", held)):
    for entry in entries:
        print(f"  {label} {entry.get('member_id')} -> {entry.get('member_type')}: {entry.get('detail')}")

raise SystemExit(1 if failed or held else 0)
PY
