#!/usr/bin/env bash
# The weekly onboarding pass, shaped for an OpenClaw cron `command` job.
#
# The spreadsheet is the source of truth for membership. Two of its edits should produce an
# onboarding mail -- a row appearing, and Member Type changing -- and until this existed neither
# did on its own: a joining row was reported by the nightly roster sync and left alone, and a type
# change was written onto the record silently at 06:10 the next morning.
#
# So this reads the sheet, diffs it against the database, creates the members behind joining rows,
# and files one `onboarding.send_guide` proposal per person owed a mail. Nothing is sent by the
# run: that action is T3, so an admin approves each one in Pending Actions, and executing it drives
# the same sender the Onboarding tab uses -- the Slack Connect invite, the Drive folder, the
# project channels and the DCS request all happen, which a bare email would have promised and
# skipped.
#
# Two ledgers keep a weekly run from repeating itself, both already in the audit trail:
# `onboarding.guide_sent` (what has gone out, keyed by address) and `onboarding_sweep.ran` (where
# the last pass got to). A first run has neither, which is why it falls back to the live
# sheet-versus-database mismatch -- exactly the people whose type the database disagrees with.
#
# The service token is enough: the route takes no message and no recipient list. It reads the sheet
# itself and names nobody from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "onboarding sheet sweep" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'onboarding sheet sweep: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
DRY_RUN="${ADMINBOT_ONBOARDING_SWEEP_DRY_RUN:-false}"

response="$(
  curl --silent --show-error --max-time 180 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "{\"dry_run\":${DRY_RUN}}" \
    "http://127.0.0.1:${PORT}/onboarding/sheet-sweep/run"
)" || {
  printf 'onboarding sheet sweep: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
payload="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'onboarding sheet sweep: HTTP %s\n%s\n' "$status" "$payload" >&2
  exit 1
fi

# Summarize for the cron run list. A quiet week prints one line; anything owed names the person,
# the template and why, because the next step is somebody opening the Onboarding tab and sending it.
printf '%s' "$payload" | python3 -c '
import json, sys
r = json.load(sys.stdin)
created, mail, skipped = r.get("created", []), r.get("mail", []), r.get("skipped", [])
if not r.get("since"):
    print("onboarding sheet sweep: first run -- comparing Member Type against the database")
if created:
    print("onboarding sheet sweep: created %d member(s): %s" % (len(created), ", ".join(created)))
if not mail:
    print("onboarding sheet sweep: nobody is owed an onboarding mail")
else:
    print("onboarding sheet sweep: %d proposal(s) filed for approval in Pending Actions" % len(r.get("proposals", [])))
    for row in mail:
        print("  %s <%s> -- %s template -- %s" % (row["name"], row["email"], row["template_id"], row["reason"]))
for row in skipped:
    print("  skipped: %s -- %s" % (row["name"], row["reason"]))
'
