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
# How many past releases `deploy` keeps around: one to reuse node_modules from (see below) and a
# couple more as real rollback targets. Older releases are pruned at the start of every deploy.
KEEP_RELEASES="3"
SSH_CONNECT_TIMEOUT="10"
# Set once in your own shell (never in this file or any committed config) to run the whole
# flow non-interactively, e.g.: read -rs AURORA_SSH_PASSWORD; export AURORA_SSH_PASSWORD
SSH_PASSWORD="${AURORA_SSH_PASSWORD:-}"

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
  --keep-releases <n>    Past releases to retain for deploy (default: 3)

Non-interactive auth:
  Set AURORA_SSH_PASSWORD in your shell (never commit it) to skip every SSH
  password prompt via sshpass, e.g.:
    read -rs AURORA_SSH_PASSWORD; export AURORA_SSH_PASSWORD
  Requires the `sshpass` binary. Unset (the default) keeps today's behavior
  of prompting interactively for each SSH/SCP call.

Commands:
  check                  Verify VPN/DNS/SSH and Aurora prerequisites
  connect                Open SSH with Gateway/AdminBot local port forwards
  deploy                 Prune old releases, upload the new one, reuse node_modules from the
                          newest surviving release if one exists, then build/install
  upload-env <file>      Install a secrets env file with mode 0600
  sync-slack-env <file>  Merge only Slack tokens into the remote env and restart Gateway
  sync-cron-jobs [db]    Sync local OpenClaw cron jobs into Aurora via Gateway RPC
  sync-adminbot-data [db] Safely replace Aurora's AdminBot database and restart services
  upload-config <file>   Install openclaw.json with mode 0600
  auth-gog               Run gog's remote/manual OAuth flow on Aurora
  install-services       Regenerate user-systemd units without starting them
  start                  Validate configuration and start all services/timer
  stop                   Stop all services/timer
  restart                Restart AdminBot and Gateway
  status                 Show service/timer status
  logs [unit]            Follow logs (adminbot, gateway, email, or sheet-poller)

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
    --keep-releases)
      (($# >= 2)) || die "--keep-releases requires a value"
      KEEP_RELEASES="$2"
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
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 1 ]] || die "--keep-releases must be a positive integer"

TARGET="${CS_USER}@${HOST}"
REMOTE_BASE="/h/405/${CS_USER}/services/openclaw-adminbot"
REMOTE_CURRENT="${REMOTE_BASE}/current"
REMOTE_ENV="/h/405/${CS_USER}/.config/jinesis-adminbot/adminbot.env"
REMOTE_CONFIG="/h/405/${CS_USER}/.openclaw/openclaw.json"
# SSHPASS_PREFIX stays empty (today's interactive-prompt behavior) unless AURORA_SSH_PASSWORD
# is set; every ssh/scp invocation below is prefixed with it so one password entry covers the
# whole flow.
SSHPASS_PREFIX=()
if [[ -n "$SSH_PASSWORD" ]]; then
  command -v sshpass >/dev/null || die "sshpass is required when AURORA_SSH_PASSWORD is set"
  export SSHPASS="$SSH_PASSWORD"
  SSHPASS_PREFIX=(sshpass -e)
fi
SSH=("${SSHPASS_PREFIX[@]}" ssh -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET")
SCP=("${SSHPASS_PREFIX[@]}" scp -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}")

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
    exec "${SSHPASS_PREFIX[@]}" ssh \
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
    # Stop services, unlink `current`, and prune to the newest KEEP_RELEASES release
    # directories -- NOT a full wipe. Whatever `current` pointed to (the release actually
    # running before this deploy) is resolved first and printed as the only line on stdout,
    # captured below, so the build step can hardlink-copy its node_modules instead of every
    # deploy installing all workspace packages from nothing. Every other command in this
    # block is redirected to stderr so that marker line is the only thing on stdout.
    prior_release="$("${SSH[@]}" bash -s -- "$REMOTE_BASE" "$REMOTE_CURRENT" "$KEEP_RELEASES" <<'REMOTE_CLEAN'
set -euo pipefail
base="$1"
current="$2"
keep="$3"
expected="/h/405/$USER/services/openclaw-adminbot"
[[ "$base" == "$expected" ]] || {
  printf 'Refusing cleanup outside expected deployment root: %s\n' "$base" >&2
  exit 1
}
{
  systemctl --user stop \
    jinesis-adminbot-sheet-poller.timer \
    jinesis-adminbot-sheet-poller.service \
    jinesis-adminbot-email.timer \
    jinesis-adminbot-email.service \
    jinesis-openclaw-gateway.service \
    jinesis-adminbot.service 2>/dev/null || true
} >&2
prior=""
if [[ -L "$current" ]]; then
  prior="$(basename -- "$(readlink -f -- "$current")")"
  rm -f -- "$current"
elif [[ -e "$current" ]]; then
  printf 'Refusing to delete non-symlink current path: %s\n' "$current" >&2
  exit 1
fi
releases="$base/releases"
[[ "$releases" == "$expected/releases" ]] || exit 1
mkdir -p "$releases"
{
  cd "$releases"
  # Newest-mtime-first; each release directory is created once by `deploy` and never
  # touched again by anything else, so mtime order matches deploy order.
  ls -1t 2>/dev/null | tail -n "+$((keep + 1))" | while IFS= read -r old; do
    rm -rf -- "$old"
  done
} >&2
printf '%s\n' "$prior"
REMOTE_CLEAN
    )"
    "${SSH[@]}" mkdir -p "$remote_release"
    "${SCP[@]}" "$archive" "${TARGET}:${remote_release}/source.tar"

    "${SSH[@]}" bash -s -- "$remote_release" "$REMOTE_CURRENT" "$GATEWAY_PORT" "$ADMINBOT_PORT" "$prior_release" <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
release="$1"
current="$2"
gateway_port="$3"
adminbot_port="$4"
prior_release="${5:-}"
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

# Reuse node_modules from the release that was actually live before this deploy, if one
# exists, instead of every deploy linking all workspace packages from nothing. Hardlink-copy
# (cp -al), not symlink: this release's node_modules becomes a real, independent directory
# that `pnpm install` can freely add/remove/relink inside, and nothing it does can touch the
# prior release's own copy (which stays untouched for as long as pruning above keeps it
# around). `pnpm install --frozen-lockfile` still runs unconditionally afterward -- when the
# lockfile has not changed it recognizes the tree already satisfies it and does very little;
# when it has, it only reconciles the difference instead of starting from empty.
if [[ -n "$prior_release" ]]; then
  prior_node_modules="$(dirname -- "$release")/$prior_release/node_modules"
  if [[ -d "$prior_node_modules" ]]; then
    echo "Reusing node_modules from prior release: $prior_release"
    if ! cp -al -- "$prior_node_modules" "$release/node_modules" 2>/dev/null; then
      echo "warning: could not hardlink-copy node_modules from $prior_release (different filesystem?); installing from scratch" >&2
      rm -rf -- "$release/node_modules"
    fi
  fi
fi

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

  sync-slack-env)
    (($# == 1)) || die "sync-slack-env requires exactly one env file"
    [[ -f "$1" ]] || die "env file not found: $1"
    check_local_tools
    slack_env="$(mktemp "${TMPDIR:-/tmp}/jinesis-slack-env.XXXXXX")"
    trap 'rm -f -- "$slack_env"' EXIT
    awk '
      /^SLACK_(BOT|APP|USER)_TOKEN=/ {
        key = $0
        sub(/=.*/, "", key)
        if (seen[key]++) {
          printf "duplicate Slack variable: %s\n", key >"/dev/stderr"
          exit 2
        }
        print
      }
    ' "$1" >"$slack_env" || die "could not extract Slack variables from $1"
    chmod 600 "$slack_env"
    grep -q '^SLACK_BOT_TOKEN=.\+' "$slack_env" ||
      die "SLACK_BOT_TOKEN is missing or empty in $1"
    grep -q '^SLACK_APP_TOKEN=.\+' "$slack_env" ||
      die "SLACK_APP_TOKEN is missing or empty in $1 (required for Slack socket mode)"

    remote_tmp="${REMOTE_ENV}.slack-upload.$$"
    "${SCP[@]}" "$slack_env" "${TARGET}:${remote_tmp}"
    "${SSH[@]}" bash -s -- "$remote_tmp" "$REMOTE_ENV" <<'REMOTE_SLACK'
set -euo pipefail
upload="$1"
env_file="$2"
[[ -f "$upload" ]] || {
  printf 'Slack upload is missing: %s\n' "$upload" >&2
  exit 1
}
umask 077
mkdir -p "$(dirname "$env_file")"
touch "$env_file"
merged="${env_file}.merged.$$"
trap 'rm -f -- "$upload" "$merged"' EXIT
grep -vE '^SLACK_(BOT|APP|USER)_TOKEN=' "$env_file" >"$merged" || true
cat "$upload" >>"$merged"
chmod 600 "$merged"
mv -f -- "$merged" "$env_file"
systemctl --user restart jinesis-openclaw-gateway.service
systemctl --user --no-pager --full status jinesis-openclaw-gateway.service
REMOTE_SLACK
    printf 'Slack secrets merged into %s; Gateway restarted.\n' "$REMOTE_ENV"
    ;;

  sync-cron-jobs)
    (($# <= 1)) || die "sync-cron-jobs accepts at most one SQLite database path"
    check_local_tools
    command -v node >/dev/null || die "node is required locally"
    local_database="${1:-$HOME/.openclaw/state/openclaw.sqlite}"
    [[ -f "$local_database" ]] || die "OpenClaw state database not found: $local_database"
    exporter="$REPO_ROOT/scripts/export-openclaw-cron-jobs.mjs"
    importer="$REPO_ROOT/scripts/import-openclaw-cron-jobs.mjs"
    [[ -f "$exporter" && -f "$importer" ]] || die "cron migration helpers are missing"
    cron_bundle="$(mktemp "${TMPDIR:-/tmp}/jinesis-cron-jobs.XXXXXX.json")"
    trap 'rm -f -- "$cron_bundle"' EXIT
    node "$exporter" "$local_database" "$REPO_ROOT" "$REMOTE_CURRENT" >"$cron_bundle"
    chmod 600 "$cron_bundle"

    remote_bundle="${REMOTE_ENV}.cron-upload.$$"
    # Keep the .mjs suffix: node resolves module format from the extension and refuses
    # to run a copy named after the pid alone (ERR_UNKNOWN_FILE_EXTENSION).
    remote_importer="${REMOTE_ENV}.cron-importer.$$.mjs"
    "${SCP[@]}" "$cron_bundle" "${TARGET}:${remote_bundle}"
    "${SCP[@]}" "$importer" "${TARGET}:${remote_importer}"
    "${SSH[@]}" bash -s -- \
      "$remote_bundle" \
      "$remote_importer" \
      "$REMOTE_ENV" \
      "$REMOTE_CURRENT/openclaw.mjs" <<'REMOTE_CRON'
set -euo pipefail
# Aurora's node lives in ~/.local/bin, which a non-interactive ssh shell does not put on
# PATH. Every other remote block here does the same; without it the import dies on
# "node: command not found" after the bundle has already been uploaded.
export PATH=$HOME/.local/bin:$PATH
bundle="$1"
importer="$2"
env_file="$3"
openclaw_cli="$4"
trap 'rm -f -- "$bundle" "$importer"' EXIT
chmod 600 "$bundle" "$importer"
[[ -f "$env_file" ]] || {
  printf 'Aurora environment file is missing: %s\n' "$env_file" >&2
  exit 1
}
[[ -f "$openclaw_cli" ]] || {
  printf 'Aurora OpenClaw CLI is missing: %s\n' "$openclaw_cli" >&2
  exit 1
}
systemctl --user disable --now jinesis-adminbot-email.timer 2>/dev/null || true
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
node "$importer" "$openclaw_cli" "$bundle"
node "$openclaw_cli" cron list --all --json
REMOTE_CRON
    printf 'OpenClaw cron jobs synced; legacy systemd email timer disabled.\n'
    ;;

  sync-adminbot-data)
    (($# <= 1)) || die "sync-adminbot-data accepts at most one SQLite database path"
    check_local_tools
    command -v node >/dev/null || die "node is required locally"
    local_database="${1:-$REPO_ROOT/state/adminbot.sqlite}"
    [[ -f "$local_database" ]] || die "AdminBot database not found: $local_database"
    snapshot_helper="$REPO_ROOT/scripts/snapshot-sqlite.mjs"
    [[ -f "$snapshot_helper" ]] || die "SQLite snapshot helper is missing"
    database_snapshot="$(mktemp "${TMPDIR:-/tmp}/jinesis-adminbot.XXXXXX.sqlite")"
    rm -f -- "$database_snapshot"
    trap 'rm -f -- "$database_snapshot"' EXIT
    node "$snapshot_helper" "$local_database" "$database_snapshot"

    remote_upload="${REMOTE_CONFIG}.adminbot-db-upload.$$"
    remote_database="/h/405/${CS_USER}/.openclaw/state/adminbot.sqlite"
    "${SCP[@]}" "$database_snapshot" "${TARGET}:${remote_upload}"
    "${SSH[@]}" bash -s -- "$remote_upload" "$remote_database" <<'REMOTE_ADMINBOT_DATA'
set -euo pipefail
upload="$1"
database="$2"
database_new="${database}.new"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
adminbot_stopped=0
cleanup() {
  status=$?
  rm -f -- "$upload" "$database_new"
  if ((adminbot_stopped)); then
    systemctl --user start jinesis-adminbot.service >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
[[ -f "$upload" ]] || {
  printf 'AdminBot database upload is missing: %s\n' "$upload" >&2
  exit 1
}
mkdir -p "$(dirname "$database")"
chmod 600 "$upload"
systemctl --user stop jinesis-adminbot.service
adminbot_stopped=1
if [[ -f "$database" ]]; then
  cp -p -- "$database" "${database}.backup-${timestamp}"
fi
rm -f -- "${database}-wal" "${database}-shm"
install -m 600 "$upload" "$database_new"
mv -f -- "$database_new" "$database"
systemctl --user restart \
  jinesis-adminbot.service \
  jinesis-openclaw-gateway.service
adminbot_stopped=0
systemctl --user --no-pager --full status \
  jinesis-adminbot.service \
  jinesis-openclaw-gateway.service
REMOTE_ADMINBOT_DATA
    printf 'AdminBot database synced; AdminBot and Gateway restarted.\n'
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
    "${SSHPASS_PREFIX[@]}" ssh -t -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET" \
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
      jinesis-adminbot-sheet-poller.timer \
      jinesis-adminbot-sheet-poller.service \
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
      jinesis-openclaw-gateway.service
    ;;

  logs)
    unit="${1:-adminbot}"
    (($# <= 1)) || die "logs accepts at most one unit"
    case "$unit" in
      adminbot) systemd_unit="jinesis-adminbot.service" ;;
      gateway) systemd_unit="jinesis-openclaw-gateway.service" ;;
      email) systemd_unit="jinesis-adminbot-email.service" ;;
      sheet-poller) systemd_unit="jinesis-adminbot-sheet-poller.service" ;;
      *) die "logs unit must be adminbot, gateway, email, or sheet-poller" ;;
    esac
    exec "${SSHPASS_PREFIX[@]}" ssh -t "$TARGET" journalctl --user -u "$systemd_unit" -f
    ;;

  *)
    die "unknown command: $COMMAND"
    ;;
esac
