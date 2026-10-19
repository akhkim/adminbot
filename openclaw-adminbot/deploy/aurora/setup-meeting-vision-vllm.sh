#!/usr/bin/env bash
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

# The meeting attendance vision model: a second, dedicated vLLM on its own GPU, which reads the
# participant name labels off gallery-view frames of a recorded lab meeting.
#
# Separate from jinesis-vllm on purpose. The main model serves every private completion through the
# shared LLM gateway; a frame is every attendee's face, and the meetings pass sends a handful of
# them an hour to a server that does nothing else. It reuses that server's virtual environment and
# its API key file, so there is one vLLM install and one key to rotate.

GPU="GPU-6a6425d3-2df8-f7eb-980a-a2c1d4c5296b"
MODEL_ID="Qwen/Qwen3.5-27B"
PORT="8006"
MAX_MODEL_LEN="16384"
GPU_MEMORY_UTILIZATION="0.85"
MODEL_HOME="${JINESIS_VLLM_MODEL_HOME:-/mfs1/u/$USER/jinesis-vllm-qwen35}"
FFMPEG_VERSION="0.6.0"
DOWNLOAD_TIMEOUT="3h"
STARTUP_TIMEOUT_SECONDS="900"
# Another tenant's job on the GPU leaves less than the model needs; vLLM would die at startup with
# an out-of-memory error that names neither the GPU nor the job holding it.
BUSY_GPU_MIB="4096"
SKIP_DOWNLOAD="no"
SKIP_START="no"

usage() {
  cat <<'EOF'
Usage: setup-meeting-vision-vllm.sh [options]

Install the dedicated meeting-attendance vision model on one Aurora GPU, loopback only, and point
the meeting artifact pass at it.

Options:
  --gpu <uuid-or-index>         Default: Aurora GPU 6 UUID
  --model <hf-id>               Default: Qwen/Qwen3.5-27B
  --model-home <path>           Existing jinesis-vllm home whose venv and caches are reused
  --port <port>                 Default: 8006
  --max-model-len <tokens>      Default: 16384
  --gpu-memory-utilization <n>  Default: 0.85
  --skip-download               Reuse the existing Hugging Face snapshot
  --skip-start                  Install/configure without starting the server
  -h, --help                    Show help

Run setup-qwen35-vllm.sh first: this reuses its virtual environment and vllm.env key file.
The server is not started while another process holds the GPU; the unit is written and the
script says how to start it once the GPU is free.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --gpu)
      (($# >= 2)) || die "--gpu requires a value"
      GPU="$2"
      shift 2
      ;;
    --model)
      (($# >= 2)) || die "--model requires a value"
      MODEL_ID="$2"
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

[[ "$GPU" =~ ^[A-Za-z0-9._,:-]+$ ]] || die "GPU selector contains unsupported characters"
[[ "$MODEL_ID" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "model must be a Hugging Face id"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "port must be numeric"
[[ "$PORT" != 8000 ]] || die "port 8000 belongs to jinesis-vllm"
[[ "$MAX_MODEL_LEN" =~ ^[0-9]+$ ]] || die "max model length must be numeric"
[[ "$GPU_MEMORY_UTILIZATION" =~ ^0\.[0-9]+$ ]] ||
  die "GPU memory utilization must be a decimal below 1"

for command_name in curl nvidia-smi systemctl timeout uv; do
  command -v "$command_name" >/dev/null || die "$command_name is required"
done

VENV="$MODEL_HOME/venv"
HF_HOME="$MODEL_HOME/huggingface"
HUGGINGFACE_HUB_CACHE="$HF_HOME/hub"
CACHE_BASE="$(dirname -- "$MODEL_HOME")"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_NAME="jinesis-meeting-vision.service"
ENV_DIR="$HOME/.config/jinesis-adminbot"
ENV_FILE="$ENV_DIR/adminbot.env"
VLLM_ENV_FILE="$ENV_DIR/vllm.env"
FFMPEG_VENV="$MODEL_HOME/ffmpeg-venv"

[[ -x "$VENV/bin/vllm" ]] || die "vLLM is missing from $VENV; run setup-qwen35-vllm.sh first"
[[ -f "$VLLM_ENV_FILE" ]] || die "$VLLM_ENV_FILE is missing; run setup-qwen35-vllm.sh first"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE is missing"

gpu_row="$(nvidia-smi --query-gpu=index,uuid,name,memory.used --format=csv,noheader,nounits |
  awk -F', ' -v want="$GPU" '$1 == want || $2 == want')"
[[ -n "$gpu_row" ]] || die "GPU $GPU is not visible"
printf 'gpu=%s\n' "$gpu_row"
GPU_UUID="$(awk -F', ' '{ print $2 }' <<<"$gpu_row")"
GPU_USED_MIB="$(awk -F', ' '{ print $4 }' <<<"$gpu_row")"

# Read the key from the file at request time rather than putting it on curl's argv, where any
# Aurora user's `ps` would show it.
AUTH_HEADER_FILE="$(mktemp)"
trap 'rm -f -- "$AUTH_HEADER_FILE"' EXIT
VLLM_API_KEY="$(sed -n 's/^VLLM_API_KEY=//p' "$VLLM_ENV_FILE" | tail -1 | tr -d '"')"
[[ -n "$VLLM_API_KEY" ]] || die "$VLLM_ENV_FILE carries no VLLM_API_KEY"
printf 'Authorization: Bearer %s\n' "$VLLM_API_KEY" >"$AUTH_HEADER_FILE"

# ffmpeg, pinned through PyPI's hash-checked wheel rather than a tarball from a mirror. The
# imageio build is static, so it needs nothing from the host and survives OS upgrades.
if [[ ! -x "$FFMPEG_VENV/bin/python" ]]; then
  uv venv --quiet "$FFMPEG_VENV"
fi
uv pip install --quiet --python "$FFMPEG_VENV/bin/python" "imageio-ffmpeg==$FFMPEG_VERSION"
FFMPEG_BIN="$("$FFMPEG_VENV/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"
[[ -x "$FFMPEG_BIN" ]] || die "imageio-ffmpeg did not provide an executable ffmpeg"
"$FFMPEG_BIN" -hide_banner -version | head -1

if [[ "$SKIP_DOWNLOAD" == "no" ]]; then
  printf 'Downloading %s into %s; this is resumable\n' "$MODEL_ID" "$HUGGINGFACE_HUB_CACHE"
  HF_HOME="$HF_HOME" HF_HUB_DOWNLOAD_TIMEOUT=120 HF_HUB_ENABLE_HF_TRANSFER=1 \
    timeout "$DOWNLOAD_TIMEOUT" "$VENV/bin/hf" download "$MODEL_ID" \
    --cache-dir "$HUGGINGFACE_HUB_CACHE"
fi

set_env_key() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}
set_env_key ADMINBOT_MEETING_VISION_BASE_URL "http://127.0.0.1:$PORT/v1"
set_env_key ADMINBOT_MEETING_VISION_MODEL "$MODEL_ID"
set_env_key ADMINBOT_FFMPEG_BIN "$FFMPEG_BIN"
chmod 600 "$ENV_FILE"

mkdir -p "$UNIT_DIR"
cat >"$UNIT_DIR/$UNIT_NAME" <<EOF
[Unit]
Description=Jinesis meeting attendance vision model ($MODEL_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CUDA_VISIBLE_DEVICES=$GPU_UUID
Environment=HF_HOME=$HF_HOME
Environment=HUGGINGFACE_HUB_CACHE=$HUGGINGFACE_HUB_CACHE
Environment=HF_HUB_OFFLINE=1
Environment=VLLM_CACHE_ROOT=$CACHE_BASE/.cache/vllm
Environment=FLASHINFER_WORKSPACE_BASE=$CACHE_BASE
Environment=VLLM_NO_USAGE_STATS=1
# The key comes from this file (vLLM reads VLLM_API_KEY), never --api-key: argv is visible to
# every user on Aurora.
EnvironmentFile=$VLLM_ENV_FILE
# One image per request and no video: the pass sends single frames, and a server that accepts a
# video URL is one that can be made to fetch something. The JSON is single-quoted because systemd
# strips bare double quotes from an argument.
ExecStart=$VENV/bin/vllm serve $MODEL_ID --host 127.0.0.1 --port $PORT --trust-remote-code --tensor-parallel-size 1 --max-model-len $MAX_MODEL_LEN --gpu-memory-utilization $GPU_MEMORY_UTILIZATION --max-num-seqs 2 --limit-mm-per-prompt '{"image":1,"video":0}' --reasoning-parser qwen3 --generation-config vllm --enable-prefix-caching
Restart=on-failure
RestartSec=30
TimeoutStartSec=20min
TimeoutStopSec=2min
UMask=0077
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
chmod 600 "$UNIT_DIR/$UNIT_NAME"
systemctl --user daemon-reload
printf 'configured=%s\n' "$UNIT_DIR/$UNIT_NAME"

if [[ "$SKIP_START" == "yes" ]]; then
  printf 'Start later with: systemctl --user enable --now %s\n' "$UNIT_NAME"
  exit 0
fi

if ! systemctl --user is-active --quiet "$UNIT_NAME" && ((GPU_USED_MIB > BUSY_GPU_MIB)); then
  printf 'GPU %s already has %s MiB in use by another process:\n' "$GPU_UUID" "$GPU_USED_MIB"
  nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory --format=csv,noheader |
    grep -F "$GPU_UUID" || true
  printf 'Not starting. Once it is free: systemctl --user enable --now %s\n' "$UNIT_NAME"
  printf 'Until then the meeting pass reports gallery recordings as errors and retries hourly.\n'
  exit 0
fi

systemctl --user enable "$UNIT_NAME"
systemctl --user restart "$UNIT_NAME"
deadline=$((SECONDS + STARTUP_TIMEOUT_SECONDS))
printf 'Waiting up to %ss for the vision model' "$STARTUP_TIMEOUT_SECONDS"
while ((SECONDS < deadline)); do
  if curl --fail --silent --max-time 5 -H @"$AUTH_HEADER_FILE" \
    "http://127.0.0.1:$PORT/v1/models" 2>/dev/null | grep -qF "\"$MODEL_ID\""; then
    printf '\n'
    break
  fi
  printf '.'
  sleep 10
done
((SECONDS < deadline)) ||
  die "the vision model did not become ready; inspect: journalctl --user -u $UNIT_NAME -n 200"

# One synthetic frame through the exact request shape the meetings pass sends: a data-URL image,
# thinking off, a strict JSON schema. A blank gray frame has no tiles, so the model must answer
# with a valid layout and no names.
frame_file="$(mktemp --suffix=.jpg)"
"$FFMPEG_BIN" -nostdin -hide_banner -loglevel error -f lavfi -i color=c=gray:s=640x360 \
  -frames:v 1 -y "$frame_file"
frame_base64="$(base64 -w0 "$frame_file")"
rm -f -- "$frame_file"
payload_file="$(mktemp)"
cat >"$payload_file" <<EOF
{"model":"$MODEL_ID","chat_template_kwargs":{"enable_thinking":false},"temperature":0,"max_tokens":256,
 "response_format":{"type":"json_schema","json_schema":{"name":"gallery_attendance","strict":true,"schema":{"type":"object","properties":{"layout":{"type":"string","enum":["gallery","screen_share","speaker","other"]},"names":{"type":"array","items":{"type":"string"}}},"required":["layout","names"],"additionalProperties":false}}},
 "messages":[{"role":"user","content":[{"type":"text","text":"Which participant name labels are visible?"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,$frame_base64"}}]}]}
EOF
smoke="$(curl --fail-with-body --silent --show-error --max-time 300 \
  -H @"$AUTH_HEADER_FILE" -H "Content-Type: application/json" \
  --data @"$payload_file" "http://127.0.0.1:$PORT/v1/chat/completions")" || {
  rm -f -- "$payload_file"
  die "vision smoke test request failed"
}
rm -f -- "$payload_file"
grep -q '\\"layout\\"' <<<"$smoke" || die "vision smoke test returned no layout: $smoke"

printf 'vision_url=http://127.0.0.1:%s/v1\n' "$PORT"
printf 'model=%s\n' "$MODEL_ID"
printf 'gpu=%s\n' "$GPU_UUID"
printf 'ffmpeg=%s\n' "$FFMPEG_BIN"
printf 'The next meeting artifact pass (hourly at :20) samples gallery recordings.\n'
