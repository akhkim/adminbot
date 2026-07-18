#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

ROOT=""
GATEWAY_PORT="18789"
MODEL="gemma4:e4b-it-qat"
GPU=""
PULL_TIMEOUT="30m"
PULL_MODEL="yes"
CONFIGURE_TAILSCALE="yes"
START_ADMINBOT="yes"

usage() {
  cat <<'EOF'
Usage: bootstrap-runtime.sh --root <current-release> [options]

Configure and verify Aurora's GPU-backed Ollama service, tailnet-only
Tailscale Serve route, and deployed AdminBot services.

Options:
  --root <path>             Deployed current release (required)
  --gateway-port <port>     Default: 18789
  --model <ollama-model>    Default: gemma4:e4b-it-qat
  --gpu <index-or-uuid>     CUDA_VISIBLE_DEVICES value; UUID recommended
  --pull-timeout <duration> Bound model pull time (default: 30m)
  --skip-model-pull         Do not pull the configured model
  --skip-tailscale          Do not configure Tailscale Serve
  --skip-adminbot-start     Do not start AdminBot/Gateway/email timer
  -h, --help                Show this help

Prerequisites:
  - Run this script on Aurora as the CS account that owns the deployment.
  - CSLab must install/log in the system Tailscale daemon and authorize this
    account as the Tailscale operator.
  - ollama, curl, Node.js 22.19+, and user systemd must be available.
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
    --model)
      (($# >= 2)) || die "--model requires a value"
      MODEL="$2"
      shift 2
      ;;
    --gpu)
      (($# >= 2)) || die "--gpu requires a value"
      GPU="$2"
      shift 2
      ;;
    --pull-timeout)
      (($# >= 2)) || die "--pull-timeout requires a value"
      PULL_TIMEOUT="$2"
      shift 2
      ;;
    --skip-model-pull)
      PULL_MODEL="no"
      shift
      ;;
    --skip-tailscale)
      CONFIGURE_TAILSCALE="no"
      shift
      ;;
    --skip-adminbot-start)
      START_ADMINBOT="no"
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
[[ "$MODEL" =~ ^[A-Za-z0-9._:/-]+$ ]] || die "model contains unsupported characters"
[[ -z "$GPU" || "$GPU" =~ ^[A-Za-z0-9._,:-]+$ ]] ||
  die "GPU selector contains unsupported characters"
[[ "$PULL_TIMEOUT" =~ ^[1-9][0-9]*[smhd]$ ]] ||
  die "pull timeout must look like 30m, 2h, or 900s"
[[ -x "$ROOT/deploy/aurora/install-user-services.sh" ]] ||
  die "service installer is missing from $ROOT"

for command_name in curl ollama systemctl timeout; do
  command -v "$command_name" >/dev/null || die "$command_name is required"
done

OLLAMA_BIN="$(command -v ollama)"
ENV_FILE="$HOME/.config/jinesis-adminbot/adminbot.env"
UNIT_DIR="$HOME/.config/systemd/user"
MODEL_ROOT="/mfs1/u/$USER/ollama-models"
[[ -d "/mfs1/u/$USER" ]] || MODEL_ROOT="$HOME/.cache/jinesis-adminbot/ollama-models"

mkdir -p "$(dirname "$ENV_FILE")" "$UNIT_DIR" "$MODEL_ROOT"

cat >"$UNIT_DIR/jinesis-ollama.service" <<EOF
[Unit]
Description=Jinesis private Ollama GPU service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$OLLAMA_BIN serve
Environment=OLLAMA_HOST=127.0.0.1:11434
Environment=OLLAMA_MODELS=$MODEL_ROOT
Environment=OLLAMA_KEEP_ALIVE=10m
EOF

if [[ -n "$GPU" ]]; then
  printf 'Environment=CUDA_VISIBLE_DEVICES=%s\n' "$GPU" >>"$UNIT_DIR/jinesis-ollama.service"
fi

cat >>"$UNIT_DIR/jinesis-ollama.service" <<'EOF'
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now jinesis-ollama.service

printf 'Waiting up to 60 seconds for Ollama'
ollama_ready="no"
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 2 \
    http://127.0.0.1:11434/api/tags >/dev/null; then
    ollama_ready="yes"
    break
  fi
  printf '.'
  sleep 2
done
printf '\n'
[[ "$ollama_ready" == "yes" ]] ||
  die "Ollama did not become ready; inspect: journalctl --user -u jinesis-ollama -n 100"

if [[ "$PULL_MODEL" == "yes" ]]; then
  printf 'Pulling %s with timeout %s\n' "$MODEL" "$PULL_TIMEOUT"
  OLLAMA_HOST=http://127.0.0.1:11434 timeout "$PULL_TIMEOUT" ollama pull "$MODEL" ||
    die "model pull failed or exceeded $PULL_TIMEOUT"
fi

curl --fail --silent --show-error --max-time 5 \
  http://127.0.0.1:11434/api/tags >/dev/null

if command -v nvidia-smi >/dev/null; then
  printf '%s\n' '--- NVIDIA GPUs visible to this account ---'
  nvidia-smi -L
else
  printf 'warning: nvidia-smi is unavailable; GPU execution cannot be verified\n' >&2
fi

[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing; upload the populated environment first"
if grep -q '^OLLAMA_BASE_URL=' "$ENV_FILE"; then
  sed -i 's|^OLLAMA_BASE_URL=.*|OLLAMA_BASE_URL=http://127.0.0.1:11434|' "$ENV_FILE"
else
  printf '\nOLLAMA_BASE_URL=http://127.0.0.1:11434\n' >>"$ENV_FILE"
fi
if grep -q '^ADMINBOT_LOCAL_MODEL=' "$ENV_FILE"; then
  sed -i "s|^ADMINBOT_LOCAL_MODEL=.*|ADMINBOT_LOCAL_MODEL=$MODEL|" "$ENV_FILE"
else
  printf 'ADMINBOT_LOCAL_MODEL=%s\n' "$MODEL" >>"$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

if [[ "$START_ADMINBOT" == "yes" ]]; then
  "$ROOT/deploy/aurora/install-user-services.sh" \
    --root "$ROOT" \
    --gateway-port "$GATEWAY_PORT" \
    --start
fi

if [[ "$CONFIGURE_TAILSCALE" == "yes" ]]; then
  command -v tailscale >/dev/null ||
    die "tailscale is not installed; ask CSLab to install and start the system daemon"
  tailscale status >/dev/null 2>&1 ||
    die "Tailscale is not logged in; ask CSLab to provision Aurora in your tailnet"
  tailscale serve --bg "http://127.0.0.1:${GATEWAY_PORT}" >/dev/null ||
    die "Tailscale Serve failed; ask CSLab to run: sudo tailscale set --operator=$USER"
  printf '%s\n' '--- Tailscale Serve ---'
  tailscale serve status
fi

if [[ "$START_ADMINBOT" == "yes" ]]; then
  curl --fail --silent --show-error --max-time 5 \
    http://127.0.0.1:8765/settings >/dev/null ||
    die "AdminBot health check failed"
  systemctl --user is-active --quiet jinesis-openclaw-gateway.service ||
    die "OpenClaw Gateway is not active"
  systemctl --user is-active --quiet jinesis-adminbot-email.timer ||
    die "AdminBot email timer is not active"
fi

linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != "yes" ]]; then
  printf 'warning: ask CSLab to run: loginctl enable-linger %s\n' "$USER" >&2
fi

printf '%s\n' 'Aurora runtime bootstrap complete.'
printf 'Ollama: http://127.0.0.1:11434 model=%s\n' "$MODEL"
printf 'AdminBot remains loopback-only: http://127.0.0.1:8765\n'
if [[ "$CONFIGURE_TAILSCALE" == "yes" ]]; then
  printf 'Open the HTTPS URL reported by: tailscale serve status\n'
fi
