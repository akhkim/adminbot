#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

ROOT=""
GATEWAY_PORT="18789"
ADMINBOT_PORT="8765"
START_MODE="no"

usage() {
  cat <<'EOF'
Usage: install-user-services.sh --root <release-current-path> [options]

Options:
  --gateway-port <port>  Default: 18789
  --adminbot-port <port> Default: 8765
  --start                Validate environment and enable/start services
  --no-start             Install/enable unit files without starting (default)
EOF
}

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
    --gateway-port)
      (($# >= 2)) || die "--gateway-port requires a value"
      GATEWAY_PORT="$2"
      shift 2
      ;;
    --adminbot-port)
      (($# >= 2)) || die "--adminbot-port requires a value"
      ADMINBOT_PORT="$2"
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
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$ROOT" ]] || die "--root is required"
[[ -d "$ROOT" ]] || die "release root not found: $ROOT"
[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || die "gateway port must be numeric"
[[ "$ADMINBOT_PORT" =~ ^[0-9]+$ ]] || die "AdminBot port must be numeric"

NODE_BIN="$(command -v node || true)"
[[ -n "$NODE_BIN" ]] || die "Node.js is missing"
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || die "Node.js 22.19+ is required; found $(node --version)"

TSX_BIN="$ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || die "tsx is missing; run pnpm install in $ROOT"
[[ -f "$ROOT/dist/entry.js" || -f "$ROOT/dist/entry.mjs" ]] ||
  die "OpenClaw build output is missing; run pnpm build in $ROOT"

CONFIG_DIR="$HOME/.config/jinesis-adminbot"
ENV_FILE="$CONFIG_DIR/adminbot.env"
UNIT_DIR="$HOME/.config/systemd/user"
CACHE_ROOT="/mfs1/u/$USER/.cache/jinesis-adminbot"

mkdir -p "$CONFIG_DIR" "$UNIT_DIR" "$HOME/.openclaw/state"
if [[ -d "/mfs1/u/$USER" ]]; then
  mkdir -p "$CACHE_ROOT"
else
  CACHE_ROOT="$HOME/.cache/jinesis-adminbot"
  mkdir -p "$CACHE_ROOT"
  printf 'warning: /mfs1/u/%s is unavailable; using home cache %s\n' "$USER" "$CACHE_ROOT" >&2
fi

if [[ ! -f "$ENV_FILE" ]]; then
  sed \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__USER__|$USER|g" \
    "$ROOT/deploy/aurora/adminbot.env.example" >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'created=%s\n' "$ENV_FILE"
  printf 'edit the placeholders before using --start\n' >&2
else
  chmod 600 "$ENV_FILE"
fi

cat >"$UNIT_DIR/jinesis-adminbot.service" <<EOF
[Unit]
Description=Jinesis AdminBot service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
Environment=XDG_CACHE_HOME=$CACHE_ROOT
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $ROOT/start-adminbot.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

cat >"$UNIT_DIR/jinesis-openclaw-gateway.service" <<EOF
[Unit]
Description=Jinesis OpenClaw Gateway
After=network-online.target jinesis-adminbot.service
Wants=network-online.target jinesis-adminbot.service

[Service]
Type=simple
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
Environment=XDG_CACHE_HOME=$CACHE_ROOT
Environment=NODE_ENV=production
ExecStart=$NODE_BIN $ROOT/openclaw.mjs gateway run --bind loopback --port $GATEWAY_PORT --auth token --tailscale off
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

cat >"$UNIT_DIR/jinesis-adminbot-email.service" <<EOF
[Unit]
Description=Jinesis AdminBot hourly email processor
After=network-online.target jinesis-adminbot.service jinesis-vllm.service
Wants=network-online.target jinesis-adminbot.service jinesis-vllm.service

[Service]
Type=oneshot
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
Environment=XDG_CACHE_HOME=$CACHE_ROOT
Environment=NODE_ENV=production
ExecStart=$TSX_BIN $ROOT/scripts/adminbot-email-automation.ts
TimeoutStartSec=30min
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
EOF

systemctl --user disable --now jinesis-adminbot-email.timer 2>/dev/null || true
rm -f -- "$UNIT_DIR/jinesis-adminbot-email.timer"
systemctl --user daemon-reload

if [[ "$START_MODE" == "yes" ]]; then
  grep -q 'REPLACE_ME' "$ENV_FILE" &&
    die "$ENV_FILE still contains REPLACE_ME placeholders"
  [[ -f "$HOME/.openclaw/openclaw.json" ]] ||
    die "$HOME/.openclaw/openclaw.json is missing"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]] ||
    die "OPENCLAW_GATEWAY_TOKEN is missing"
  [[ -n "${GOG_KEYRING_PASSWORD:-}" ]] ||
    die "GOG_KEYRING_PASSWORD is missing"
  [[ -n "${ADMINBOT_LOCAL_BASE_URL:-}" ]] ||
    die "ADMINBOT_LOCAL_BASE_URL is missing"
  [[ -n "${ADMINBOT_LOCAL_MODEL:-}" ]] ||
    die "ADMINBOT_LOCAL_MODEL is missing"
  [[ -n "${VLLM_API_KEY:-}" ]] ||
    die "VLLM_API_KEY is missing"
  slack_mode="$("$NODE_BIN" -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const slack = config.channels?.slack;
    if (slack?.enabled === true) process.stdout.write(slack.mode ?? "socket");
  ' "$HOME/.openclaw/openclaw.json")"
  if [[ -n "$slack_mode" ]]; then
    [[ -n "${SLACK_BOT_TOKEN:-}" ]] ||
      die "Slack is enabled but SLACK_BOT_TOKEN is missing from $ENV_FILE"
    if [[ "$slack_mode" == "socket" ]]; then
      [[ -n "${SLACK_APP_TOKEN:-}" ]] ||
        die "Slack socket mode is enabled but SLACK_APP_TOKEN is missing from $ENV_FILE"
    fi
  fi
  "${GOG_BIN:-gog}" gmail labels list --account jinesis.adminbot@gmail.com --json --no-input >/dev/null ||
    die "gog authentication is not ready on Aurora"
  curl --fail --silent --show-error --max-time 10 \
    -H "Authorization: Bearer $VLLM_API_KEY" \
    "${ADMINBOT_LOCAL_BASE_URL%/}/models" >/dev/null ||
    die "AdminBot local model endpoint is not ready on Aurora"

  systemctl --user enable --now \
    jinesis-adminbot.service \
    jinesis-openclaw-gateway.service
  systemctl --user --no-pager --full status \
    jinesis-adminbot.service \
    jinesis-openclaw-gateway.service
else
  printf 'units installed; services were not started\n'
fi

linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != "yes" ]]; then
  printf 'warning: user lingering is not enabled; ask CSLab to run: loginctl enable-linger %s\n' "$USER" >&2
fi
