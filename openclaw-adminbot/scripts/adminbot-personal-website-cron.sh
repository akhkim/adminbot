#!/usr/bin/env bash
# Message text, eligibility and weekly cooldown are derived by the service.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "personal webpage reminder" || exit 1
: "${ADMINBOT_SERVICE_TOKEN:?ADMINBOT_SERVICE_TOKEN is required}"
curl --fail-with-body --silent --show-error --max-time 840 \
  -X POST -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
  -H 'Content-Type: application/json' --data '{"dry_run":false}' \
  "http://127.0.0.1:${ADMINBOT_PORT:-8765}/members/personal-website-reminder/run"
