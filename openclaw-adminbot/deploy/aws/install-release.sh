#!/usr/bin/env bash
# Installs a release built by build-release.sh on the AWS host as a *standby*: every unit is written,
# nothing that writes or sends is started. Run as the AdminBot service account.
#
# Standby means not running, not "running quietly". Aurora is the live writer, and a second live
# backend here would run the hourly email job again (duplicate mail), take a share of Slack's
# socket-mode events, and grow a second copy of the database that diverges from Aurora's. So this
# refuses to proceed while any writer unit is active, and it checks that before it changes anything
# rather than failing halfway with `current` already moved. The only things it starts are the two
# model tunnels, which relay to Aurora and write nothing.
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

ROOT_DIR="/srv/adminbot"
TARBALL=""
KEEP_RELEASES="3"

usage() {
  cat <<'EOF'
Usage: deploy/aws/install-release.sh --tarball <adminbot-<commit>.tar.gz> [options]

Options:
  --root <dir>          Deployment root (default: /srv/adminbot)
  --keep-releases <n>   Releases to keep, including the new one (default: 3)

Verifies the tarball against the .sha256 beside it, unpacks it under
<root>/releases, points <root>/current at it, writes every AdminBot unit without
starting it, and (re)starts only the model tunnels to Aurora.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --tarball)
      (($# >= 2)) || die "--tarball requires a value"
      TARBALL="$2"
      shift 2
      ;;
    --root)
      (($# >= 2)) || die "--root requires a value"
      ROOT_DIR="${2%/}"
      shift 2
      ;;
    --keep-releases)
      (($# >= 2)) || die "--keep-releases requires a value"
      KEEP_RELEASES="$2"
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

((EUID != 0)) || die "run as the AdminBot service account, not root"
[[ -n "$TARBALL" ]] || die "--tarball is required"
[[ "$ROOT_DIR" == /* && "$ROOT_DIR" != *".."* ]] || die "--root must be an absolute path without '..'"
[[ -d "$ROOT_DIR/releases" && -d "$ROOT_DIR/state" ]] ||
  die "$ROOT_DIR is not bootstrapped; run deploy/aws/bootstrap-host.sh as root first"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 1 ]] ||
  die "--keep-releases must be a positive integer"

tarball_name="$(basename -- "$TARBALL")"
[[ "$tarball_name" =~ ^adminbot-([0-9a-f]{12})\.tar\.gz$ ]] ||
  die "expected adminbot-<12-hex commit>.tar.gz, got $tarball_name"
sha="${BASH_REMATCH[1]}"

# The unit list install-user-services.sh guards, checked here first so a refusal leaves `current`,
# the release directory and the units exactly as they were.
WRITER_UNITS=(
  jinesis-adminbot.service
  jinesis-openclaw-gateway.service
  jinesis-adminbot-email.service
  jinesis-adminbot-email.timer
  jinesis-adminbot-sheet-poller.service
  jinesis-adminbot-sheet-poller.timer
)
systemctl --user show-environment >/dev/null || die "user systemd is unavailable; was lingering enabled?"
for unit in "${WRITER_UNITS[@]}"; do
  state="$(systemctl --user show "$unit" -p ActiveState --value)" || die "cannot inspect $unit"
  [[ "$state" == inactive || "$state" == failed ]] ||
    die "$unit is $state: this host is not a standby. Stop its writers before installing a release"
done

(cd "$(dirname -- "$TARBALL")" && sha256sum --check --status "$tarball_name.sha256") ||
  die "checksum mismatch or missing $tarball_name.sha256; refusing to install"

release="$ROOT_DIR/releases/$sha"
if [[ ! -d "$release" ]]; then
  staging="$(mktemp -d "$ROOT_DIR/releases/.incoming-XXXXXX")"
  trap 'rm -rf -- "$staging"' EXIT
  tar -xzf "$TARBALL" -C "$staging" --no-same-owner
  [[ "$(ls -A "$staging")" == "$sha" ]] || die "tarball must contain exactly one top-level directory named $sha"
  mv -T -- "$staging/$sha" "$release"
fi
[[ -f "$release/RELEASE" && -f "$release/start-adminbot.mjs" ]] || die "$release is not a built release"

built_node="$(sed -n 's/^node=v\([0-9]*\)\..*/\1/p' "$release/RELEASE")"
command -v node >/dev/null ||
  die "Node is missing; run $release/deploy/aurora/install-node-user.sh as this account"
[[ "$(node -p 'process.versions.node.split(".")[0]')" == "$built_node" ]] ||
  die "release was built with Node $built_node but this host has $(node --version); native modules would not load"

# The databases live outside the release and are reached through its `state` link, as on Aurora.
if [[ -e "$release/state" && ! -L "$release/state" ]]; then
  die "$release/state exists and is not a link; a release must not carry its own database"
fi
ln -sfn -- "$ROOT_DIR/state" "$release/state"
ln -sfn -- "releases/$sha" "$ROOT_DIR/current.next"
mv -T -- "$ROOT_DIR/current.next" "$ROOT_DIR/current"

"$release/deploy/aurora/install-user-services.sh" --root "$ROOT_DIR/current" --state "$ROOT_DIR/state" --no-start

# The two relays to Aurora. They run from the resolved release, like every other unit, and read the
# tailnet target from the same env file; the tunnel itself refuses a non-tailnet target.
env_file="$HOME/.config/jinesis-adminbot/adminbot.env"
unit_dir="$HOME/.config/systemd/user"
for model in vllm:8000 ollama:11434; do
  name="${model%%:*}"
  port="${model##*:}"
  cat >"$unit_dir/jinesis-model-tunnel-$name.service" <<EOF
[Unit]
Description=AdminBot $name tunnel to Aurora (127.0.0.1:$port)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$env_file
Environment=ADMINBOT_TUNNEL_LISTEN_HOST=127.0.0.1
Environment=ADMINBOT_TUNNEL_LISTEN_PORT=$port
Environment=ADMINBOT_TUNNEL_TARGET_PORT=$port
ExecStart=$(command -v node) $release/scripts/adminbot-model-tunnel.mjs
Restart=always
RestartSec=5
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=default.target
EOF
done
systemctl --user daemon-reload
if grep -q '^ADMINBOT_TUNNEL_TARGET=.' "$env_file" 2>/dev/null; then
  systemctl --user enable jinesis-model-tunnel-vllm.service jinesis-model-tunnel-ollama.service
  systemctl --user restart jinesis-model-tunnel-vllm.service jinesis-model-tunnel-ollama.service
else
  printf 'note: ADMINBOT_TUNNEL_TARGET is not set yet; run deploy/aws/render-env.sh, then the tunnels start\n' >&2
fi

# Prune the oldest releases, never the one `current` names.
mapfile -t releases < <(ls -1t "$ROOT_DIR/releases" | grep -E '^[0-9a-f]{12}$' || true)
for old in "${releases[@]:$KEEP_RELEASES}"; do
  [[ "$old" == "$sha" ]] || rm -rf -- "${ROOT_DIR:?}/releases/$old"
done

printf 'installed %s as standby\n' "$sha"
"$release/deploy/aws/status.sh" --root "$ROOT_DIR" || true
