#!/usr/bin/env bash
# Puts AdminBot's model GPU behind the sharing gate (deploy/aurora/gpu-share/jinesis_gpu_share.py).
#
# AdminBot keeps calling http://127.0.0.1:8000/v1. After this, that port is the gate; vLLM moves to
# a Unix socket in a 0700 runtime directory with sleep mode on. When AdminBot has been idle for
# --idle-seconds the model sleeps and the GPU is free for jobs started with `gpu7-borrow`; the
# next AdminBot request stops those jobs (SIGTERM, then SIGKILL after --grace-seconds) and wakes
# the model.
#
# Dry run unless --apply. Applying restarts jinesis-vllm, which is a cold start of ~20 minutes.
#
# Usage:
#   deploy/aurora/install-gpu-share.sh --gpu-uuid GPU-... [--idle-seconds 900]
#       [--grace-seconds 60] [--apply]
set -euo pipefail

GPU_UUID=""
IDLE_SECONDS=900
GRACE_SECONDS=60
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --gpu-uuid) GPU_UUID="${2:-}"; shift 2 ;;
    --idle-seconds) IDLE_SECONDS="${2:-}"; shift 2 ;;
    --grace-seconds) GRACE_SECONDS="${2:-}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) printf 'install-gpu-share: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$GPU_UUID" =~ ^GPU-[0-9a-f-]+$ ]] || { echo "install-gpu-share: --gpu-uuid GPU-... is required" >&2; exit 2; }
[[ "$IDLE_SECONDS" =~ ^[0-9]+$ && "$GRACE_SECONDS" =~ ^[0-9]+$ ]] || { echo "install-gpu-share: seconds must be whole numbers" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$HERE/gpu-share/jinesis_gpu_share.py"
[[ -f "$SOURCE" ]] || { echo "install-gpu-share: missing $SOURCE" >&2; exit 1; }
PYTHON="$(command -v python3)"

# Installed outside the release directory on purpose: a deploy or a rollback must not swap the
# gate's code out from under the running service.
SHARE_DIR="$HOME/.local/share/jinesis-adminbot/gpu-share"
UNIT_DIR="$HOME/.config/systemd/user"
DROPIN_DIR="$UNIT_DIR/jinesis-vllm.service.d"
RUNTIME='%t/jinesis-gpu7'

# vLLM's own command line, from the unit file itself (not a drop-in), minus its TCP listener.
BASE_EXEC="$(sed -n 's/^ExecStart=//p' "$UNIT_DIR/jinesis-vllm.service" | head -1)"
[[ -n "$BASE_EXEC" ]] || { echo "install-gpu-share: no ExecStart in $UNIT_DIR/jinesis-vllm.service" >&2; exit 1; }
SOCKET_EXEC="$(printf '%s' "$BASE_EXEC" | sed -E 's/ --host [^ ]+//; s/ --port [^ ]+//; s/ --uds [^ ]+//; s/ --enable-sleep-mode//')"
SOCKET_EXEC="$SOCKET_EXEC --uds $RUNTIME/vllm.sock --enable-sleep-mode"

VLLM_DROPIN="$(cat <<UNIT
# Written by deploy/aurora/install-gpu-share.sh. vLLM serves on a private Unix socket with sleep
# mode on; the gate (jinesis-vllm-gate) owns 127.0.0.1:8000. VLLM_SERVER_DEV_MODE is needed for
# sleep mode and adds unauthenticated control endpoints -- which is why vLLM must not listen on TCP.
[Service]
Environment=CUDA_VISIBLE_DEVICES=$GPU_UUID
Environment=VLLM_SERVER_DEV_MODE=1
Environment=GATE_RUNTIME_DIR=$RUNTIME
Environment=GATE_PREEMPT_GRACE_SECONDS=$GRACE_SECONDS
ExecStartPre=/bin/mkdir -p -m 0700 $RUNTIME
ExecStartPre=-$PYTHON $SHARE_DIR/jinesis_gpu_share.py preempt
ExecStart=
ExecStart=$SOCKET_EXEC
Restart=always
RestartSec=60
UNIT
)"

GATE_UNIT="$(cat <<UNIT
[Unit]
Description=Jinesis model GPU gate: AdminBot first, borrowers when idle
After=jinesis-vllm.service
Wants=jinesis-vllm.service

[Service]
Environment=GATE_RUNTIME_DIR=$RUNTIME
Environment=GATE_GPU_UUID=$GPU_UUID
Environment=GATE_IDLE_SECONDS=$IDLE_SECONDS
Environment=GATE_PREEMPT_GRACE_SECONDS=$GRACE_SECONDS
ExecStartPre=/bin/mkdir -p -m 0700 $RUNTIME
ExecStart=$PYTHON $SHARE_DIR/jinesis_gpu_share.py gate --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
)"

BORROW="$(cat <<SCRIPT
#!/bin/sh
# Run a job on AdminBot's model GPU while the model is idle. It is stopped (SIGTERM, then SIGKILL
# after ${GRACE_SECONDS}s) when AdminBot needs the GPU; checkpoint on SIGTERM.
#   gpu7-borrow python train.py ...
export CUDA_VISIBLE_DEVICES=$GPU_UUID
export GATE_RUNTIME_DIR="\${XDG_RUNTIME_DIR:-/run/user/\$(id -u)}/jinesis-gpu7"
exec $PYTHON $SHARE_DIR/jinesis_gpu_share.py borrow -- "\$@"
SCRIPT
)"

if [[ "$APPLY" != "1" ]]; then
  printf '== %s/gpu-share.conf\n%s\n\n' "$DROPIN_DIR" "$VLLM_DROPIN"
  printf '== %s/jinesis-vllm-gate.service\n%s\n\n' "$UNIT_DIR" "$GATE_UNIT"
  printf '== %s/.local/bin/gpu7-borrow\n%s\n\n' "$HOME" "$BORROW"
  echo "dry run: nothing written. Re-run with --apply (restarts jinesis-vllm: ~20 min cold start)."
  exit 0
fi

mkdir -p "$SHARE_DIR" "$DROPIN_DIR" "$HOME/.local/bin"
install -m 0644 "$SOURCE" "$SHARE_DIR/jinesis_gpu_share.py"
printf '%s\n' "$VLLM_DROPIN" > "$DROPIN_DIR/gpu-share.conf"
# Superseded by gpu-share.conf: the GPU pin and restart policy now live there.
rm -f "$DROPIN_DIR/gpu-and-restart.conf"
printf '%s\n' "$GATE_UNIT" > "$UNIT_DIR/jinesis-vllm-gate.service"
printf '%s\n' "$BORROW" > "$HOME/.local/bin/gpu7-borrow"
chmod 0755 "$HOME/.local/bin/gpu7-borrow"

systemctl --user daemon-reload
# vLLM first: it gives up port 8000 for the socket, and the gate takes the port.
systemctl --user restart jinesis-vllm
systemctl --user enable --now jinesis-vllm-gate
systemctl --user restart jinesis-vllm-gate
echo "installed. jinesis-vllm is cold-starting on its socket; the gate answers 503 until it is up."
echo "check:  systemctl --user status jinesis-vllm-gate;  $PYTHON $SHARE_DIR/jinesis_gpu_share.py status"
