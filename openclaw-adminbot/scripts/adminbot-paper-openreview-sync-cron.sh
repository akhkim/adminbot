#!/usr/bin/env bash
# One pass of the paper OpenReview sync, shaped for an OpenClaw cron job.
#
# OpenReview is the ground truth for whether a paper was submitted, accepted or rejected. This
# reads the author-results snapshot the results cron writes from OpenReview's API, and writes what
# it says through the normal paper-update path: the submission slot, the venue, and the decision
# fields. Every change is audited as made by OpenReview, and a value somebody edited by hand is left
# alone until OpenReview itself changes. The PI's notification e-mails are no longer read: they
# froze each paper at the title and status they were sent with.
#
# Every six hours, 80 minutes after each results pass, and safe at any cadence: a pass with nothing
# new to say changes nothing.
#
# ADMINBOT_OPENREVIEW_SYNC_DRY_RUN=1 reports what it would change without writing.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "paper openreview sync" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'paper openreview sync: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"
# The snapshot the results cron writes, at the path that cron uses. It is posted with the request
# so the service reads the same file even when its own default path differs; when it is missing
# the service falls back to its own path, and with no snapshot at all the run fails.
SNAPSHOT="${ADMINBOT_OPENREVIEW_RESULTS_JSON:-$(adminbot_service_state_dir)/openreview-author-results.json}"
request_file="$(mktemp)"
trap 'rm -f "$request_file"' EXIT
python3 - "$SNAPSHOT" "${ADMINBOT_OPENREVIEW_SYNC_DRY_RUN:-0}" >"$request_file" <<'REQUEST'
import json, sys

request = {"dry_run": sys.argv[2] == "1"}
try:
    with open(sys.argv[1]) as handle:
        request["author_results"] = json.load(handle)
except (OSError, ValueError):
    pass
print(json.dumps(request))
REQUEST

response="$(
  curl --silent --show-error --max-time 600 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "@${request_file}" \
    "http://127.0.0.1:${PORT}/papers/openreview-sync/run"
)" || {
  printf 'paper openreview sync: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'paper openreview sync: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Each paper OpenReview changed is named, so a change can be found without reading the ledger.
SNAPSHOT="$SNAPSHOT" python3 - "$body" <<'PY'
import json, os, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"paper openreview sync: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

applied = result.get("applied", [])
mode = "would change" if result.get("dry_run") else "changed"
print(
    f"paper openreview sync: read {', '.join(result.get('sources', [])) or 'no source'}; "
    f"{result.get('evidence', 0)} items, {result.get('matched', 0)} papers matched, "
    f"{len(applied)} {mode}, {result.get('unchanged', 0)} unchanged, "
    f"{len(result.get('kept', []))} kept, {result.get('unmatched_submissions', 0)} unmatched"
)
for entry in applied:
    fields = ", ".join(change.get("field", "") for change in entry.get("changes", []))
    slots = ", ".join(entry.get("slots", []))
    detail = "; ".join(part for part in (fields, slots and f"slots {slots}") if part)
    print(f"  {entry.get('paper_id')}: {entry.get('status')} at {entry.get('venue')} ({detail})")
for entry in result.get("kept", []):
    print(f"  kept {entry.get('paper_id')}: {entry.get('reason')}")
for warning in result.get("warnings", []):
    print(f"  warning: {warning}", file=sys.stderr)

# No source at all is worth a failed run: the job is doing nothing. Nearly always that is because
# the results job upstream has not written a snapshot, so the run names that job and the path
# rather than leaving "read no source" for somebody to decode.
if not result.get("sources"):
    print(
        f"paper openreview sync: no OpenReview snapshot to read at {os.environ['SNAPSHOT']}; it is"
        " written by the adminbot-openreview-results cron job, so check that job's latest run"
        " (OpenReview login, openreview-py) and re-run it before this one",
        file=sys.stderr,
    )
    raise SystemExit(1)
PY
