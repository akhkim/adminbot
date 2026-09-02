#!/usr/bin/env bash
# One pass of the per-project Slack channels, shaped for an OpenClaw cron job.
#
# Each project with an alias gets a #proj-<alias> channel, and the external collaborators the access
# matrix names for it are invited. The channel name comes from the alias a person chose when the
# project was created, so it is knowable from the record; the create runs every time and Slack's own
# name_taken is what says the channel already exists, which is why no channel directory is needed.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no channel or member list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "project channels" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'project channels: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/papers/project-channels/run"
)" || {
  printf 'project channels: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'project channels: HTTP %s\n%s\n' "$status" "$body" >&2
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
    print(f"project channels: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

channels = result.get("channels", [])
skipped = result.get("skipped", [])
invited = sum(len(c.get("invited", [])) for c in channels)

print(f"project channels: {len(channels)} channel(s), {invited} invited, {len(skipped)} skipped")
for entry in channels:
    print(f"  #{entry.get('channel')}: {len(entry.get('invited', []))} invited")
# A skip is one alumnus's invitation, not the run: somebody Slack refused (not_in_channel is the
# usual one) must not turn every other invitation in the pass red.
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
