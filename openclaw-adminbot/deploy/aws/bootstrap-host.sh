#!/usr/bin/env bash
# One-time root setup for the AWS AdminBot standby. Idempotent; run it through Session Manager.
#
# The instance also runs the lab's Overleaf stack, so AdminBot gets its own unprivileged account
# and nothing more. In particular that account must never be in the `docker` group: membership is
# root-equivalent, and would hand AdminBot (and anything that compromises it) Overleaf's containers
# and data. Everything after this script runs as that account.
set -euo pipefail

SERVICE_USER="adminbot"
ROOT_DIR="/srv/adminbot"

usage() {
  cat <<'EOF'
Usage: sudo deploy/aws/bootstrap-host.sh [--user <name>] [--root <dir>]

Creates the unprivileged AdminBot account (default: adminbot), its deployment
root (default: /srv/adminbot) and enables systemd lingering so its user services
survive logout, and installs cloudflared from Cloudflare's signed apt
repository for the model links to Aurora. Refuses to continue if the account
is in the docker group.
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
      SERVICE_USER="$2"
      shift 2
      ;;
    --root)
      (($# >= 2)) || die "--root requires a value"
      ROOT_DIR="${2%/}"
      shift 2
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

[[ "$ROOT_DIR" == /* && "$ROOT_DIR" != *".."* ]] || die "--root must be an absolute path without '..'"
[[ "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "invalid user name: $SERVICE_USER"
((EUID == 0)) || die "run as root (sudo)"

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash --user-group "$SERVICE_USER"
  passwd --lock "$SERVICE_USER" >/dev/null
  printf 'created user %s\n' "$SERVICE_USER"
fi
if id -nG "$SERVICE_USER" | tr ' ' '\n' | grep -qx docker; then
  die "$SERVICE_USER is in the docker group; remove it (gpasswd -d $SERVICE_USER docker) before continuing"
fi

install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" \
  "$ROOT_DIR" "$ROOT_DIR/releases" "$ROOT_DIR/incoming"
# The databases: owner-only, like every other AdminBot state directory.
install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ROOT_DIR/state"

# User services stop at logout without lingering, and nobody stays logged in to a server.
loginctl enable-linger "$SERVICE_USER"

for tool in python3 curl tar sha256sum; do
  command -v "$tool" >/dev/null || die "$tool is missing; install it with apt before continuing"
done
command -v aws >/dev/null ||
  printf 'note: the AWS CLI is missing; render-env.sh needs it (snap install aws-cli --classic)\n' >&2
# cloudflared carries the model links to Aurora (`access tcp` clients). Installed from Cloudflare's
# signed apt repository, so apt verifies it. The package enables no service: nothing here starts
# serving a tunnel, and status.sh fails if one does.
if ! command -v cloudflared >/dev/null; then
  keyring=/usr/share/keyrings/cloudflare-main.gpg
  [[ -f "$keyring" ]] || curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o "$keyring"
  echo "deb [signed-by=$keyring] https://pkg.cloudflare.com/cloudflared any main" \
    >/etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq
  apt-get install -y -qq cloudflared
fi
printf 'cloudflared: %s\n' "$(cloudflared --version 2>&1 | head -1)"

printf 'ready: user=%s root=%s\n' "$SERVICE_USER" "$ROOT_DIR"
