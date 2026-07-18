#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

HOST="aurora.ais.sandbox"
CS_USER="${CS_USER:-}"
REF="HEAD"
GATEWAY_PORT="18789"
ADMINBOT_PORT="8765"
SSH_CONNECT_TIMEOUT="10"

usage() {
  cat <<'EOF'
Usage:
  scripts/aurora-adminbot-host.sh --user <cs-user> [options] <command> [argument]

Options:
  --user <cs-user>       CS Unix account (required; may also set CS_USER)
  --host <hostname>      Default: aurora.ais.sandbox
  --ref <git-ref>        Committed revision to deploy (default: HEAD)
  --gateway-port <port>  Local and remote Gateway port (default: 18789)
  --adminbot-port <port> Local and remote AdminBot port (default: 8765)

Commands:
  check                  Verify VPN/DNS/SSH and Aurora prerequisites
  connect                Open SSH with Gateway/AdminBot local port forwards
  deploy                 Upload, build, and install a versioned release
  upload-env <file>      Install a secrets env file with mode 0600
  upload-config <file>   Install openclaw.json with mode 0600
  auth-gog               Run gog's remote/manual OAuth flow on Aurora
  install-services       Regenerate user-systemd units without starting them
  start                  Validate configuration and start all services/timer
  stop                   Stop all services/timer
  restart                Restart AdminBot and Gateway
  status                 Show service/timer status
  logs [unit]            Follow logs (adminbot, gateway, or email)

Aurora requires the CS VPN or the on-campus network.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --user)
      (($# >= 2)) || die "--user requires a value"
      CS_USER="$2"
      shift 2
      ;;
    --host)
      (($# >= 2)) || die "--host requires a value"
      HOST="$2"
      shift 2
      ;;
    --ref)
      (($# >= 2)) || die "--ref requires a value"
      REF="$2"
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
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

(($# >= 1)) || {
  usage
  exit 2
}

COMMAND="$1"
shift
[[ -n "$CS_USER" ]] || die "set CS_USER or pass --user <cs-user>"
[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || die "gateway port must be numeric"
[[ "$ADMINBOT_PORT" =~ ^[0-9]+$ ]] || die "AdminBot port must be numeric"

TARGET="${CS_USER}@${HOST}"
REMOTE_BASE="/h/405/${CS_USER}/services/openclaw-adminbot"
REMOTE_CURRENT="${REMOTE_BASE}/current"
REMOTE_ENV="/h/405/${CS_USER}/.config/jinesis-adminbot/adminbot.env"
REMOTE_CONFIG="/h/405/${CS_USER}/.openclaw/openclaw.json"
SSH=(ssh -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET")
SCP=(scp -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}")

check_local_tools() {
  command -v git >/dev/null || die "git is required locally"
  command -v ssh >/dev/null || die "ssh is required locally"
  command -v scp >/dev/null || die "scp is required locally"
}

remote_install_script() {
  printf '%s/deploy/aurora/install-user-services.sh' "$REMOTE_CURRENT"
}

case "$COMMAND" in
  check)
    check_local_tools
    "${SSH[@]}" bash -s -- "$CS_USER" <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
expected_user="$1"
printf 'host=%s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'user=%s\n' "$USER"
[[ "$USER" == "$expected_user" ]] || {
  printf 'warning: expected user %s but SSH reports %s\n' "$expected_user" "$USER" >&2
}
printf 'home=%s\n' "$HOME"
[[ -d "/mfs1/u/$USER" ]] && printf 'mfs1=yes\n' || printf 'mfs1=no\n'
command -v node >/dev/null && printf 'node=%s\n' "$(node --version)" || printf 'node=missing\n'
command -v systemctl >/dev/null && printf 'systemd=yes\n' || printf 'systemd=no\n'
loginctl show-user "$USER" -p Linger 2>/dev/null || printf 'Linger=unknown\n'
REMOTE
    ;;

  connect)
    check_local_tools
    exec ssh \
      -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" \
      -L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}" \
      -L "${ADMINBOT_PORT}:127.0.0.1:${ADMINBOT_PORT}" \
      "$TARGET"
    ;;

  deploy)
    check_local_tools
    git -C "$REPO_ROOT" rev-parse --verify "${REF}^{commit}" >/dev/null ||
      die "not a committed Git revision: $REF"
    sha="$(git -C "$REPO_ROOT" rev-parse --short=12 "${REF}^{commit}")"
    release_id="${sha}-$(date -u +%Y%m%dT%H%M%SZ)"
    remote_release="${REMOTE_BASE}/releases/${release_id}"
    archive="$(mktemp "${TMPDIR:-/tmp}/jinesis-adminbot.XXXXXX.tar")"
    trap 'rm -f -- "$archive"' EXIT

    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
      printf 'note: the worktree is dirty; deploy uses committed ref %s only\n' "$REF" >&2
    fi
    git -C "$REPO_ROOT" archive --format=tar --output="$archive" "$REF"
    "${SSH[@]}" mkdir -p "$remote_release"
    "${SCP[@]}" "$archive" "${TARGET}:${remote_release}/source.tar"

    "${SSH[@]}" bash -s -- "$remote_release" "$REMOTE_CURRENT" "$GATEWAY_PORT" "$ADMINBOT_PORT" <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
release="$1"
current="$2"
gateway_port="$3"
adminbot_port="$4"
cd "$release"
tar -xf source.tar
rm -f source.tar

command -v node >/dev/null || {
  echo "Node.js is missing. Install Node 22.19+ in your CS account or load a CSLab /w/pkgs toolchain." >&2
  exit 1
}
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) process.exit(1);
' || {
  echo "Node.js 22.19+ is required; found $(node --version)." >&2
  exit 1
}

if command -v corepack >/dev/null; then
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
elif command -v pnpm >/dev/null; then
  pnpm install --frozen-lockfile
  pnpm build
else
  echo "pnpm/corepack is missing. Enable corepack or install pnpm in your CS account." >&2
  exit 1
fi

mkdir -p "$HOME/.openclaw/state"
if [[ -e "$release/state" && ! -L "$release/state" ]]; then
  rmdir "$release/state" 2>/dev/null || {
    echo "Refusing to replace non-empty release state directory: $release/state" >&2
    exit 1
  }
fi
ln -sfn "$HOME/.openclaw/state" "$release/state"
ln -sfn "$release" "$current"
"$current/deploy/aurora/install-user-services.sh" \
  --root "$current" \
  --gateway-port "$gateway_port" \
  --adminbot-port "$adminbot_port" \
  --no-start
printf 'deployed_release=%s\n' "$release"
REMOTE
    printf 'Deployment installed but not started.\n'
    printf 'Next: upload-env, upload-config, auth-gog, then start.\n'
    ;;

  upload-env)
    (($# == 1)) || die "upload-env requires exactly one file"
    [[ -f "$1" ]] || die "env file not found: $1"
    remote_tmp="${REMOTE_ENV}.upload.$$"
    "${SCP[@]}" "$1" "${TARGET}:${remote_tmp}"
    "${SSH[@]}" install -D -m 600 "$remote_tmp" "$REMOTE_ENV"
    "${SSH[@]}" rm -f "$remote_tmp"
    printf 'installed=%s\n' "$REMOTE_ENV"
    ;;

  upload-config)
    (($# == 1)) || die "upload-config requires exactly one file"
    [[ -f "$1" ]] || die "config file not found: $1"
    remote_tmp="${REMOTE_CONFIG}.upload.$$"
    "${SCP[@]}" "$1" "${TARGET}:${remote_tmp}"
    "${SSH[@]}" install -D -m 600 "$remote_tmp" "$REMOTE_CONFIG"
    "${SSH[@]}" rm -f "$remote_tmp"
    printf 'installed=%s\n' "$REMOTE_CONFIG"
    ;;

  auth-gog)
    (($# == 0)) || die "auth-gog takes no arguments"
    ssh -t -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET" \
      "set -euo pipefail; set -a; . $REMOTE_ENV; set +a; /h/405/${CS_USER}/.local/bin/gog auth add jinesis.adminbot@gmail.com --remote --force-consent --services gmail,calendar,drive,docs,sheets,contacts"
    ;;

  install-services)
    (($# == 0)) || die "install-services takes no arguments"
    "${SSH[@]}" "$(remote_install_script)" \
      --root "$REMOTE_CURRENT" \
      --gateway-port "$GATEWAY_PORT" \
      --adminbot-port "$ADMINBOT_PORT" \
      --no-start
    ;;

  start)
    (($# == 0)) || die "start takes no arguments"
    "${SSH[@]}" "$(remote_install_script)" \
      --root "$REMOTE_CURRENT" \
      --gateway-port "$GATEWAY_PORT" \
      --adminbot-port "$ADMINBOT_PORT" \
      --start
    ;;

  stop)
    (($# == 0)) || die "stop takes no arguments"
    "${SSH[@]}" systemctl --user stop \
      jinesis-adminbot-email.timer \
      jinesis-openclaw-gateway.service \
      jinesis-adminbot.service
    ;;

  restart)
    (($# == 0)) || die "restart takes no arguments"
    "${SSH[@]}" systemctl --user restart \
      jinesis-adminbot.service \
      jinesis-openclaw-gateway.service
    ;;

  status)
    (($# == 0)) || die "status takes no arguments"
    "${SSH[@]}" systemctl --user --no-pager --full status \
      jinesis-adminbot.service \
      jinesis-openclaw-gateway.service \
      jinesis-adminbot-email.timer
    ;;

  logs)
    unit="${1:-adminbot}"
    (($# <= 1)) || die "logs accepts at most one unit"
    case "$unit" in
      adminbot) systemd_unit="jinesis-adminbot.service" ;;
      gateway) systemd_unit="jinesis-openclaw-gateway.service" ;;
      email) systemd_unit="jinesis-adminbot-email.service" ;;
      *) die "logs unit must be adminbot, gateway, or email" ;;
    esac
    exec ssh -t "$TARGET" journalctl --user -u "$systemd_unit" -f
    ;;

  *)
    die "unknown command: $COMMAND"
    ;;
esac
