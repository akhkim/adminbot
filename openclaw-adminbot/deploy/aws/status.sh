#!/usr/bin/env bash
# Reports whether the AWS host is a healthy standby: the release it would run, that no writer is
# running, that both model tunnels reach Aurora, and that nothing here is serving production traffic.
# Read-only. Exits non-zero if the host is not a safe standby, so it can gate a script or a timer.
set -uo pipefail
export PATH=$HOME/.local/bin:$PATH

ROOT_DIR="/srv/adminbot"
if [[ "${1:-}" == "--root" && -n "${2:-}" ]]; then
  ROOT_DIR="${2%/}"
elif [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  printf 'Usage: deploy/aws/status.sh [--root <dir>]\n'
  exit 0
fi

problems=0
ok() { printf '  ok    %s\n' "$*"; }
bad() {
  printf '  FAIL  %s\n' "$*"
  problems=$((problems + 1))
}

printf 'AdminBot AWS standby (%s)\n' "$ROOT_DIR"
if [[ -f "$ROOT_DIR/current/RELEASE" ]]; then
  ok "release $(sed -n 's/^commit=//p' "$ROOT_DIR/current/RELEASE" | cut -c1-12), built $(sed -n 's/^built_at=//p' "$ROOT_DIR/current/RELEASE")"
else
  bad "no release installed at $ROOT_DIR/current"
fi

for unit in jinesis-adminbot.service jinesis-openclaw-gateway.service \
  jinesis-adminbot-email.timer jinesis-adminbot-sheet-poller.timer; do
  state="$(systemctl --user show "$unit" -p ActiveState --value 2>/dev/null)"
  if [[ "$state" == inactive || "$state" == failed || -z "$state" ]]; then
    ok "$unit not running"
  else
    bad "$unit is $state; a standby must not run writers while Aurora is live"
  fi
done

env_file="$HOME/.config/jinesis-adminbot/adminbot.env"
vllm_key=""
if [[ -f "$env_file" ]]; then
  vllm_key="$(sed -n 's/^VLLM_API_KEY=//p' "$env_file" | tr -d '"')"
  [[ -n "$vllm_key" && "$vllm_key" != vllm-local ]] ||
    bad "VLLM_API_KEY is unset or the vllm-local default"
else
  bad "no env file at $env_file; run deploy/aws/render-env.sh"
fi

if curl -fsS --max-time 10 -H "Authorization: Bearer $vllm_key" http://127.0.0.1:8000/v1/models >/dev/null 2>&1; then
  ok "vLLM on Aurora answers through 127.0.0.1:8000"
else
  bad "vLLM tunnel (127.0.0.1:8000) does not answer; check jinesis-model-tunnel-vllm and Tailscale"
fi
if curl -fsS --max-time 10 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  ok "Ollama on Aurora answers through 127.0.0.1:11434"
else
  bad "Ollama tunnel (127.0.0.1:11434) does not answer; check jinesis-model-tunnel-ollama"
fi

# The production hostnames belong to Aurora until failover. A cloudflared here would split their
# traffic between two backends with two databases.
if pgrep -x cloudflared >/dev/null 2>&1; then
  bad "cloudflared is running on this host; the production tunnel must stay on Aurora until failover"
else
  ok "no cloudflared running on this host"
fi

if [[ -f "$ROOT_DIR/state/adminbot.sqlite" ]]; then
  ok "database present, modified $(date -u -r "$ROOT_DIR/state/adminbot.sqlite" +%Y-%m-%dT%H:%MZ)"
else
  printf '  note  no database in %s/state yet; failover needs a copy from Aurora\n' "$ROOT_DIR"
fi

if ((problems)); then
  printf '%d problem(s)\n' "$problems"
  exit 1
fi
printf 'standby healthy\n'
