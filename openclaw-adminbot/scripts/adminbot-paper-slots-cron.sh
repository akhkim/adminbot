#!/usr/bin/env bash
# One daily paper-evidence nudge pass, shaped for an OpenClaw cron `command` job.
#
# Slack-nudges whoever owes an artifact on a live paper -- the first author for nearly all of them,
# the PI for the approval gate, coauthors for their feedback. Which artifacts those are comes from
# the slot registry in extensions/adminbot/src/contracts/paper-slots.ts, and which of them are
# actually askable right now comes from actionablePaperSlots(): a slot is only chased once
# everything upstream of it is provided or waived, so nobody is asked for an arXiv link on a paper
# that has not been submitted.
#
# The service token is enough here (unlike /nudges/send, which refuses it): the run route takes no
# message or recipient list from the caller. Both are computed from slot state and the registry,
# so there's no admin-composed content for the service-principal gate to protect. Same reasoning as
# adminbot-mandatory-fields-cron.sh.
#
# Safe to run more often than daily: the three-day per-slot cadence lives in the service
# (PAPER_SLOT_NUDGE_INTERVAL_MS), not in the schedule, so a doubled crontab cannot turn this into
# a nag.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "paper slots reminder" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'paper slots reminder: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
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
  printf 'paper slots reminder: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'paper slots reminder: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A per-recipient skip (no slack_user_id on file, say) is reported
# but does not fail the run -- one author with no Slack connected must not turn every other
# author's nudge red too.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"paper slots reminder: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

created = result.get("created", [])
skipped = result.get("skipped", [])
considered = result.get("papers_considered", 0)

print(
    f"paper slots reminder: {len(created)} nudge(s) sent across {considered} paper(s), "
    f"{len(skipped)} skipped"
)
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
