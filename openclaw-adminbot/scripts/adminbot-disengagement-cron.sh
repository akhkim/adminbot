#!/usr/bin/env bash
# One disengagement pass, shaped for an OpenClaw cron `command` job.
#
# Two rules in one run, because they overlap on the same people:
#
#   * The onboarding ladder. Five business days after a member's welcome email, if they have
#     neither signed in nor edited anything, they get a Slack reminder; three days later a second;
#     five days after that both reminders go to the professor's desk and AdminBot stops asking.
#
#   * The standing reminder for anybody who has never signed in at all, every three days. It stands
#     aside while the ladder is running, so a newly welcomed member is not chased twice about the
#     same thing in different words.
#
# Who is chased comes from `adminBotDormantChaseMemberTypes` in the service (full members today;
# alumni, own-pace advisees and major coauthors are a one-line widening there).
#
# Safe to run daily -- and meant to be. The cadences live in the service, so a doubled crontab or a
# manual run cannot turn either rule into a daily nag.
#
# The service token is enough here for the same reason it is on the other sweeps: the run route
# takes no message or recipient list from the caller.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "disengagement sweep" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'disengagement sweep: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 60 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    "http://127.0.0.1:${PORT}/members/disengagement/run"
)" || {
  printf 'disengagement sweep: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

if [[ "$status" != "200" ]]; then
  printf 'disengagement sweep: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

# Summarize for the cron run list. A per-recipient skip (no slack_user_id on file, not on the nudge
# allowlist) is reported but does not fail the run -- one unreachable member must not turn every
# other member's reminder red too.
python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"disengagement sweep: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

reminded = result.get("reminded", [])
escalated = result.get("escalated", [])
dormant = result.get("dormant", [])
skipped = result.get("skipped", [])

print(
    f"disengagement sweep: {len(reminded)} onboarding reminder(s), "
    f"{len(escalated)} escalation(s), {len(dormant)} dormant-account reminder(s), "
    f"{len(skipped)} skipped"
)
for entry in reminded:
    print(
        f"  {entry.get('step')} -> {entry.get('member_id')} "
        f"({entry.get('days')} days since their welcome)"
    )
for entry in escalated:
    print(
        f"  escalated {entry.get('member_id')}: "
        f"{entry.get('notifications')} reminder(s) now on the professor's desk"
    )
for member_id in dormant:
    print(f"  never signed in: {member_id}")
for entry in skipped:
    print(f"  skipped {entry.get('member_id')}: {entry.get('reason')}")

raise SystemExit(0)
PY
