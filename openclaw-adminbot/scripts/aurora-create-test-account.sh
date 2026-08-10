#!/usr/bin/env bash
# Uploads aurora-create-test-account.mjs to aurora and runs it there in one shot.
# Mirrors scripts/aurora-adminbot-host.sh's host/user/auth conventions.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_SCRIPT="${SCRIPT_DIR}/aurora-create-test-account.mjs"

# The deploy target names a specific machine, so it comes from the environment rather than from
# the tracked script. --host still overrides it for a one-off.
HOST="${AURORA_HOST:-}"
CS_USER="${CS_USER:-akim}"
SSH_CONNECT_TIMEOUT="10"
SSH_PASSWORD="${AURORA_SSH_PASSWORD:-}"

[[ -f "$LOCAL_SCRIPT" ]] || {
  echo "error: missing $LOCAL_SCRIPT" >&2
  exit 1
}

[[ -n "$HOST" ]] || {
  echo "error: set AURORA_HOST — the deploy target is not named in the repo" >&2
  exit 1
}

TARGET="${CS_USER}@${HOST}"
REMOTE_CURRENT="/h/405/${CS_USER}/sernt"
REMOTE_TMP="/h/405/${CS_USER}/aurora-

SSHPASS_PREFIX=()
if [[ -n "$SSH_PASSWORD" ]]; then
  command -v sshpass >/dev/null || {
    echo "error: sshpass is required et" >&2
    exit 1
  }
  export SSHPASS="$SSH_PASSWORD"
  SSHPASS_PREFIX=(sshpass -e)
fi
SSH=("${SSHPASS_PREFIX[@]}" ssh -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET")
SCP=("${SSHPASS_PREFIX[@]}" scp -o "CIMEOUT}")

echo "Uploading script to ${TARGET}:$
"${SCP[@]}" "$LOCAL_SCRIPT" "${TARGET

echo "Running it against ${REMOTE_CUR
"${SSH[@]}" "node '${REMOTE_TMP}' '${REMOTE_TMP}'"