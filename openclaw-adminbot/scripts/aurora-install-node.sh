#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
# The deploy target names a specific machine, so it comes from the environment rather than from
# the tracked script. --host still overrides it for a one-off.
HOST="${AURORA_HOST:-}"
CS_USER="${CS_USER:-}"
SSH_CONNECT_TIMEOUT="10"

usage() {
  cat <<'EOF'
Usage: scripts/aurora-install-node.sh --user <cs-user> [--host <hostname>]

Upload and run the verified, no-root Node.js 22 installer on Aurora.
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
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ -n "$CS_USER" ]] || die "set CS_USER or pass --user <cs-user>"
[[ -n "$HOST" ]] || die "set AURORA_HOST or pass --host <hostname> — the deploy target is not named in the repo"
command -v ssh >/dev/null || die "ssh is required"

installer="$REPO_ROOT/deploy/aurora/install-node-user.sh"
[[ -f "$installer" ]] || die "installer is missing: $installer"

ssh -o "ConnectTimeout=$SSH_CONNECT_TIMEOUT" \
  "${CS_USER}@${HOST}" bash -s <"$installer"

ssh -o "ConnectTimeout=$SSH_CONNECT_TIMEOUT" \
  "${CS_USER}@${HOST}" \
  'PATH="$HOME/.local/bin:$PATH" node --version && PATH="$HOME/.local/bin:$PATH" corepack --version'
