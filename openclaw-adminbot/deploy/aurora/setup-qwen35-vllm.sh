#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

ROOT=""
GPU="GPU-51e9e550-a798-120d-2926-5c76e25b9e56"
MODEL_ID="nvidia/Qwen3.5-122B-A10B-NVFP4"
MODEL_HOME="$HOME/.cache/jinesis-vllm"
PORT="8000"
MAX_MODEL_LEN="32768"
GPU_MEMORY_UTILIZATION="0.95"
INSTALL_TIMEOUT="45m"
DOWNLOAD_TIMEOUT="6h"
STARTUP_TIMEOUT="15m"
SKIP_INSTALL="no"
SKIP_DOWNLOAD="no"
SKIP_START="no"

usage() {
  cat <<'EOF'
Usage: setup-qwen35-vllm.sh --root <current-release> [options]

Install and configure the single-GPU Qwen3.5 NVFP4 runtime on Aurora.

Options:
  --root <path>                 Deployed OpenClaw release (required)
  --gpu <uuid-or-index>         Default: Aurora GPU 0 UUID
  --model-home <path>           Default: ~/.cache/jinesis-vllm
  --port <port>                 Default: 8000
  --max-model-len <tokens>      Default: 32768
  --gpu-memory-utilization <n>  Default: 0.95
  --skip-install                Reuse the existing vLLM virtual environment
  --skip-download               Reuse the existing Hugging Face snapshot
  --skip-start                  Install/configure without starting vLLM
  -h, --help                    Show help

The script is resumable. Re-running it reuses downloaded Hugging Face blobs.
It keeps vLLM loopback-only and disables the old user Ollama service.
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
    --gpu)
      (($# >= 2)) || die "--gpu requires a value"
      GPU="$2"
      shift 2
      ;;
    --model-home)
      (($# >= 2)) || die "--model-home requires a value"
      MODEL_HOME="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || die "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --max-model-len)
      (($# >= 2)) || die "--max-model-len requires a value"
      MAX_MODEL_LEN="$2"
      shift 2
      ;;
    --gpu-memory-utilization)
      (($# >= 2)) || die "--gpu-memory-utilization requires a value"
      GPU_MEMORY_UTILIZATION="$2"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL="yes"
      shift
      ;;
    --skip-download)
      SKIP_DOWNLOAD="yes"
      shift
      ;;
    --skip-start)
      SKIP_START="yes"
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
[[ -f "$ROOT/deploy/aurora/configure-openclaw-qwen35.mjs" ]] ||
  die "OpenClaw Qwen configuration helper is missing from $ROOT"
[[ "$GPU" =~ ^[A-Za-z0-9._,:-]+$ ]] || die "GPU selector contains unsupported characters"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be numeric"
[[ "$MAX_MODEL_LEN" =~ ^[0-9]+$ ]] || die "max model length must be numeric"
[[ "$GPU_MEMORY_UTILIZATION" =~ ^0\.[0-9]+$ ]] ||
  die "GPU memory utilization must be a decimal below 1"

for command_name in curl nvidia-smi python3 systemctl timeout; do
  command -v "$command_name" >/dev/null || die "$command_name is required"
done

gpu_row="$(nvidia-smi --query-gpu=uuid,name,memory.total,compute_cap --format=csv,noheader |
  grep -F "$GPU" || true)"
[[ -n "$gpu_row" ]] || die "GPU $GPU is not visible"
printf 'gpu=%s\n' "$gpu_row"
grep -q 'Blackwell' <<<"$gpu_row" || die "the NVFP4 checkpoint requires a Blackwell GPU"

VENV="$MODEL_HOME/venv"
HF_HOME="$MODEL_HOME/huggingface"
UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/jinesis-adminbot"
ENV_FILE="$ENV_DIR/adminbot.env"
OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"
VLLM_API_KEY="${VLLM_API_KEY:-vllm-local}"

mkdir -p "$MODEL_HOME" "$HF_HOME" "$UNIT_DIR" "$ENV_DIR"
chmod 700 "$MODEL_HOME" "$ENV_DIR"

if [[ "$SKIP_DOWNLOAD" == "no" ]]; then
  available_kb="$(df -Pk "$MODEL_HOME" | awk 'NR == 2 { print $4 }')"
  required_kb=$((110 * 1024 * 1024))
  ((available_kb >= required_kb)) ||
    die "at least 110 GiB free is required before first download; available KiB: $available_kb"
fi

if [[ $SKIP_INSTALL == no ]]; then
  $ROOT/deploy/aurora/install-vllm-env.sh \
    --venv $VENV \
    --timeout $INSTALL_TIMEOUT
fi

[[ -x "$VENV/bin/vllm" ]] || die "vLLM is missing from $VENV"
[[ -x "$VENV/bin/hf" ]] || die "Hugging Face CLI is missing from $VENV"

export HF_HOME
export HUGGINGFACE_HUB_CACHE="$HF_HOME/hub"
export HF_HUB_DOWNLOAD_TIMEOUT=120
export HF_HUB_ENABLE_HF_TRANSFER=1

if [[ "$SKIP_DOWNLOAD" == "no" ]]; then
  printf 'Downloading %s into %s; this is resumable\n' "$MODEL_ID" "$HUGGINGFACE_HUB_CACHE"
  timeout "$DOWNLOAD_TIMEOUT" "$VENV/bin/hf" download "$MODEL_ID" \
    --cache-dir "$HUGGINGFACE_HUB_CACHE"
fi

"$VENV/bin/python" - "$MODEL_ID" "$HUGGINGFACE_HUB_CACHE" <<'PY'
import sys
from huggingface_hub import snapshot_download

model_id, cache_dir = sys.argv[1:]
path = snapshot_download(repo_id=model_id, cache_dir=cache_dir, local_files_only=True)
print(f"model_snapshot={path}")
PY

[[ -f "$OPENCLAW_CONFIG" ]] || die "$OPENCLAW_CONFIG is missing"
VLLM_API_KEY="$VLLM_API_KEY" \
JINESIS_VLLM_MODEL="$MODEL_ID" \
JINESIS_VLLM_BASE_URL="http://127.0.0.1:$PORT/v1" \
  node "$ROOT/deploy/aurora/configure-openclaw-qwen35.mjs" "$OPENCLAW_CONFIG"

if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^VLLM_API_KEY=' "$ENV_FILE"; then
    sed -i "s|^VLLM_API_KEY=.*|VLLM_API_KEY=$VLLM_API_KEY|" "$ENV_FILE"
  else
    printf '\nVLLM_API_KEY=%s\n' "$VLLM_API_KEY" >>"$ENV_FILE"
  fi
  if grep -q '^ADMINBOT_LOCAL_MODEL=' "$ENV_FILE"; then
    sed -i "s|^ADMINBOT_LOCAL_MODEL=.*|ADMINBOT_LOCAL_MODEL=$MODEL_ID|" "$ENV_FILE"
  else
    printf 'ADMINBOT_LOCAL_MODEL=%s\n' "$MODEL_ID" >>"$ENV_FILE"
  fi
  if grep -q '^ADMINBOT_LOCAL_BASE_URL=' "$ENV_FILE"; then
    sed -i "s|^ADMINBOT_LOCAL_BASE_URL=.*|ADMINBOT_LOCAL_BASE_URL=http://127.0.0.1:$PORT/v1|" "$ENV_FILE"
  else
    printf 'ADMINBOT_LOCAL_BASE_URL=http://127.0.0.1:%s/v1\n' "$PORT" >>"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
fi

cat >"$UNIT_DIR/jinesis-vllm.service" <<EOF
[Unit]
Description=Jinesis Qwen3.5 NVFP4 vLLM service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CUDA_VISIBLE_DEVICES=$GPU
Environment=HF_HOME=$HF_HOME
Environment=HUGGINGFACE_HUB_CACHE=$HUGGINGFACE_HUB_CACHE
Environment=HF_HUB_DOWNLOAD_TIMEOUT=120
Environment=VLLM_API_KEY=$VLLM_API_KEY
ExecStart=$VENV/bin/vllm serve $MODEL_ID --host 127.0.0.1 --port $PORT --api-key $VLLM_API_KEY --trust-remote-code --quantization modelopt_fp4 --kv-cache-dtype fp8 --tensor-parallel-size 1 --max-model-len $MAX_MODEL_LEN --gpu-memory-utilization $GPU_MEMORY_UTILIZATION --reasoning-parser qwen3 --enable-auto-tool-choice --tool-call-parser qwen3_coder --generation-config vllm
Restart=on-failure
RestartSec=10
TimeoutStartSec=20min
TimeoutStopSec=2min
UMask=0077
PrivateTmp=true

[Install]
WantedBy=default.target
EOF

systemctl --user disable --now jinesis-ollama.service >/dev/null 2>&1 || true
systemctl --user daemon-reload

if [[ "$SKIP_START" == "yes" ]]; then
  printf 'configured=%s\n' "$UNIT_DIR/jinesis-vllm.service"
  printf 'Start later with: systemctl --user enable --now jinesis-vllm.service\n'
  exit 0
fi

systemctl --user enable --now jinesis-vllm.service
deadline=$((SECONDS + 900))
printf 'Waiting up to %s for vLLM' "$STARTUP_TIMEOUT"
while ((SECONDS < deadline)); do
  if curl --fail --silent --show-error --max-time 5 \
    -H "Authorization: Bearer $VLLM_API_KEY" \
    "http://127.0.0.1:$PORT/v1/models" >/dev/null; then
    printf '\n'
    break
  fi
  printf '.'
  sleep 10
done
((SECONDS < deadline)) ||
  die "vLLM did not become ready; inspect: journalctl --user -u jinesis-vllm -n 200"

privacy_payload='{"model":"nvidia/Qwen3.5-122B-A10B-NVFP4","messages":[{"role":"system","content":"Classify locally. Return JSON only."},{"role":"user","content":"Return {\"classification\":\"generic\"}."}],"temperature":0,"max_tokens":128,"chat_template_kwargs":{"enable_thinking":false},"response_format":{"type":"json_schema","json_schema":{"name":"privacy_classification","strict":true,"schema":{"type":"object","properties":{"classification":{"type":"string","enum":["generic","private","uncertain"]}},"required":["classification"],"additionalProperties":false}}}}'
curl --fail --silent --show-error --max-time 300 \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  -H "Content-Type: application/json" \
  --data "$privacy_payload" \
  "http://127.0.0.1:$PORT/v1/chat/completions" >/dev/null ||
  die "JSON-schema privacy smoke test failed"

systemctl --user try-restart jinesis-adminbot.service jinesis-openclaw-gateway.service || true

printf 'vllm_url=http://127.0.0.1:%s/v1\n' "$PORT"
printf 'model=%s\n' "$MODEL_ID"
printf 'gpu=%s\n' "$GPU"
printf 'context=%s\n' "$MAX_MODEL_LEN"
printf 'Privacy calls: temperature=0, thinking=false, JSON schema, <=1024 tokens.\n'
printf 'Normal inference: use /think on and temperature 0.15 through OpenClaw.\n'
