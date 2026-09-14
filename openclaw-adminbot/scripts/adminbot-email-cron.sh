#!/usr/bin/env bash
# One pass of the hourly email processor, shaped for an OpenClaw cron `command` job.
#
# This replaces the jinesis-adminbot-email.timer that install-user-services.sh now deletes, so the
# schedule lives in the cron database and shows up in the Control UI's Cron tab with its run history
# and last error. The processor prints its JSON summary and exits non-zero when a message failed, so
# the run surfaces as red rather than silently green; this wrapper only supplies the environment the
# systemd unit used to hand it.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "email automation" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'email automation: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

# The unit set these alongside the env file; the reimbursement/receipt passes shell out to python.
export NODE_ENV="${NODE_ENV:-production}"
export PYTHONPATH="${PYTHONPATH:-$HOME/.local/share/jinesis-adminbot/python-libs}"

# Not `exec`, because the pass is no longer the last thing this job does. Its exit code is still
# what the run reports -- a message that failed has to surface red -- so it is held and re-raised at
# the bottom.
status=0
"$TSX_BIN" "$REPO_ROOT/scripts/adminbot-email-automation.ts" || status=$?

# Whatever the pass could not decide, put to the reviewer as an approval they can answer where they
# already are. Held messages are a normal outcome rather than a failure, so this runs even when the
# pass exited non-zero: a run with one failed send and three held messages still owes somebody
# those three questions.
#
# Say-once is the service's, not this script's -- see the email_review ledger domain -- so running
# this hourly alongside the pass asks about each message exactly once however often the job fires.
PORT="${ADMINBOT_PORT:-8765}"
if [[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]]; then
  propose="$(
    curl --silent --show-error --max-time 60 \
      --write-out '\n%{http_code}' \
      -X POST \
      -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
      "http://127.0.0.1:${PORT}/automation/email/review/propose"
  )" || propose=""
  propose_status="${propose##*$'\n'}"
  propose_body="${propose%$'\n'*}"
  if [[ "$propose_status" == "200" ]]; then
    python3 - "$propose_body" <<'PROPOSE'
import json, sys

result = json.loads(sys.argv[1])
asked = result.get("proposed", [])
print(
    f"email review: {len(asked)} held message(s) put to the reviewer, "
    f"{len(result.get('already_asked', []))} already asked"
)
PROPOSE
  else
    # Not fatal, and deliberately not silent: the messages stay in the queue and the next hourly
    # run asks again, but a reviewer who is never asked is the failure this whole step exists to
    # prevent, so it is named rather than swallowed.
    printf 'email review: could not put held messages to the reviewer (HTTP %s)\n' \
      "${propose_status:-none}" >&2
  fi
else
  printf 'email review: ADMINBOT_SERVICE_TOKEN is not set in %s; held messages were not raised\n' \
    "$ADMINBOT_ENV_FILE" >&2
fi

exit "$status"
