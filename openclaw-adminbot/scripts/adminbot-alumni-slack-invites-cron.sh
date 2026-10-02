#!/usr/bin/env bash
# One pass of the deferred alumni Slack Connect invitations, shaped for an OpenClaw cron job.
#
# The alumni welcome no longer carries a Connect invite. It follows ten days later, and this is what
# sends it: the delay is read off the welcome's own audit row, and the nudge ledger records each
# invitation as it goes so a nightly run cannot mint a second link for somebody who already has one.
#
# The link is minted here rather than at welcome time on purpose -- a Connect link goes stale in
# about a fortnight, so one minted ten days early would arrive nearly spent.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no message or recipient list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "alumni Slack invites" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'alumni Slack invites: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/onboarding/alumni-slack-invites/run"
)" || {
  printf 'alumni Slack invites: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'alumni Slack invites: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"alumni Slack invites: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

sent = result.get("sent", [])
skipped = result.get("skipped", [])

print(f"alumni Slack invites: {len(sent)} sent, {len(skipped)} skipped")
for entry in sent:
    print(f"  sent {entry.get('member_id')} -> {entry.get('email')}")
# A skip is one alumnus's invitation, not the run: somebody Slack refused (not_in_channel is the
# usual one) must not turn every other invitation in the pass red.
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
