#!/usr/bin/env bash
# One pass of the automated PaperMentor review, shaped for an OpenClaw cron job.
#
# Asks the lab's Overleaf to review each paper at its review step -- open, unsubmitted, never
# reviewed or reviewed more than three weeks ago -- naming it by the edit share link its author
# gave. Only links on the lab's own Overleaf can be reviewed this way. The review runs there in the
# background and waits in the project's AI Tutor panel until an author applies it; its counts reach
# AdminBot through the ordinary collector (adminbot-papermentor-runs).
#
# Safe at any cadence: the Overleaf runs at most one automated review per project a day, and at most
# two at a time. Off until ADMINBOT_PAPERMENTOR_SERVICE_TOKEN is set, and then the pass says so.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "papermentor reviews" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'papermentor reviews: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

# Not configured is a deployment choice, not a failure: the review step stays the author's button.
if [[ -z "${ADMINBOT_PAPERMENTOR_SERVICE_TOKEN:-}" ]]; then
  printf 'papermentor reviews: off (ADMINBOT_PAPERMENTOR_SERVICE_TOKEN is not set)\n'
  exit 0
fi

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 300 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"dry_run":false}' \
    "http://127.0.0.1:${PORT}/papers/papermentor/reviews/run"
)" || {
  printf 'papermentor reviews: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'papermentor reviews: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"papermentor reviews: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

requests = result.get("requests", [])
started = [r for r in requests if r.get("status") == "started"]
print(
    f"papermentor reviews: {result.get('due', 0)} at the review step, "
    f"{len(requests)} asked about, {len(started)} started"
)
for entry in requests:
    note = f" ({entry['message']})" if entry.get("message") else ""
    print(f"  {entry.get('paper_id')} [{entry.get('reason')}]: {entry.get('status')}{note}")

# A request the Overleaf could not take at all is a deployment problem somebody has to fix; every
# other answer, refusals included, is an ordinary state of a paper.
raise SystemExit(1 if any(r.get("status") == "failed" for r in requests) else 0)
PY
