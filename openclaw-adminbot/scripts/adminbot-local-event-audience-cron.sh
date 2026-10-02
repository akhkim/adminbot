#!/usr/bin/env bash
# One pass of a standing local event's guest list, shaped for an OpenClaw cron `command` job.
#
# The Zurich lunch: a weekly event whose audience is "whoever is in Zurich". Two signals, and
# either one is enough: the city the sign-in IP resolved to, and the Slack timezone. The second
# matters because it is the only one that keeps arriving for somebody who never signs in.
#
# Requires `location_audience_city` in AdminBot settings. That field is what opts the lab into
# stamping every member's sign-in with a place -- until it is set only the head professor's rows
# carry one, and the IP half of this sweep sees nobody. Clearing it stops the collection.
#
# Division of labour, the same as the research-theme sweep: this script reads the event from Google
# (the service does not reach out) and posts the guest list it found; the service decides who
# belongs from the roster and names nobody back. Either signal puts somebody on the list, and only
# a *fresh* observation placing them elsewhere takes them off -- silence never uninvites anybody.
#
# Nothing is sent. Both attendee actions are T3 admin-approval, and calendar.remove_attendees never
# runs unattended by design, so a run files proposals for Pending Actions and stops. A settled week
# files none at all, which is what makes this safe to schedule weekly.
#
# The service token is enough: the route takes no message and no recipient list. The attendee list
# it does take is the event's own current state, which can only ever be read from Google.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "local event audience" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'local event audience: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
EVENT_ID="${ADMINBOT_LOCAL_EVENT_ID:-}"
CALENDAR_ID="${ADMINBOT_LOCAL_EVENT_CALENDAR:-primary}"
CITY="${ADMINBOT_LOCAL_EVENT_CITY:-Zurich}"
ZONE="${ADMINBOT_LOCAL_EVENT_ZONE:-Europe/Zurich}"
GOG="${GOG_BIN:-$HOME/.local/bin/gog}"
[[ -x "$GOG" ]] || GOG="gog"

[[ -n "$EVENT_ID" ]] || {
  printf 'local event audience: ADMINBOT_LOCAL_EVENT_ID is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

# The current guest list. Read first and separately: an empty or failed read must stop the run
# rather than reach the service, because "no attendees" is indistinguishable from "read broke" and
# the removal arm rewrites the list absolutely.
event="$(
  "$GOG" --json --no-input --enable-commands-exact calendar.get \
    ${ADMINBOT_GOG_ACCOUNT:+--account "$ADMINBOT_GOG_ACCOUNT"} \
    calendar get "$CALENDAR_ID" "$EVENT_ID"
)" || {
  printf 'local event audience: could not read event %s from Google\n' "$EVENT_ID" >&2
  exit 1
}

attendees_json="$(
  printf '%s' "$event" | python3 -c '
import json, sys
event = json.load(sys.stdin)
rows = event.get("attendees") or event.get("event", {}).get("attendees") or []
out = []
for row in rows:
    email = row.get("email") if isinstance(row, dict) else row
    if email:
        out.append(email)
json.dump(out, sys.stdout)
'
)" || {
  printf 'local event audience: could not read the attendee list out of the event payload\n' >&2
  exit 1
}

if [[ "$attendees_json" == "[]" ]]; then
  printf 'local event audience: event %s reports no attendees -- refusing to sweep\n' "$EVENT_ID" >&2
  exit 1
fi

body="$(
  EVENT_ID="$EVENT_ID" CALENDAR_ID="$CALENDAR_ID" CITY="$CITY" ZONE="$ZONE" \
  ATTENDEES="$attendees_json" python3 -c '
import json, os
print(json.dumps({
    "event_id": os.environ["EVENT_ID"],
    "calendar_id": os.environ["CALENDAR_ID"],
    "city": os.environ["CITY"],
    "zone": os.environ["ZONE"],
    "attendees": json.loads(os.environ["ATTENDEES"]),
}))
'
)"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d "$body" \
    "http://127.0.0.1:${PORT}/calendar/local-event-audience/run"
)" || {
  printf 'local event audience: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
payload="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'local event audience: HTTP %s\n%s\n' "$status" "$payload" >&2
  exit 1
fi

# Summarize for the cron run list. A week with nothing to change is the expected case and prints
# one quiet line; anything proposed says who and why, because the next step is somebody approving it.
printf '%s' "$payload" | python3 -c '
import json, sys
r = json.load(sys.stdin)
add, rem, held = r.get("add", []), r.get("remove", []), r.get("held", [])
if not r.get("proposals"):
    print("local event audience: nothing to change (%d on the list, %d held on stale evidence)"
          % (len(r.get("keep", [])), len(held)))
else:
    print("local event audience: %d proposal(s) filed for approval" % len(r["proposals"]))
    for row in add:
        print("  + %s -- %s" % (row["name"], row["reason"]))
    for row in rem:
        print("  - %s -- %s" % (row["name"], row["reason"]))
if r.get("unknown_attendees"):
    print("  (untouched, not on the roster: %s)" % ", ".join(r["unknown_attendees"]))
'
