#!/usr/bin/env bash
# One workshop-matching pass per conference, shaped for an OpenClaw cron `command` job.
#
# Reads which conference has a workshop deadline inside the next fortnight and has not been
# announced yet, matches the lab's papers against that conference's open calls, and Slacks each
# author the workshops their papers fit.
#
# Daily, and that is safe because the cadence is not what makes this happen once. The service
# checks the nudge ledger before it does anything: a conference already announced is not a
# candidate, so a tick that fires every morning for the fortnight before a deadline sends messages
# on exactly one of those mornings. Running this by hand twice in a row sends nothing the second
# time.
#
# Daily rather than weekly for the same reason the window exists at all: a weekly tick can land
# nine days before a deadline and then twelve days after the next one appeared, which is how a
# conference gets missed entirely. A daily tick that mostly does nothing is the cheap half of that
# trade -- when nothing is due the whole job is two dataset reads and a ledger query, with no model
# calls at all.
#
# One conference per run, even when several are due. A pass is thousands of model calls and tens of
# minutes; the rest are reported as deferred and taken by tomorrow's tick.
#
# The service token is enough here, as it is for the other cron-driven sweeps: the route takes no
# message and no recipient list. Which conference is due comes from the deadline dataset, who hears
# about it comes from the matcher and the roster, so there is no admin-composed content for the
# member-session gate to protect.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "workshop nudge" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'workshop nudge: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

# Generous timeout: when a conference is due this runs a full match pass inline, which is tens of
# minutes of model calls. When nothing is due it returns immediately.
response="$(
  curl --silent --show-error --max-time 3600 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/workshop-nudges/run"
)" || {
  printf 'workshop nudge: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'workshop nudge: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. "Nothing due" is the ordinary outcome on most days and is not a
# failure; a per-recipient skip (no Slack id on file) is reported and does not fail the run either,
# because one unreachable member must not turn the whole conference's announcement red.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"workshop nudge: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

conference = result.get("conference")
created = result.get("created", [])
skipped = result.get("skipped", [])
deferred = result.get("deferred", [])

if not conference:
    reason = result.get("reason") or "no conference is within two weeks of its first workshop deadline"
    print(f"workshop nudge: nothing sent — {reason}")
    raise SystemExit(0)

print(
    f"workshop nudge: {conference.get('label')} — {len(created)} message(s) sent, "
    f"{len(skipped)} skipped; first workshop deadline {conference.get('first_deadline_aoe')} "
    f"({conference.get('days_until')} day(s) away)"
)
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")
if deferred:
    print(f"  deferred until the next tick: {', '.join(deferred)}")

raise SystemExit(0)
PY
