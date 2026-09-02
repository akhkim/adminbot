#!/usr/bin/env bash
# One pass of the #help-rec-letter-request channel roster, shaped for an OpenClaw cron job.
#
# Adds anybody with an open recommendation-letter request, and proposes removing anybody whose
# letters have all been settled for longer than the retention window. Membership is computed from
# the request log rather than stored, so the pass is idempotent and there is no second list to fall
# out of step with it.
#
# Invites go out; removals only ever become proposals waiting for an admin. An unwanted invite is
# noise somebody can leave; an unwanted removal takes away a conversation they were part of.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no channel or member list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "rec letter channel" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'rec letter channel: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/logistics/rec-letter-channel/run"
)" || {
  printf 'rec letter channel: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'rec letter channel: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list; a per-recipient skip (no slack_user_id on file, etc.) is
# reported but does not fail the run -- one member with no Slack connected must not turn every
# other member's reminder red too.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"rec letter channel: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

invited = result.get("invited", [])
removals = result.get("removal_proposals", [])
skipped = result.get("skipped", [])

print(
    f"rec letter channel: {len(invited)} invited, "
    f"{len(removals)} removal(s) proposed, {len(skipped)} skipped"
)
for entry in invited:
    print(f"  invited {entry.get('member_id')}")
# Proposed, not done: an admin approves each one in Pending actions.
for entry in removals:
    print(f"  removal proposed for {entry.get('member_id')} (settled {entry.get('settled_at')})")
# A skip is one alumnus's invitation, not the run: somebody Slack refused (not_in_channel is the
# usual one) must not turn every other invitation in the pass red.
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
