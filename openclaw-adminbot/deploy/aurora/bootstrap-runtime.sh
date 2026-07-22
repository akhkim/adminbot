#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

ROOT=""
GATEWAY_PORT="18789"
ADMINBOT_PORT="8765"
GPU="GPU-51e9e550-a798-120d-2926-5c76e25b9e56"
CONFIGURE_TAILSCALE="yes"
START_ADMINBOT="yes"
SETUP_ARGS=()

usage() {
  cat <<'EOF'
Usage: bootstrap-runtime.sh --root <current-release> [options]

Configure Qwen3.5-122B-A10B-NVFP4 through loopback vLLM, install the
AdminBot/Gateway/email services, and optionally configure Tailscale Serve.

Options:
  --root <path>             Deployed current release (required)
  --gateway-port <port>     Default: 18789
  --adminbot-port <port>    Default: 8765
  --gpu <index-or-uuid>     Default: Aurora GPU 0 UUID
  --skip-install            Reuse the existing vLLM environment
  --skip-model-download     Reuse the existing Hugging Face snapshot
  --skip-vllm-start         Configure vLLM without starting it
  --skip-tailscale          Do not configure Tailscale Serve
  --skip-adminbot-start     Install service units without starting them
  -h, --help                Show help

The model and vLLM environment default to /mfs1/u/<user>/jinesis-vllm-qwen35.
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
    --gpu)
      (($# >= 2)) || die "--gpu requires a value"
      GPU="$2"
      shift 2
      ;;
    --skip-install)
      SETUP_ARGS+=(--skip-install)
      shift
      ;;
    --skip-model-download)
      SETUP_ARGS+=(--skip-download)
      shift
      ;;
    --skip-vllm-start)
      SETUP_ARGS+=(--skip-start)
      START_ADMINBOT="no"
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
[[ -x "$ROOT/deploy/aurora/setup-qwen35-vllm.sh" ]] ||
  die "Qwen vLLM setup script is missing from $ROOT"

"$ROOT/deploy/aurora/setup-qwen35-vllm.sh" \
  --root "$ROOT" \
  --gpu "$GPU" \
  "${SETUP_ARGS[@]}"

SERVICE_ARGS=(
  --root "$ROOT"
  --gateway-port "$GATEWAY_PORT"
  --adminbot-port "$ADMINBOT_PORT"
)
if [[ "$START_ADMINBOT" == "yes" ]]; then
  SERVICE_ARGS+=(--start)
else
  SERVICE_ARGS+=(--no-start)
fi
"$ROOT/deploy/aurora/install-user-services.sh" "${SERVICE_ARGS[@]}"

if [[ "$CONFIGURE_TAILSCALE" == "yes" ]]; then
  command -v tailscale >/dev/null ||
    die "tailscale is not installed; ask CSLab to install and start the system daemon"
  tailscale status >/dev/null 2>&1 ||
    die "Tailscale is not logged in; ask CSLab to provision Aurora in your tailnet"
  tailscale serve --bg "http://127.0.0.1:${GATEWAY_PORT}" >/dev/null ||
    die "Tailscale Serve failed; ask CSLab to run: sudo tailscale set --operator=$USER"
  tailscale serve status
fi

printf 'Aurora Qwen runtime bootstrap complete.\n'
printf 'vLLM: http://127.0.0.1:8000/v1\n'
printf 'model: nvidia/Qwen3.5-122B-A10B-NVFP4\n'
printf 'storage: /mfs1/u/%s/jinesis-vllm-qwen35\n' "$USER"
