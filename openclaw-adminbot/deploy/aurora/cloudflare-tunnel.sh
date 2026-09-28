#!/usr/bin/env bash
#
# Publish Aurora's AdminBot at admin.safe.eu via a Cloudflare named tunnel.
#
# Runs ON AURORA, as your CS user, with no sudo. It installs cloudflared into
# ~/.local/bin, creates a tunnel, writes the ingress config, and installs a
# systemd *user* unit alongside the existing jinesis-* services.
#
# Prerequisite — copy the Cloudflare account cert from your laptop first:
#     scp ~/.cloudflared/cert.pem <cs-user>@$AURORA_HOST:~/.cloudflared/cert.pem
# (create ~/.cloudflared on Aurora first if it does not exist)
#
# Usage on Aurora:
#     chmod +x aurora-tunnel-setup.sh
#     ./aurora-tunnel-setup.sh                  # set up, do NOT touch DNS
#     OVERWRITE_DNS=1 ./aurora-tunnel-setup.sh  # also repoint admin.safe.eu here
#
# The DNS step is opt-in because admin.safe.eu currently points at
# 3.221.59.247 (an EC2 box running Caddy). Repointing it is an immediate,
# public cutover. Record the old value before you do it.
#
# Model hostnames (optional). MODEL_VLLM_HOST / MODEL_OLLAMA_HOST publish Aurora's vLLM and Ollama
# as private TCP services for the AWS standby, which reaches them with `cloudflared access tcp` and a
# service token. This script does not touch their DNS: route each one to this tunnel yourself, and
# put it behind a Cloudflare Access application whose only policy is Service Auth. Without Access
# the model endpoint is on the open internet, so before writing an ingress rule the script probes
# each hostname from outside and refuses unless Access is what answers.
set -euo pipefail

case "${1:-}" in
  -h | --help)
    sed -n '3,/^set -euo pipefail/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

TUNNEL_NAME="${TUNNEL_NAME:-aurora-adminbot}"
MODEL_VLLM_HOST="${MODEL_VLLM_HOST:-}"
MODEL_OLLAMA_HOST="${MODEL_OLLAMA_HOST:-}"
VLLM_PORT="${VLLM_PORT:-8000}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
ADMIN_HOST="${ADMIN_HOST:-admin.safe.eu}"

# Optional second hostname fronting the OpenClaw gateway (Control UI shell + the
# WebSocket control plane). Unset, only the AdminBot service is published.
GW_HOST="${GW_HOST:-}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
ADMINBOT_PORT="${ADMINBOT_PORT:-8765}"   # what jinesis-adminbot.service listens on

# Transport to Cloudflare's edge. cloudflared prefers QUIC (UDP/7844); campus and
# enterprise firewalls often drop or throttle outbound UDP, which shows up as
# connectors flapping with "control stream encountered" and climbing backoff while
# the others hold. TUNNEL_PROTOCOL=http2 falls back to TCP/443.
TUNNEL_PROTOCOL="${TUNNEL_PROTOCOL:-}"
CF_DIR="$HOME/.cloudflared"
BIN_DIR="$HOME/.local/bin"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT="jinesis-cloudflared.service"

say() { printf '\n=== %s ===\n' "$*"; }

# ---------------------------------------------------------------- preflight --
say "preflight"

if [ ! -f "$CF_DIR/cert.pem" ]; then
  cat >&2 <<EOF
No $CF_DIR/cert.pem.

That file is the Cloudflare *account* credential that authorizes creating a
tunnel and editing DNS for safe.eu. Copy it from the laptop where you ran
\`cloudflared tunnel login\`:

    mkdir -p ~/.cloudflared
    # from the laptop:
    scp ~/.cloudflared/cert.pem <cs-user>@<aurora-host>:~/.cloudflared/cert.pem

EOF
  exit 1
fi
chmod 600 "$CF_DIR/cert.pem"

# The tunnel is useless if the thing it fronts is not running.
if curl -fsS -o /dev/null -m 5 "http://127.0.0.1:${ADMINBOT_PORT}/adminbot"; then
  echo "  AdminBot is answering on 127.0.0.1:${ADMINBOT_PORT}"
else
  cat >&2 <<EOF
  WARNING: nothing answered http://127.0.0.1:${ADMINBOT_PORT}/adminbot

  Check the service before cutting DNS over, or the public hostname will 502:
      systemctl --user status jinesis-adminbot.service
  If it listens on a different port, re-run with ADMINBOT_PORT=<port>.
EOF
fi

# -------------------------------------------------------------- cloudflared --
say "cloudflared"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$PATH"

if [ -x "$BIN_DIR/cloudflared" ]; then
  echo "  already installed: $("$BIN_DIR/cloudflared" --version 2>&1 | head -1)"
else
  # GitHub's release CDN intermittently 503s; the Cloudflare package mirror is
  # the reliable source. Extract the .deb in place — no dpkg, no sudo.
  VER="${CLOUDFLARED_VERSION:-2026.7.3}"
  DEB="cloudflared_${VER}_amd64.deb"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "  downloading cloudflared ${VER}"
  curl -fsSL --retry 3 -o "$TMP/$DEB" \
    "https://pkg.cloudflare.com/cloudflared/pool/main/c/cloudflared/${DEB}"
  dpkg-deb -x "$TMP/$DEB" "$TMP/x"
  install -m 0755 "$(find "$TMP/x" -type f -name cloudflared | head -1)" "$BIN_DIR/cloudflared"
  echo "  installed: $("$BIN_DIR/cloudflared" --version 2>&1 | head -1)"
fi

# ------------------------------------------------------------------- tunnel --
say "tunnel"

# Parse the JSON rather than pattern-matching it: `cloudflared tunnel list --output json`
# pretty-prints ("name": "x"), so a compact-JSON grep silently misses and we would try
# to create a tunnel that already exists.
resolve_uuid() {
  cloudflared tunnel list --output json | python3 -c '
import json, sys
name = sys.argv[1]
for t in json.load(sys.stdin):
    if t.get("name") == name:
        print(t["id"])
        break
' "$1"
}

UUID="$(resolve_uuid "$TUNNEL_NAME")"
if [ -n "$UUID" ]; then
  echo "  tunnel '${TUNNEL_NAME}' already exists — reusing it"
else
  cloudflared tunnel create "$TUNNEL_NAME"
  UUID="$(resolve_uuid "$TUNNEL_NAME")"
fi
[ -n "$UUID" ] || { echo "could not resolve UUID for '${TUNNEL_NAME}'" >&2; exit 1; }
echo "  UUID: $UUID"

CREDS="$CF_DIR/${UUID}.json"
[ -f "$CREDS" ] || { echo "credentials file missing: $CREDS" >&2; exit 1; }
chmod 600 "$CREDS"

# ---------------------------------------------------------- model hostnames --
# Access is enforced at Cloudflare's edge, before the tunnel. A routed hostname with no ingress rule
# yet therefore shows which side answers: Access (a redirect to cloudflareaccess.com, 401 or 403) or
# this origin's catch-all 404, which means nothing guards it.
access_guards() {
  local host="$1" out code location
  out="$(curl -sS -o /dev/null -m 15 -w '%{http_code} %{redirect_url}' "https://${host}/" 2>/dev/null)" || {
    printf '  %s did not resolve or answer; route it to this tunnel first\n' "$host" >&2
    return 1
  }
  code="${out%% *}"
  location="${out#* }"
  case "$code" in
    401 | 403) return 0 ;;
    301 | 302 | 303 | 307) [[ "$location" == *".cloudflareaccess.com/"* ]] && return 0 ;;
  esac
  printf '  %s answered %s from the origin side, not Access\n' "$host" "$code" >&2
  return 1
}

MODEL_ROUTES=()
for pair in "vllm:${MODEL_VLLM_HOST}:${VLLM_PORT}" "ollama:${MODEL_OLLAMA_HOST}:${OLLAMA_PORT}"; do
  IFS=: read -r model host port <<<"$pair"
  [ -n "$host" ] || continue
  say "model hostname ${host} (${model})"
  if ! access_guards "$host"; then
    cat >&2 <<EOF

  Refusing to publish ${model} at ${host}: Cloudflare Access does not guard it.
  In Zero Trust -> Access -> Applications, add a self-hosted application for
  ${host} whose only policy is "Service Auth" with the AWS host's service token,
  make sure ${host} is routed to tunnel ${TUNNEL_NAME}, then re-run.
  Nothing was written to the ingress config.
EOF
    exit 1
  fi
  echo "  Access guards ${host}"
  MODEL_ROUTES+=("${host} ${port}")
done

# ------------------------------------------------------------------- config --
say "ingress config"
{
  echo "# Managed by aurora-tunnel-setup.sh — edits are overwritten."
  echo "tunnel: ${UUID}"
  echo "credentials-file: ${CREDS}"
  echo
  echo "# No inbound ports are opened on Aurora. cloudflared dials out to Cloudflare."
  echo "ingress:"
  echo "  # Member-facing AdminBot API, /adminbot and /deadlines."
  echo "  - hostname: ${ADMIN_HOST}"
  echo "    service: http://127.0.0.1:${ADMINBOT_PORT}"
  if [ -n "$GW_HOST" ]; then
    echo
    echo "  # OpenClaw gateway: Control UI shell + WebSocket control plane."
    echo "  # cloudflared upgrades ws:// over this http origin automatically."
    echo "  - hostname: ${GW_HOST}"
    echo "    service: http://127.0.0.1:${GATEWAY_PORT}"
    echo "    originRequest:"
    echo "      # The gateway holds long-lived WebSocket sessions."
    echo "      connectTimeout: 30s"
  fi
  for route in ${MODEL_ROUTES[@]+"${MODEL_ROUTES[@]}"}; do
    echo
    echo "  # Private model endpoint for the AWS standby. Cloudflare Access (Service Auth"
    echo "  # only) was verified to guard this hostname before this rule was written."
    echo "  - hostname: ${route% *}"
    echo "    service: tcp://127.0.0.1:${route#* }"
  done
  echo
  echo "  # Mandatory catch-all: anything not named above is refused at the edge rather"
  echo "  # than reaching whatever else listens on this host."
  echo "  - service: http_status:404"
} > "$CF_DIR/config.yml"
chmod 600 "$CF_DIR/config.yml"
echo "  wrote $CF_DIR/config.yml"
if [ -n "$GW_HOST" ]; then
  echo "    ${ADMIN_HOST} -> 127.0.0.1:${ADMINBOT_PORT}"
  echo "    ${GW_HOST} -> 127.0.0.1:${GATEWAY_PORT}"
  # A gateway hostname that resolves to a dead port is worse than none, because
  # ADMINBOT_GATEWAY_WS_URL hands it to every signed-in member's browser.
  if curl -fsS -o /dev/null -m 5 "http://127.0.0.1:${GATEWAY_PORT}/"; then
    echo "    gateway is answering on 127.0.0.1:${GATEWAY_PORT}"
  else
    echo "    WARNING: nothing answered http://127.0.0.1:${GATEWAY_PORT}/ —" >&2
    echo "             check: systemctl --user status jinesis-openclaw-gateway.service" >&2
  fi
else
  echo "    ${ADMIN_HOST} -> 127.0.0.1:${ADMINBOT_PORT}  (gateway not published; set GW_HOST to add it)"
fi
cloudflared tunnel ingress validate

# ------------------------------------------------------------------ systemd --
say "systemd user unit"
mkdir -p "$UNIT_DIR"

PROTO_ARG=""
if [ -n "$TUNNEL_PROTOCOL" ]; then
  PROTO_ARG=" --protocol ${TUNNEL_PROTOCOL}"
  echo "  forcing transport: ${TUNNEL_PROTOCOL}"
fi

cat > "$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Cloudflare tunnel fronting AdminBot at ${ADMIN_HOST}
After=network-online.target jinesis-adminbot.service
Wants=network-online.target jinesis-adminbot.service

[Service]
Type=notify
ExecStart=${BIN_DIR}/cloudflared --no-autoupdate --config ${CF_DIR}/config.yml${PROTO_ARG} tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
echo "  wrote $UNIT_DIR/$UNIT"

systemctl --user daemon-reload
systemctl --user enable "$UNIT"
# `enable --now` only starts a stopped unit; it will not restart a running one, so a
# rewritten unit file or config.yml would sit on disk while the old process kept
# running the old command line. Restart unconditionally.
systemctl --user restart "$UNIT"
sleep 3
systemctl --user --no-pager status "$UNIT" | head -12
echo
echo "  running command line:"
tr '\0' ' ' < "/proc/$(systemctl --user show "$UNIT" -p MainPID --value)/cmdline" 2>/dev/null | sed 's/^/    /'
echo

# ---------------------------------------------------------------- lingering --
say "lingering"
linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
if [ "$linger" != "yes" ]; then
  printf '  WARNING: lingering is off — the tunnel dies when you log out.\n'
  printf '  Ask CSLab to run:  loginctl enable-linger %s\n' "$USER"
else
  echo "  lingering enabled — the tunnel survives logout and reboot"
fi

# --------------------------------------------------------------------- DNS --
say "DNS"
if [ "${OVERWRITE_DNS:-0}" = "1" ]; then
  for h in "$ADMIN_HOST" ${GW_HOST:+"$GW_HOST"}; do
    echo "  OVERWRITE_DNS=1 — routing ${h} at this tunnel"
    cloudflared tunnel route dns --overwrite-dns "$TUNNEL_NAME" "$h"
    echo "  done; ${h} now resolves to ${UUID}.cfargotunnel.com"
  done
else
  cat <<EOF
  Not touching DNS (OVERWRITE_DNS is unset).

  ${ADMIN_HOST} currently points at the EC2/Caddy origin. When you are ready
  to cut over — with jinesis-adminbot.service confirmed healthy — run:

      OVERWRITE_DNS=1 $0

  That replaces the A record with a CNAME to ${UUID}.cfargotunnel.com.
  To roll back, recreate the A record: ${ADMIN_HOST} -> 3.221.59.247 (proxied).
EOF
fi

say "next"
cat <<EOF
  1. Add these to ~/.config/jinesis-adminbot/adminbot.env, then restart:
         ADMINBOT_TRUST_PROXY=1
         ADMINBOT_ALLOWED_ORIGINS=https://${ADMIN_HOST}
         ADMINBOT_PUBLIC_URL=https://${ADMIN_HOST}
         ADMINBOT_DASHBOARD_URL=https://${ADMIN_HOST}
     systemctl --user restart jinesis-adminbot.service

  2. Put a Cloudflare Access policy on ${ADMIN_HOST} before announcing it.

  3. Logs:  journalctl --user -u ${UNIT} -f
EOF
