#!/usr/bin/env bash
# One PaperFlow stage pass, shaped for an OpenClaw cron `command` job.
#
# Emails the first full member on each paper's author list about the one venue-cycle stage that
# paper is waiting on -- reviews, the rebuttal window, the decision, camera ready, conference
# travel -- and asks them to bcc the bot mailbox when it lands. A bcc closes the stage (see the
# paperflow_bcc branch in scripts/adminbot-email-automation.ts) and the chase stops.
#
# Daily is the right cadence for the *job* even though a stage is only asked about weekly: the
# per-stage clock lives in adminbot_nudge_ledger, so running daily means a stage that came due
# overnight goes out that morning rather than waiting for the next weekly tick.
#
# The service token is enough here, as it is for the mandatory-fields reminder: the route takes no
# message and no recipient list, both are derived from the author list and the stage registry, so
# there is no admin-composed content for the member-session gate to protect.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "paperflow stage nudge" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'paperflow stage nudge: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/paperflow-stages/run"
)" || {
  printf 'paperflow stage nudge: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'paperflow stage nudge: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A per-recipient skip (no address on file) and an unroutable
# paper (nobody on the roster in the author list) are both reported and neither fails the run:
# one paper with an all-external author list must not turn every other paper's nudge red. They are
# printed individually because an unroutable paper is a real gap somebody has to close by naming a
# lab member on the record, and a silent count would never get anyone to do it.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"paperflow stage nudge: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

created = result.get("created", [])
skipped = result.get("skipped", [])
unroutable = result.get("unroutable", [])
considered = result.get("papers_considered", 0)

print(
    f"paperflow stage nudge: {len(created)} email(s) sent across {considered} paper(s) "
    f"with an open stage, {len(skipped)} skipped, {len(unroutable)} unroutable"
)
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")
for paper_id in unroutable:
    print(f"  unroutable {paper_id}: no full member on the author list")

raise SystemExit(0)
PY
