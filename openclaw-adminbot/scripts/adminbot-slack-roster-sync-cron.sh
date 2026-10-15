#!/usr/bin/env bash
# Daily Slack roster sync: reads users.list and reconciles the lab roster against it. The server
# decides every change; placeholder removals are only proposed (T3, admin approval), never applied.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "slack roster sync" || exit 1
: "${ADMINBOT_SERVICE_TOKEN:?ADMINBOT_SERVICE_TOKEN is required}"
curl --fail-with-body --silent --show-error --max-time 840 \
  -X POST -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
  -H "Content-Type: application/json" --data '{}' \
  "http://127.0.0.1:${ADMINBOT_PORT:-8765}/members/slack-roster/sync"
