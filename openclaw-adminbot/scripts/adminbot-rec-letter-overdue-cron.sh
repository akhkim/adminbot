#!/usr/bin/env bash
# One pass of the after-deadline recommendation-letter check, shaped for an OpenClaw cron job.
#
# Mails each student whose letter deadline has passed while the portal still shows the request as
# not submitted, asking whether it went in. One mail per student per pass, each request asked about
# once per deadline, so a doubled crontab cannot turn this into a daily nag.
#
# Off until ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED=1: the service answers "disabled" and sends
# nothing. Preview what it would send with POST /logistics/rec-letter-overdue/run?dry_run=1.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no recipient, no text and no request list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "rec letter overdue check" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'rec letter overdue check: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/logistics/rec-letter-overdue/run"
)" || {
  printf 'rec letter overdue check: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'rec letter overdue check: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. Skipped students (no address on the roster) and failed sends are
# named so the run history says who was not asked; a failed send exits non-zero so the run shows red.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"rec letter overdue check: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

outcome = result.get("outcome")
if outcome == "disabled":
    print("rec letter overdue check: off (ADMINBOT_REC_LETTER_OVERDUE_CONFIRM_ENABLED is not 1)")
    raise SystemExit(0)
if outcome == "nothing_due":
    print("rec letter overdue check: no past-due letters to ask about")
    raise SystemExit(0)

sent = result.get("sent", [])
skipped = result.get("skipped", [])
failed = result.get("failed", [])
print(
    f"rec letter overdue check: {len(sent)} student(s) asked, "
    f"{len(skipped)} skipped, {len(failed)} failed"
)
for entry in sent:
    print(f"  asked {entry.get('member_id')} about {len(entry.get('requests', []))} request(s)")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")
for entry in failed:
    print(f"  failed {entry.get('member_id')}: {entry.get('error')}", file=sys.stderr)

raise SystemExit(1 if failed else 0)
PY
