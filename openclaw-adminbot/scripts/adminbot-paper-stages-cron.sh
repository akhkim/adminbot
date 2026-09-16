#!/usr/bin/env bash
# One pass of the paper stage walk, shaped for an OpenClaw cron job.
#
# Moves each paper to the step its own evidence has released -- the slot registry says which slots
# release which step, and this is what reads it -- and signs up the papers whose arXiv package is
# prepared for the head professor's decision.
#
# Forward only, and never past a step somebody set by hand. Nothing here blocks a paper: the
# stepper stays open, and this only catches a paper up to what it has already proved.
#
# Hourly, and safe at any cadence: an advance that has already happened is not an advance, and the
# PI is told once per prepared package whatever the schedule does.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "paper stages" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'paper stages: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

# Verify first, advance second, and in that order for a reason: a Drive link Google says is not
# there is marked invalid by the check, which un-settles the slot -- so a paper must not be
# advanced on evidence this pass is about to contradict. A deployment with no Google account wired
# checks nothing and the walk proceeds exactly as before.
verify="$(
  curl --silent --show-error --max-time 300 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/evidence/verify/run"
)" || verify=""
verify_status="${verify##*$'\n'}"
verify_body="${verify%$'\n'*}"

if [[ "$verify_status" == "200" ]]; then
  python3 - "$verify_body" <<'VERIFY'
import json, sys

result = json.loads(sys.argv[1])
print(
    f"paper evidence: {result.get('checked', 0)} checked, "
    f"{len(result.get('verified', []))} confirmed, "
    f"{len(result.get('invalidated', []))} contradicted, "
    f"{len(result.get('unreadable', []))} unreadable"
)
# A contradicted link is the one outcome somebody has to act on, so it is named.
for entry in result.get("invalidated", []):
    print(f"  contradicted {entry.get('paper_id')}: {entry.get('slot')}")
VERIFY
else
  # Not fatal: the walk below is still worth running, and a check that could not run is exactly
  # the "we could not tell" case this pass is built to survive.
  printf 'paper evidence: verification pass unavailable (HTTP %s)\n' "${verify_status:-none}" >&2
fi


# Verify first, advance second, and in that order for a reason: a Drive link Google says is not
# there is marked invalid by the check, which un-settles the slot -- so a paper must not be
# advanced on evidence this pass is about to contradict. A deployment with no Google account wired
# checks nothing and the walk proceeds exactly as before.
verify="$(
  curl --silent --show-error --max-time 300 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/evidence/verify/run"
)" || verify=""
verify_status="${verify##*$'\n'}"
if [[ "$verify_status" == "200" ]]; then
  python3 -c '
import json, sys
result = json.loads(sys.argv[1])
print(
    f"paper evidence: {result.get(\"checked\", 0)} checked, "
    f"{len(result.get(\"verified\", []))} confirmed, "
    f"{len(result.get(\"invalidated\", []))} contradicted, "
    f"{len(result.get(\"unreadable\", []))} unreadable"
)
for entry in result.get("invalidated", []):
    print(f"  contradicted {entry.get(\"paper_id\")}: {entry.get(\"slot\")}")
' "${verify%$'\n'*}"
else
  # Not fatal: the walk below is still worth running, and a check that could not run is exactly
  # the "we could not tell" case the pass is built to survive.
  printf 'paper evidence: verification pass unavailable (HTTP %s)\n' "${verify_status:-none}" >&2
fi

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/stages/run"
)" || {
  printf 'paper stages: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'paper stages: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Every advance is named in the run history. A paper moving itself along is the kind of thing
# somebody should be able to find afterwards without reading the audit ledger.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"paper stages: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

advanced = result.get("advanced", [])
requested = result.get("pi_review_requested", [])
waiting = result.get("waiting_on_pi", 0)

print(
    f"paper stages: {len(advanced)} advanced, {len(requested)} sent for PI review, "
    f"{waiting} waiting at the gate"
)
for entry in advanced:
    print(f"  {entry.get('paper_id')}: {entry.get('from')} -> {entry.get('to')}")
for paper_id in requested:
    print(f"  queued for PI review: {paper_id}")

raise SystemExit(0)
PY
