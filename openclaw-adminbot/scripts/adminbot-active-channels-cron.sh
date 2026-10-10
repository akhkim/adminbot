#!/usr/bin/env bash
# Sunday active-channel cleanup; the server computes all removal targets.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "active channel cleanup" || exit 1
: "${ADMINBOT_SERVICE_TOKEN:?ADMINBOT_SERVICE_TOKEN is required}"
curl --fail-with-body --silent --show-error --max-time 840 \
  -X POST -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
  "http://127.0.0.1:${ADMINBOT_PORT:-8765}/members/active-channels/sync"
