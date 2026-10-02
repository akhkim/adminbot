#!/usr/bin/env bash
# One conference-results watch, shaped for an OpenClaw cron `command` job.
#
# Keeps Find Interesting Papers current with the conferences the lab actually reads. Results do not
# arrive on a date a cron expression can name -- a NeurIPS or ICLR notification slips by days, and
# ARR decides on cycles rather than once a year -- so this does not try to guess when. It asks each
# configured venue what it has accepted, and rebuilds only the ones whose answer changed.
#
# That is affordable to run daily because the two halves of an index cost very differently: reading
# a venue is one OpenReview call, embedding it is ~85 seconds of the local model. On an ordinary
# morning every venue matches its stored count and nothing is embedded at all. On the morning after
# a conference releases decisions, that venue goes from nothing to a few thousand papers, the count
# disagrees, and it -- and only it -- is rebuilt.
#
# The Tasks & Tools button still forces a full unconditional rebuild, which is the escape hatch for
# the one thing a count cannot see: a same-size swap of one paper for another.
#
# The service token is enough here. The route takes no content from the caller; which venues exist
# is settings state and what is in them comes from OpenReview.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "venue index watch" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'venue index watch: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

# Long timeout on purpose: the pass is normally seconds, but the run that matters -- the one right
# after decisions land -- embeds a few thousand papers and is the whole point of the job.
response="$(
  curl --silent --show-error --max-time 3600 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data '{"changed_only":true}' \
    "http://127.0.0.1:${PORT}/venue-papers/index"
)" || {
  printf 'venue index watch: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# 503 means no OpenReview credentials and 409 means no venues configured. Both are "this deployment
# has not turned the feature on", not a failure of today's run, so they report and exit clean
# rather than painting the cron list red every morning.
if [[ "$status" == "503" || "$status" == "409" ]]; then
  printf 'venue index watch: not configured (HTTP %s)\n%s\n' "$status" "$body"
  exit 0
fi

if [[ "$status" != "200" ]]; then
  printf 'venue index watch: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# A venue that could not be read is reported and fails the run: an index that silently stopped
# following its conference is exactly the failure this job exists to prevent.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"venue index watch: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

built = result.get("built", [])
skipped = result.get("skipped", [])
failed = result.get("failed", [])

if built:
    print(f"venue index watch: {len(built)} venue(s) rebuilt after a change")
    for entry in built:
        print(f"  rebuilt {entry.get('label')}: {entry.get('paper_count')} paper(s)")
else:
    print(f"venue index watch: no change across {len(skipped)} venue(s)")

for entry in failed:
    print(f"  could not read {entry.get('venue_id')}: {entry.get('reason')}", file=sys.stderr)

raise SystemExit(1 if failed else 0)
PY
