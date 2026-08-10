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
# Units must run from the resolved release directory, never the "current" symlink. Bundled channels
# with no built dist artifact (slack, whatsapp) can only load from extensions/<id>/index.ts, and the
# loader keeps that source entry only when its absolute path is inside the root it was given --
# compared with a plain path.relative, so a symlinked root drops the candidate and the channel dies
# with "missing generated module". That failure is silent downstream: the channel's secret contract
# never registers, so its SecretRefs stay unresolved.
ROOT="$(readlink -f "$ROOT")"
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

PYTHON_BIN="$(command -v python3 || true)"
[[ -n "$PYTHON_BIN" ]] || die "python3 is missing"

# Aurora accounts have no sudo and no system pip. Bootstrap PyPA's official
# zipapp installer (no root, no preexisting pip needed) and install the
# reimbursement form filler's (scripts/adminbot-reimbursement-from-email.py)
# python-docx/openpyxl dependencies into a user-owned directory on PYTHONPATH
# instead of touching the system interpreter.
REIMBURSEMENT_LIBS="$HOME/.local/share/jinesis-adminbot/python-libs"
REIMBURSEMENT_REQUIREMENTS="$ROOT/scripts/adminbot-reimbursement-requirements.txt"
OPENREVIEW_REQUIREMENTS="$ROOT/scripts/adminbot-openreview-requirements.txt"
# Every module the two python helpers import at runtime. Checked as one list so a
# partially-populated libs directory is repaired rather than skipped, and checked with
# the same PYTHONPATH the systemd units set so the probe cannot pass against a copy in
# system or user site-packages that the service will never see.
PYTHON_RUNTIME_MODULES='import pypdfium2, PIL, docx, openpyxl, openreview'
if ! PYTHONPATH="$REIMBURSEMENT_LIBS" "$PYTHON_BIN" -c "$PYTHON_RUNTIME_MODULES" 2>/dev/null; then
  pip_pyz="$HOME/.local/share/jinesis-adminbot/pip.pyz"
  mkdir -p "$(dirname "$pip_pyz")" "$REIMBURSEMENT_LIBS"
  [[ -f "$pip_pyz" ]] ||
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
      https://bootstrap.pypa.io/pip/pip.pyz --output "$pip_pyz"
  # Installing into a target directory keeps this out of system/user site-packages and
  # off PEP 668's externally-managed rules entirely, so no --break-system-packages.
  "$PYTHON_BIN" "$pip_pyz" install --target "$REIMBURSEMENT_LIBS" \
    -r "$REIMBURSEMENT_REQUIREMENTS" -r "$OPENREVIEW_REQUIREMENTS" ||
    die "failed to install python dependencies from $REIMBURSEMENT_REQUIREMENTS / $OPENREVIEW_REQUIREMENTS"
  # Fail here rather than at the first receipt upload: a release that installs cleanly
  # but cannot import is the failure mode this whole block exists to prevent.
  PYTHONPATH="$REIMBURSEMENT_LIBS" "$PYTHON_BIN" -c "$PYTHON_RUNTIME_MODULES" ||
    die "python dependencies installed into $REIMBURSEMENT_LIBS but $PYTHON_BIN still cannot import them"
fi

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
Environment=PYTHONPATH=$REIMBURSEMENT_LIBS
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
Environment=PYTHONPATH=$REIMBURSEMENT_LIBS
ExecStart=$TSX_BIN $ROOT/scripts/adminbot-email-automation.ts
TimeoutStartSec=30min
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
EOF

systemctl --user disable --now jinesis-adminbot-email.timer 2>/dev/null || true
rm -f -- "$UNIT_DIR/jinesis-adminbot-email.timer"
# The reviewing-cycle pass is an OpenClaw cron job now (see docs/tools/adminbot-openreview.md).
# Remove the systemd timer that used to own it so the pass cannot be scheduled twice.
systemctl --user disable --now jinesis-adminbot-openreview.timer 2>/dev/null || true
rm -f -- "$UNIT_DIR/jinesis-adminbot-openreview.timer" \
  "$UNIT_DIR/jinesis-adminbot-openreview.service"

poller_args=(
  --root "$ROOT"
  --env-file "$ENV_FILE"
  --adminbot-port "$ADMINBOT_PORT"
  --no-start
)
"$ROOT/deploy/aurora/install-member-sheet-poller.sh" "${poller_args[@]}"
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
  "${GOG_BIN:-gog}" gmail labels list --account "${GOG_ACCOUNT:?set GOG_ACCOUNT in adminbot.env}" --json --no-input >/dev/null ||
    die "gog authentication is not ready on Aurora"
  curl --fail --silent --show-error --max-time 10 \
    -H "Authorization: Bearer $VLLM_API_KEY" \
    "${ADMINBOT_LOCAL_BASE_URL%/}/models" >/dev/null ||
    die "AdminBot local model endpoint is not ready on Aurora"

  systemctl --user enable --now \
    jinesis-adminbot.service \
    jinesis-openclaw-gateway.service
  "$ROOT/deploy/aurora/install-member-sheet-poller.sh" \
    --root "$ROOT" \
    --env-file "$ENV_FILE" \
    --adminbot-port "$ADMINBOT_PORT" \
    --start
  # The reviewing-cycle pass is scheduled as an OpenClaw cron job, not a systemd timer,
  # so it shows up in the Control UI with its run history. Warn when its inputs are
  # missing rather than letting the job fail on a schedule.
  if [[ -z "${OPENREVIEW_USERNAME:-}" || -z "${OPENREVIEW_PASSWORD:-}" ]]; then
    printf 'note: OPENREVIEW_USERNAME/PASSWORD unset; the reviewing-cycle cron job will no-op\n'
  elif [[ -z "${ADMINBOT_SERVICE_TOKEN:-}" ]]; then
    printf 'note: ADMINBOT_SERVICE_TOKEN unset; the reviewing-cycle cron job cannot authenticate\n'
  fi
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
