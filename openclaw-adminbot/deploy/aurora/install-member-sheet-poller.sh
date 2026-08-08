#!/usr/bin/env bash
set -euo pipefail

ROOT=""
ENV_FILE=""
ADMINBOT_PORT="8765"
START_MODE="no"
INTERVAL="1min"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --root)
      (($# >= 2)) || die "--root requires a value"
      ROOT="$2"
      shift 2
      ;;
    --env-file)
      (($# >= 2)) || die "--env-file requires a value"
      ENV_FILE="$2"
      shift 2
      ;;
    --adminbot-port)
      (($# >= 2)) || die "--adminbot-port requires a value"
      ADMINBOT_PORT="$2"
      shift 2
      ;;
    --interval)
      (($# >= 2)) || die "--interval requires a value"
      INTERVAL="$2"
      shift 2
      ;;
    --start)
      START_MODE="yes"
      shift
      ;;
    --no-start)
      START_MODE="no"
      shift
      ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$ROOT" && -d "$ROOT" ]] || die "--root must name the release directory"
[[ -n "$ENV_FILE" ]] || die "--env-file is required"
[[ "$ADMINBOT_PORT" =~ ^[0-9]+$ ]] || die "AdminBot port must be numeric"
[[ "$INTERVAL" =~ ^[1-9][0-9]*(s|min|h)$ ]] || die "interval must look like 30s, 1min, or 1h"
ROOT="$(readlink -f "$ROOT")"
TSX_BIN="$ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || die "tsx is missing; run pnpm install in $ROOT"
[[ -f "$ROOT/scripts/adminbot-member-sheet-poller.ts" ]] || die "member sheet poller is missing"

UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

cat >"$UNIT_DIR/jinesis-adminbot-sheet-poller.service" <<EOF
[Unit]
Description=Jinesis AdminBot Google Sheet member importer
After=network-online.target jinesis-adminbot.service
Wants=network-online.target jinesis-adminbot.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
Environment=NODE_ENV=production
Environment=ADMINBOT_PORT=$ADMINBOT_PORT
ExecStart=$TSX_BIN $ROOT/scripts/adminbot-member-sheet-poller.ts
TimeoutStartSec=2min
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
EOF

cat >"$UNIT_DIR/jinesis-adminbot-sheet-poller.timer" <<EOF
[Unit]
Description=Poll the AdminBot member Google Sheet

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
AccuracySec=10s
Persistent=true
Unit=jinesis-adminbot-sheet-poller.service

[Install]
WantedBy=timers.target
EOF

systemctl --user disable --now jinesis-adminbot-sheet-poller.timer 2>/dev/null || true
systemctl --user daemon-reload

if [[ "$START_MODE" != "yes" ]]; then
  printf 'member sheet poller units installed but not started\n'
  exit 0
fi

[[ -f "$ENV_FILE" ]] || die "environment file not found: $ENV_FILE"
UNIT_ADMINBOT_PORT="$ADMINBOT_PORT"
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
export ADMINBOT_PORT="$UNIT_ADMINBOT_PORT"
if [[ -z "${ADMINBOT_MEMBER_SHEET_ID:-}" || -z "${ADMINBOT_MEMBER_SHEET_RANGE:-}" ]]; then
  printf 'member sheet poller disabled: set ADMINBOT_MEMBER_SHEET_ID and ADMINBOT_MEMBER_SHEET_RANGE in %s\n' "$ENV_FILE"
  exit 0
fi
[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || die "ADMINBOT_SERVICE_TOKEN is required by the sheet poller"

# Prove both sides are readable before enabling a recurring writer. The first pass is dry-run, so
# a bad header, unknown id, stale Google authorization, or wrong tab fails without changing data.
"$TSX_BIN" "$ROOT/scripts/adminbot-member-sheet-poller.ts" --dry-run ||
  die "member sheet poller dry-run failed"
systemctl --user enable --now jinesis-adminbot-sheet-poller.timer
systemctl --user start jinesis-adminbot-sheet-poller.service
systemctl --user --no-pager --full status jinesis-adminbot-sheet-poller.timer
