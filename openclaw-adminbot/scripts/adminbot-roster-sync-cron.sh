#!/usr/bin/env bash
# Reconcile the roster's membership and Member Type against the lab's spreadsheet, nightly.
#
# The spreadsheet is where membership is actually decided -- an admin adds a row when somebody
# joins and edits Member Type when what they are changes -- and the database is what every sweep
# reads. Keeping them together used to be something a person had to remember, so they drifted, and
# the drift is silent in the worst direction: an alumnus whose type never moved keeps their portal
# sign-in, their seat on the lab calendar and their Slack rooms indefinitely.
#
# Two columns only. Profile fields are adminbot-member-sheet-poller's job; widening this would let
# a spreadsheet typo overwrite what a member typed about themselves.
#
# The service token is enough: the route takes nothing from the caller. It reads the sheet, diffs it
# against the store, writes Member Type onto existing members, and files every external consequence
# as a proposal an admin still has to approve. It cannot create a member, delete one, or execute a
# Slack removal -- and `force`, which would override the guard below, is refused for this principal.
#
# Scheduled before adminbot-meeting-membership (06:35) on purpose. That sweep reconciles the lab
# calendar and the Monday meeting against the roster, so running this first means a type change
# lands and the calendar removal it implies is proposed the same morning rather than a day later.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "roster sync" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'roster sync: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

# One Sheets read of a ~200-row tab plus one write per changed member. Generous rather than tight:
# a slow morning at Google should not be reported as an unreachable service.
response="$(
  curl --silent --show-error --max-time 600 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{}' \
    "http://127.0.0.1:${PORT}/members/roster-sync"
)" || {
  printf 'roster sync: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'roster sync: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# A refused pass exits non-zero. It is a 200 -- the route answered, the diff is in the body -- but
# it means the guard tripped and nothing was applied, which has to be visible in the cron run list
# rather than reading as a quiet night.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"roster sync: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

applied = result.get("applied", [])
failed = result.get("failed", [])
proposals = result.get("proposals", [])
additions = result.get("additions", [])
absent = result.get("absent", [])
unchanged = result.get("unchanged", 0)
refused = result.get("refused")

if refused:
    print(f"roster sync: REFUSED, nothing applied -- {refused}", file=sys.stderr)
    raise SystemExit(1)

# Only the consequential changes are named. Most Member Type edits are a spelling fix or an added
# token that grants nothing, and listing all of them would bury the ones that took access away.
consequential = [c for c in applied if c.get("access", {}).get("consequential")]
# An admin set collaborator_subgroup by hand on these, so the access matrix did not follow the
# type change. Correct precedence, but somebody should decide whether the pinned value still holds.
pinned = [c for c in applied if c.get("access", {}).get("subgroup_pinned")]
print(
    f"roster sync: {len(applied)} member type(s) updated across {unchanged} row(s) already in "
    f"agreement; {len(consequential)} with access consequences, {len(proposals)} slack removal(s) "
    f"proposed; {len(additions)} sheet row(s) match no member, {len(absent)} member(s) match no row"
)
if pinned:
    names = ", ".join(c["member_name"] for c in pinned)
    print(f"  note: subgroup pinned on the record, matrix rows unchanged for: {names}")

for change in consequential:
    access = change["access"]
    lost = [
        name
        for name, state in (
            ("lab calendar", access.get("lab_calendar")),
            ("group meeting", access.get("group_meeting")),
            ("portal", access.get("portal")),
        )
        if state == "lost"
    ]
    detail = ", ".join(lost) or "matrix rows only"
    print(
        f"  {change['member_name']}: {change.get('from') or 'unset'} -> "
        f"{change.get('to') or 'unset'} (loses: {detail})"
    )

for failure in failed:
    print(f"roster sync: {failure['member_id']}: {failure['reason']}", file=sys.stderr)

raise SystemExit(1 if failed else 0)
PY
