#!/usr/bin/env bash
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

# Default deploy target. AURORA_HOST or --host still override it for a one-off against a
# different machine.
HOST="${AURORA_HOST:-aurora.ais.sandbox}"
CS_USER="${CS_USER:-}"
# Where the deployment lives on Aurora. Empty here and defaulted after --user is parsed, since
# the default names the account.
#
# /mfs1 is the cluster store: 47 TB and ~1e9 inodes free at the time of writing. /h holds the
# quota'd home directories and is routinely at 100%; /w/406 is a *2.1 GB, 80k-inode* work volume,
# which is where this used to point and is not big enough to hold this deployment. A release tree
# carries its own node_modules, `deploy` keeps three of them, the pnpm store is most of a gigabyte
# and the AdminBot database is a quarter of one -- that does not fit in 2.1 GB, and when it stopped
# fitting SQLite began answering every write with "disk I/O error", which the Control UI rendered
# as "that email and password did not match a lab member account". Nobody could sign in and the
# message blamed their password. Hence both the volume below and the preflight check in `deploy`.
#
# What stays in the home directory is what has to: the systemd user units, ~/.local tooling, and
# the two 0600 secret files, which are not going on a shared volume.
DEPLOY_ROOT="${AURORA_DEPLOY_ROOT:-}"
# Refuse to deploy onto a volume that cannot hold a release plus the database. Both are checked
# because /w/406 ran out of each independently.
MIN_DEPLOY_FREE_MB="${AURORA_MIN_DEPLOY_FREE_MB:-4096}"
MIN_DEPLOY_FREE_INODES="${AURORA_MIN_DEPLOY_FREE_INODES:-200000}"
# Where a *new* deployment root gets its databases from, named explicitly. Only consulted when the
# root has no state directory yet; see the seeding block in `deploy`.
SEED_STATE="${AURORA_SEED_STATE:-}"
INIT_EMPTY_STATE="0"
CONFIRM_SOURCE_QUIESCED="0"
REF="HEAD"
GATEWAY_PORT="18789"
ADMINBOT_PORT="8765"
# How many past releases `deploy` keeps around: one to reuse node_modules from (see below) and a
# couple more as real rollback targets. Older releases are pruned at the start of every deploy.
KEEP_RELEASES="3"
ALLOW_BEHIND="${AURORA_ALLOW_BEHIND:-0}"
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
  --host <hostname>      Default: aurora.ais.sandbox (or $AURORA_HOST if set)
  --root <path>          Deployment root on Aurora: releases, current and state
                          (default: /mfs1/u/<cs-user>/jinesis-adminbot, or
                          $AURORA_DEPLOY_ROOT if set)
  --seed-state <dir>     Remote state directory to snapshot after stopping its writers,
                          only when the new root has no state/ yet.
  --confirm-source-quiesced
                        Confirm no other process can write the source during seeding
  --init-empty-state     Explicitly initialize a new, empty state on approved local storage
  --ref <git-ref>        Committed revision to deploy (default: HEAD)
  --gateway-port <port>  Local and remote Gateway port (default: 18789)
  --adminbot-port <port> Local and remote AdminBot port (default: 8765)
  --keep-releases <n>    Past releases to retain for deploy (default: 3)
  --allow-behind         Deploy a ref that is behind origin/main (deliberate rollback);
                          without it, deploy refuses a stale ref

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
    --root)
      (($# >= 2)) || die "--root requires a value"
      DEPLOY_ROOT="$2"
      shift 2
      ;;
    --seed-state)
      (($# >= 2)) || die "--seed-state requires a value"
      SEED_STATE="$2"
      shift 2
      ;;
    --init-empty-state)
      INIT_EMPTY_STATE="1"
      shift
      ;;
    --confirm-source-quiesced)
      CONFIRM_SOURCE_QUIESCED="1"
      shift
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
    --allow-behind)
      ALLOW_BEHIND="1"
      shift
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
[[ -n "$HOST" ]] || die "set AURORA_HOST or pass --host <hostname> — the deploy target is not named in the repo"
[[ "$GATEWAY_PORT" =~ ^[0-9]+$ ]] || die "gateway port must be numeric"
[[ "$ADMINBOT_PORT" =~ ^[0-9]+$ ]] || die "AdminBot port must be numeric"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ && "$KEEP_RELEASES" -ge 1 ]] || die "--keep-releases must be a positive integer"
DEPLOY_ROOT="${DEPLOY_ROOT:-/mfs1/u/${CS_USER}/jinesis-adminbot}"
DEPLOY_ROOT="${DEPLOY_ROOT%/}"
# `deploy` prunes with rm -rf under this path, so a root that cannot be reasoned about is refused
# here rather than on the far side of an SSH connection. The remote half checks it again on its
# own, because it is what actually runs the removals.
[[ "$DEPLOY_ROOT" == /* ]] || die "--root must be an absolute path: $DEPLOY_ROOT"
[[ "$DEPLOY_ROOT" != *".."* ]] || die "--root must not contain '..': $DEPLOY_ROOT"
SEED_STATE="${SEED_STATE%/}"
[[ -z "$SEED_STATE" || "$SEED_STATE" == /* ]] || die "--seed-state must be an absolute remote path: $SEED_STATE"
[[ -z "$SEED_STATE" || "$INIT_EMPTY_STATE" != "1" ]] || \
  die "--seed-state and --init-empty-state cannot be combined"

TARGET="${CS_USER}@${HOST}"
REMOTE_BASE="$DEPLOY_ROOT"
REMOTE_CURRENT="${REMOTE_BASE}/current"
# The databases, symlinked into each release as `state` so the units -- which run with the
# release as their working directory -- reach them without naming a path.
REMOTE_STATE="${REMOTE_BASE}/state"
# What is left in the home directory, named once. Both are 0600 credential files: they stay on
# /h deliberately, and are the reason this is not simply "$DEPLOY_ROOT for everything".
REMOTE_HOME="/h/405/${CS_USER}"
REMOTE_ENV="${REMOTE_HOME}/.config/jinesis-adminbot/adminbot.env"
REMOTE_CONFIG="${REMOTE_HOME}/.openclaw/openclaw.json"
# An unset password keeps today's interactive-prompt behavior. Build the arrays before optional
# sshpass wrapping: macOS's Bash 3 treats expansion of an empty array as unbound under set -u.
SSH=(ssh -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET")
SCP=(scp -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}")
SSH_TTY=(ssh -t -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" "$TARGET")
SSH_TUNNEL=(ssh -o "ConnectTimeout=${SSH_CONNECT_TIMEOUT}" \
  -L "${GATEWAY_PORT}:127.0.0.1:${GATEWAY_PORT}" \
  -L "${ADMINBOT_PORT}:127.0.0.1:${ADMINBOT_PORT}" "$TARGET")
if [[ -n "$SSH_PASSWORD" ]]; then
  command -v sshpass >/dev/null || die "sshpass is required when AURORA_SSH_PASSWORD is set"
  export SSHPASS="$SSH_PASSWORD"
  SSH=(sshpass -e "${SSH[@]}")
  SCP=(sshpass -e "${SCP[@]}")
  SSH_TTY=(sshpass -e "${SSH_TTY[@]}")
  SSH_TUNNEL=(sshpass -e "${SSH_TUNNEL[@]}")
fi

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
    "${SSH[@]}" bash -s -- "$CS_USER" "$REMOTE_BASE" <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
expected_user="$1"
deploy_root="$2"
printf 'host=%s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'user=%s\n' "$USER"
[[ "$USER" == "$expected_user" ]] || {
  printf 'warning: expected user %s but SSH reports %s\n' "$expected_user" "$USER" >&2
}
printf 'home=%s\n' "$HOME"
# The deployment root is on another volume now, so "I can log in" no longer implies "I can
# deploy". Checked against the nearest existing ancestor: the root itself does not exist before
# the first deploy, and a missing directory the account can create is not a problem.
printf 'deploy_root=%s\n' "$deploy_root"
probe="$deploy_root"
while [[ ! -e "$probe" && "$probe" == */* && "$probe" != "/" ]]; do
  probe="${probe%/*}"
  [[ -n "$probe" ]] || probe="/"
done
if [[ -w "$probe" ]]; then
  printf 'deploy_root_writable=yes (%s)\n' "$probe"
else
  printf 'deploy_root_writable=no (%s is not writable by %s)\n' "$probe" "$USER" >&2
fi
[[ -d "/mfs1/u/$USER" ]] && printf 'mfs1=yes\n' || printf 'mfs1=no\n'
command -v node >/dev/null && printf 'node=%s\n' "$(node --version)" || printf 'node=missing\n'
command -v systemctl >/dev/null && printf 'systemd=yes\n' || printf 'systemd=no\n'
loginctl show-user "$USER" -p Linger 2>/dev/null || printf 'Linger=unknown\n'
REMOTE
    ;;

  connect)
    check_local_tools
    exec "${SSH_TUNNEL[@]}"
    ;;

  deploy)
    check_local_tools
    [[ -z "$SEED_STATE" || "$CONFIRM_SOURCE_QUIESCED" == "1" ]] || \
      die "--seed-state requires --confirm-source-quiesced after verifying no external source writers"
    [[ "$CONFIRM_SOURCE_QUIESCED" != "1" || -n "$SEED_STATE" ]] || \
      die "--confirm-source-quiesced requires --seed-state"
    # Fetch before anything is resolved, and resolve each side exactly once.
    #
    # Ordering is the whole correctness argument here. This used to fetch in the middle and write
    # `${REF}^{commit}` at each use, so a `--ref origin/main` meant two different commits within
    # one comparison: the stale remote-tracking ref in the "deploying" line, and the freshly
    # fetched one in the check below. The ref was then compared against itself and reported as
    # "0 commit(s) behind origin/main", refusing a deploy that was in fact exactly current, and
    # advising the operator to "pass --ref origin/main" -- which is what they had passed.
    if git -C "$REPO_ROOT" fetch --quiet origin main 2>/dev/null; then
      fetched_upstream=1
    else
      fetched_upstream=0
    fi
    git -C "$REPO_ROOT" rev-parse --verify "${REF}^{commit}" >/dev/null ||
      die "not a committed Git revision: $REF"
    # Full object ids: every comparison below is against these two variables, never against a ref
    # name that could resolve differently a line later.
    ref_commit="$(git -C "$REPO_ROOT" rev-parse "${REF}^{commit}")"
    sha="$(git -C "$REPO_ROOT" rev-parse --short=12 "$ref_commit")"
    # Say what is about to ship, and refuse a ref that is behind the shared main. The default is
    # HEAD of whatever clone this runs from, and a clone that was never pulled deploys its stale
    # main just as faithfully as a fresh one: on 2026-08-30 that re-shipped a three-day-old
    # service while the Vercel UI was already asking for routes it did not have, and every tab
    # blamed "the service needs a deploy" -- right after one. --allow-behind is for a deliberate
    # rollback.
    printf 'deploying %s  %s\n' "$sha" "$(git -C "$REPO_ROOT" log -1 --format='%cd  %s' --date=short "$ref_commit")" >&2
    if ((fetched_upstream)); then
      upstream_commit="$(git -C "$REPO_ROOT" rev-parse origin/main)"
      upstream="$(git -C "$REPO_ROOT" rev-parse --short=12 "$upstream_commit")"
      if [[ "$upstream_commit" != "$ref_commit" ]] &&
        git -C "$REPO_ROOT" merge-base --is-ancestor "$ref_commit" "$upstream_commit"; then
        behind="$(git -C "$REPO_ROOT" rev-list --count "${ref_commit}..${upstream_commit}")"
        # Belt and braces after the bug above: a staleness refusal that cannot name at least one
        # missing commit is not a refusal anybody can act on, so it is not one.
        if ((behind > 0)); then
          # The old advice was a list read out regardless of what was passed, which is how it came
          # to tell an operator deploying origin/main to deploy origin/main. Say the thing that
          # would actually move this particular ref forward.
          if [[ "$REF" == "HEAD" ]]; then
            hint="pull first, or pass --ref origin/main to deploy the fetched tip"
          else
            hint="pass --ref origin/main to deploy the fetched tip"
          fi
          if [[ "$ALLOW_BEHIND" != "1" ]]; then
            die "ref $REF ($sha) is $behind commit(s) behind origin/main ($upstream); $hint, or --allow-behind for a deliberate rollback"
          fi
          printf 'warning: deploying %s, which is %s commit(s) behind origin/main (%s)\n' "$sha" "$behind" "$upstream" >&2
        fi
      fi
    else
      printf 'note: could not fetch origin/main; not checking whether %s is stale\n' "$sha" >&2
    fi
    release_id="${sha}-$(date -u +%Y%m%dT%H%M%SZ)"
    remote_release="${REMOTE_BASE}/releases/${release_id}"
    archive="$(mktemp "${TMPDIR:-/tmp}/jinesis-adminbot.XXXXXX.tar")"
    remote_lock_token=""
    cleanup_deploy() {
      status=$?
      trap - EXIT
      if [[ -n "$remote_lock_token" ]]; then
        if ! "${SSH[@]}" bash -s -- "$REMOTE_BASE" "$remote_lock_token" <<'REMOTE_DEPLOY_UNLOCK'
set -euo pipefail
lock_dir="$1/.adminbot-deploy.lock"
token="$2"
[[ -d "$lock_dir" && -f "$lock_dir/owner" && "$(cat "$lock_dir/owner")" == "$token" ]] || {
  echo 'Refusing to remove a deployment lock owned by another run.' >&2
  exit 1
}
rm -- "$lock_dir/owner"
rmdir -- "$lock_dir"
REMOTE_DEPLOY_UNLOCK
        then
          echo 'Warning: deployment lock could not be released; operator review is required.' >&2
          status=1
        fi
      fi
      rm -f -- "$archive"
      exit "$status"
    }
    trap cleanup_deploy EXIT

    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
      printf 'note: the worktree is dirty; deploy uses committed ref %s only\n' "$REF" >&2
    fi
    git -C "$REPO_ROOT" archive --format=tar --output="$archive" "$REF"
    # Before anything is uploaded: does the target volume actually have room? /w/406 filled up
    # silently once, and the first anyone knew of it was the Control UI telling a roster of people
    # with correct passwords that their password was wrong -- SQLite answers "disk I/O error" for
    # the audit row every login attempt writes. A deploy that cannot fit is refused here, where the
    # message can say so, rather than half-landing and taking sign-in down with it.
    "${SSH[@]}" bash -s -- "$REMOTE_BASE" "$MIN_DEPLOY_FREE_MB" "$MIN_DEPLOY_FREE_INODES" <<'REMOTE_SPACE'
set -euo pipefail
base="$1"
min_mb="$2"
min_inodes="$3"
# The root does not exist before the first deploy, so measure the nearest existing ancestor --
# it is the same filesystem either way.
probe="$base"
while [[ ! -e "$probe" && "$probe" == */* && "$probe" != "/" ]]; do
  probe="${probe%/*}"
  [[ -n "$probe" ]] || probe="/"
done
free_mb="$(df -Pm -- "$probe" | awk 'NR==2 {print $4}')"
free_inodes="$(df -Pi -- "$probe" | awk 'NR==2 {print $4}')"
printf 'deploy_root=%s free_mb=%s free_inodes=%s\n' "$base" "$free_mb" "$free_inodes"
# Some filesystems report no inode accounting at all (df prints "-"); that is not a failure.
if [[ "$free_mb" =~ ^[0-9]+$ ]] && ((free_mb < min_mb)); then
  printf 'Refusing to deploy: %s has %s MB free, below the %s MB a release plus the database needs.\n' \
    "$probe" "$free_mb" "$min_mb" >&2
  printf 'Point --root / $AURORA_DEPLOY_ROOT at a volume with room, or free space and retry.\n' >&2
  exit 1
fi
if [[ "$free_inodes" =~ ^[0-9]+$ ]] && ((free_inodes < min_inodes)); then
  printf 'Refusing to deploy: %s has %s inodes free, below the %s a node_modules tree needs.\n' \
    "$probe" "$free_inodes" "$min_inodes" >&2
  exit 1
fi
REMOTE_SPACE

    # One run owns the mutable stop/build/seed/cutover sequence. A stale lock fails closed until
    # an operator inspects it; the EXIT trap removes only a lock carrying this run's token.
    new_lock_token="$(basename -- "$archive")-$$"
    "${SSH[@]}" bash -s -- "$REMOTE_BASE" "$new_lock_token" <<'REMOTE_DEPLOY_LOCK'
set -euo pipefail
base="$1"
token="$2"
[[ "$base" == /* && "$base" != *".."* && "$base" != / && "$base" != "$HOME" ]] || {
  echo 'Refusing deployment lock outside an approved root.' >&2
  exit 1
}
depth="${base#/}"
depth="${depth//[!\/]/}"
((${#depth} >= 2)) || {
  echo 'Refusing deployment lock under a shallow root.' >&2
  exit 1
}
mkdir -p -- "$base"
lock_dir="$base/.adminbot-deploy.lock"
mkdir -m 700 -- "$lock_dir" 2>/dev/null || {
  echo 'Refusing deploy: another deployment holds this root lock.' >&2
  exit 1
}
trap 'rm -f -- "$lock_dir/owner"; rmdir -- "$lock_dir"' EXIT
printf '%s\n' "$token" >"$lock_dir/owner"
trap - EXIT
REMOTE_DEPLOY_LOCK
    remote_lock_token="$new_lock_token"

    # Check state before stopping services, then prune to the newest KEEP_RELEASES release
    # directories -- NOT a full wipe. Whatever `current` pointed to (the release actually
    # running before this deploy) is resolved first and printed as the only line on stdout,
    # captured below, so the build step can hardlink-copy its node_modules instead of every
    # deploy installing all workspace packages from nothing. Every other command in this
    # block is redirected to stderr so that marker line is the only thing on stdout.
    prior_release="$("${SSH[@]}" bash -s -- "$REMOTE_BASE" "$REMOTE_CURRENT" "$KEEP_RELEASES" "$REMOTE_STATE" "seed=$SEED_STATE" "$INIT_EMPTY_STATE" <<'REMOTE_CLEAN'
set -euo pipefail
base="$1"
current="$2"
keep="$3"
state_dir="$4"
seed_state="${5#seed=}"
init_empty="$6"
# This block removes directories, so the root it was handed is checked before anything goes.
#
# It used to compare against one hardcoded literal, which stopped working the moment the root
# became configurable (--root / $AURORA_DEPLOY_ROOT) -- and a guard that has to be passed the
# thing it is guarding against is no guard at all. What makes a cleanup safe is the shape of the
# path, so that is what is checked: absolute, no traversal, at least two levels deep, and not the
# home directory itself. /w/406/adminbot passes; /w, /w/406 and $HOME do not. Everything removed
# below is under "$base/releases", which is re-derived here rather than taken on trust.
[[ "$base" == /* ]] || {
  printf 'Refusing cleanup: deployment root is not an absolute path: %s\n' "$base" >&2
  exit 1
}
[[ "$base" != *".."* ]] || {
  printf 'Refusing cleanup: deployment root contains a traversal: %s\n' "$base" >&2
  exit 1
}
[[ "$base" != "/" && "$base" != "$HOME" ]] || {
  printf 'Refusing cleanup: deployment root is a filesystem or home root: %s\n' "$base" >&2
  exit 1
}
depth="${base#/}"
depth="${depth//[!\/]/}"
((${#depth} >= 2)) || {
  printf 'Refusing cleanup: deployment root is too shallow to prune safely: %s\n' "$base" >&2
  exit 1
}
# A missing or half-seeded state must never silently turn into an empty or stale database.
pending_marker="$state_dir/.adminbot-seed-pending"
[[ ! -L "$state_dir" && ! -e "$pending_marker" && ! -L "$pending_marker" ]] || {
  echo 'Refusing deploy: state is a symlink or an incomplete seed needs operator review.' >&2
  exit 1
}
[[ ! -L "$state_dir/adminbot.sqlite" ]] || {
  echo 'Refusing deploy: AdminBot database must be a regular file in state.' >&2
  exit 1
}
if [[ -d "$state_dir" ]]; then
  [[ -z "$seed_state" ]] || {
    echo 'Refusing seed: target state already exists.' >&2
    exit 1
  }
  [[ -f "$state_dir/adminbot.sqlite" || "$init_empty" == "1" ]] || {
    echo 'Refusing deploy: state has no AdminBot database; explicitly initialize a fresh state.' >&2
    exit 1
  }
  [[ "$init_empty" != "1" || ! -f "$state_dir/adminbot.sqlite" ]] || {
    echo 'Refusing fresh initialization: state already has an AdminBot database.' >&2
    exit 1
  }
else
  [[ ! -e "$state_dir" ]] || {
    echo 'Refusing deploy: state path is not a directory.' >&2
    exit 1
  }
  [[ -n "$seed_state" || "$init_empty" == "1" ]] || {
    echo 'Refusing deploy: missing state requires --seed-state or --init-empty-state.' >&2
    exit 1
  }
fi
destination="$state_dir"
while [[ ! -e "$destination" && "$destination" != / ]]; do
  destination="${destination%/*}"
  [[ -n "$destination" ]] || destination=/
done
filesystem="$(stat -f -c %T -- "$destination")" || exit 1
case "$filesystem" in
  ext2 | ext3 | ext4 | xfs | btrfs | zfs | f2fs) ;;
  *)
    printf 'Refusing SQLite state on unsupported %s filesystem.\n' "$filesystem" >&2
    exit 1
    ;;
esac
if [[ -n "$seed_state" ]]; then
  [[ -d "$seed_state" && -f "$seed_state/adminbot.sqlite" ]] || {
    echo 'Refusing seed: source database is missing.' >&2
    exit 1
  }
  [[ "$(stat -c %u -- "$seed_state/adminbot.sqlite")" == "$(id -u)" ]] || {
    echo 'Refusing seed: the deploying account does not own the source database.' >&2
    exit 1
  }
  filesystem="$(stat -f -c %T -- "$seed_state")" || exit 1
  case "$filesystem" in
    ext2 | ext3 | ext4 | xfs | btrfs | zfs | f2fs) ;;
    *)
      printf 'Refusing SQLite seed from unsupported %s filesystem.\n' "$filesystem" >&2
      exit 1
      ;;
  esac
fi
systemctl --user show-environment >/dev/null || {
  echo 'Refusing deploy: user systemd is unavailable; cannot stop database writers.' >&2
  exit 1
}
{
  systemctl --user stop \
    jinesis-adminbot-sheet-poller.timer \
    jinesis-adminbot-sheet-poller.service \
    jinesis-adminbot-email.timer \
    jinesis-adminbot-email.service \
    jinesis-adminbot-openreview.timer \
    jinesis-adminbot-openreview.service \
    jinesis-openclaw-gateway.service \
    jinesis-adminbot.service 2>/dev/null || true
} >&2
for unit in jinesis-adminbot-sheet-poller.timer jinesis-adminbot-sheet-poller.service \
  jinesis-adminbot-email.timer jinesis-adminbot-email.service \
  jinesis-adminbot-openreview.timer jinesis-adminbot-openreview.service \
  jinesis-openclaw-gateway.service jinesis-adminbot.service; do
  state="$(systemctl --user show "$unit" -p ActiveState --value)" || exit 1
  [[ "$state" == inactive || "$state" == failed ]] || {
    printf 'Refusing deploy: %s is still %s.\n' "$unit" "$state" >&2
    exit 1
  }
done
prior=""
if [[ -L "$current" ]]; then
  prior="$(basename -- "$(readlink -f -- "$current")")"
elif [[ -e "$current" ]]; then
  printf 'Refusing non-symlink current path: %s\n' "$current" >&2
  exit 1
fi
releases="$base/releases"
mkdir -p "$releases"
{
  cd "$releases"
  # Belt and braces after the shape checks above: prune only from the directory this actually
  # landed in, so a symlinked or substituted `releases` cannot redirect the removals.
  [[ "$PWD" == "$releases" ]] || {
    printf 'Refusing cleanup: %s resolved to %s\n' "$releases" "$PWD" >&2
    exit 1
  }
  # Newest-mtime-first; each release directory is created once by `deploy` and never
  # touched again by anything else, so mtime order matches deploy order.
  kept=0
  while IFS= read -r old; do
    [[ -n "$old" ]] || continue
    [[ "$old" == "$prior" ]] && continue
    kept=$((kept + 1))
    ((kept < keep)) || rm -rf -- "$old"
  done < <(ls -1t 2>/dev/null)
} >&2
printf '%s\n' "$prior"
REMOTE_CLEAN
    )"

    "${SSH[@]}" mkdir -p "$remote_release"
    "${SCP[@]}" "$archive" "${TARGET}:${remote_release}/source.tar"

    # The two optional values are prefixed rather than passed bare, and it matters: ssh flattens its
    # argument list into a single string for the remote shell to re-split, so an EMPTY argument does
    # not survive the trip -- it vanishes and every argument after it shifts down one. `prior_release`
    # is empty on the first deploy into a root and `--seed-state` is empty on most deploys, so with
    # bare arguments a first deploy would silently bind state_dir to the deployment root and symlink
    # the release's state at it. An earlier revision dodged this by keeping the single optional value
    # last; two of them cannot both be last, so they carry a prefix that is stripped on arrival and
    # keeps them non-empty on the wire.
    "${SSH[@]}" bash -s -- "$remote_release" "$REMOTE_CURRENT" "$GATEWAY_PORT" "$ADMINBOT_PORT" "$REMOTE_STATE" "$REMOTE_BASE" "prior=$prior_release" "seed=$SEED_STATE" "$INIT_EMPTY_STATE" <<'REMOTE'
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH
release="$1"
current="$2"
gateway_port="$3"
adminbot_port="$4"
state_dir="$5"
base="$6"
# Prefixed at the call site so neither can be empty on the wire; see the note there.
prior_release="${7#prior=}"
seed_state="${8#seed=}"
init_empty="$9"
cd "$release"
tar -xf source.tar
rm -f source.tar

# The first remote preflight ran before services stopped. Recheck after the build, since another
# deploy may have created state in the meantime. An incomplete snapshot marker always blocks.
pending_marker="$state_dir/.adminbot-seed-pending"
[[ ! -L "$state_dir" && ! -e "$pending_marker" && ! -L "$pending_marker" ]] || {
  echo 'Refusing deploy: state is a symlink or an incomplete seed needs operator review.' >&2
  exit 1
}
[[ ! -L "$state_dir/adminbot.sqlite" ]] || {
  echo 'Refusing deploy: AdminBot database must be a regular file in state.' >&2
  exit 1
}
if [[ -n "$seed_state" ]]; then
  [[ ! -e "$state_dir" && -d "$seed_state" ]] || {
    echo 'Refusing seed: source is missing or target state appeared during the build.' >&2
    exit 1
  }
elif [[ -e "$state_dir" ]]; then
  [[ -f "$state_dir/adminbot.sqlite" || "$init_empty" == "1" ]] || {
    echo 'Refusing deploy: target state has no AdminBot database.' >&2
    exit 1
  }
  [[ "$init_empty" != "1" || ! -f "$state_dir/adminbot.sqlite" ]] || {
    echo 'Refusing fresh initialization: state gained an AdminBot database during the build.' >&2
    exit 1
  }
else
  [[ "$init_empty" == "1" ]] || {
    echo 'Refusing deploy: missing state requires --seed-state or --init-empty-state.' >&2
    exit 1
  }
fi
seed_from="$seed_state"

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

# Keep the store on the deployment volume rather than wherever pnpm decides to put it. pnpm's
# default lands it beside the project's mount point, which is how most of a gigabyte of store
# ended up on a 2.1 GB volume next to the database it then starved.
export npm_config_store_dir="$base/.pnpm-store"
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

# Even an existing database cannot safely keep using SQLite WAL on a network mount.
target_probe="$state_dir"
while [[ ! -e "$target_probe" && "$target_probe" != / ]]; do
  target_probe="${target_probe%/*}"
  [[ -n "$target_probe" ]] || target_probe=/
done
filesystem="$(stat -f -c %T -- "$target_probe")" || exit 1
case "$filesystem" in
  ext2 | ext3 | ext4 | xfs | btrfs | zfs | f2fs) ;;
  *)
    printf 'Refusing SQLite state on unsupported %s filesystem.\n' "$filesystem" >&2
    exit 1
    ;;
esac

# Seed only a new state directory. A raw copy of a WAL database can pair a database file with
# WAL frames from a different moment, losing committed writes. The old state stays untouched.
seeded_state=0
if [[ -n "$seed_from" ]]; then
  [[ ! -e "$state_dir" && -d "$seed_from" && "$(readlink -f -- "$seed_from")" != "$state_dir" ]] || {
    echo 'Refusing seed: target state exists or source is unavailable.' >&2
    exit 1
  }
  assert_seed_writers_stopped() {
    for unit in jinesis-adminbot-sheet-poller.timer jinesis-adminbot-sheet-poller.service \
      jinesis-adminbot-email.timer jinesis-adminbot-email.service \
      jinesis-adminbot-openreview.timer jinesis-adminbot-openreview.service \
      jinesis-openclaw-gateway.service jinesis-adminbot.service; do
      state="$(systemctl --user show "$unit" -p ActiveState --value)" || return 1
      [[ "$state" == inactive || "$state" == failed ]] || {
        printf 'Refusing seed: %s became %s during deployment.\n' "$unit" "$state" >&2
        return 1
      }
    done
  }
  assert_seed_writers_stopped
  [[ -f "$seed_from/adminbot.sqlite" ]] || {
    echo "Refusing seed: $seed_from has no adminbot.sqlite" >&2
    exit 1
  }
  [[ "$(stat -c %u -- "$seed_from/adminbot.sqlite")" == "$(id -u)" ]] || {
    echo 'Refusing seed: the deploying account does not own the source database and cannot stop its writers.' >&2
    exit 1
  }
  # WAL is unsupported on network filesystems. A snapshot is consistent, but placing the next
  # live WAL database on NFS/FUSE would preserve the same storage hazard under a new pathname.
  for location in "$seed_from" "$base"; do
    filesystem="$(stat -f -c %T -- "$location")" || exit 1
    case "$filesystem" in
      ext2 | ext3 | ext4 | xfs | btrfs | zfs | f2fs) ;;
      *)
        printf 'Refusing seed: %s uses %s; SQLite WAL needs approved local storage.\n' \
          "$location" "$filesystem" >&2
        exit 1
        ;;
    esac
  done
  echo "Snapshotting $seed_from into $state_dir (one-time; source retained)"
  stage="${state_dir}.seed.$$"
  [[ ! -e "$stage" ]] || {
    printf 'Refusing seed: staging path already exists: %s\n' "$stage" >&2
    exit 1
  }
  mkdir -m 700 -- "$stage"
  trap 'rm -rf -- "$stage"' EXIT
  printf 'Seed pending release cutover; inspect before retrying.\n' >"$stage/.adminbot-seed-pending"
  seeded=0
  left=0
  for entry in "$seed_from"/*; do
    [[ -e "$entry" ]] || continue
    case "$(basename -- "$entry")" in
      *.backup-* | *.bak-* | *.before-* | *.empty-*)
        left=$((left + 1))
        continue
        ;;
      *.sqlite-wal | *.sqlite-shm)
        continue
        ;;
      *.sqlite)
        [[ -f "$entry" && ! -L "$entry" ]] || {
          printf 'Refusing seed: SQLite source is not a regular file: %s\n' "$entry" >&2
          exit 1
        }
        node "$release/scripts/snapshot-sqlite.mjs" "$entry" "$stage/$(basename -- "$entry")" --verify
        ;;
      *)
        cp -a -- "$entry" "$stage/"
        ;;
    esac
    seeded=$((seeded + 1))
  done
  [[ -f "$stage/adminbot.sqlite" ]] || {
    echo 'Refusing seed: verified AdminBot snapshot is missing.' >&2
    exit 1
  }
  assert_seed_writers_stopped
  [[ ! -e "$state_dir" ]] || {
    echo 'Refusing seed: target state appeared during snapshot.' >&2
    exit 1
  }
  # No-clobber closes the gap between the existence check and rename if another deploy raced us.
  mv -Tn -- "$stage" "$state_dir"
  [[ ! -e "$stage" ]] || {
    echo 'Refusing seed: target state appeared during snapshot.' >&2
    exit 1
  }
  trap - EXIT
  seeded_state=1
  printf 'Seeded %s verified file(s); left %s historical snapshot(s) at %s\n' "$seeded" "$left" "$seed_from"
fi
mkdir -p "$state_dir"
if [[ -e "$release/state" && ! -L "$release/state" ]]; then
  rmdir "$release/state" 2>/dev/null || {
    echo "Refusing to replace non-empty release state directory: $release/state" >&2
    exit 1
  }
fi
ln -sfn "$state_dir" "$release/state"
# Installing user units changes files outside the release. Save only the units this installer
# touches so a failed install leaves the previous release's definitions available for rollback.
unit_dir="$HOME/.config/systemd/user"
unit_backup="$(mktemp -d "$base/.units.rollback.XXXXXX")"
units=(
  jinesis-ollama.service
  jinesis-adminbot.service
  jinesis-openclaw-gateway.service
  jinesis-adminbot-email.service
  jinesis-adminbot-email.timer
  jinesis-adminbot-openreview.service
  jinesis-adminbot-openreview.timer
  jinesis-adminbot-sheet-poller.service
  jinesis-adminbot-sheet-poller.timer
)
for unit in "${units[@]}"; do
  [[ ! -e "$unit_dir/$unit" && ! -L "$unit_dir/$unit" ]] || cp -a -- "$unit_dir/$unit" "$unit_backup/"
done
for timer in jinesis-adminbot-email.timer jinesis-adminbot-openreview.timer \
  jinesis-adminbot-sheet-poller.timer; do
  if systemctl --user is-enabled --quiet "$timer"; then
    printf '%s\n' "$timer" >>"$unit_backup/enabled-timers"
  fi
done
restore_units_on_failure() {
  status=$?
  if ((status != 0)); then
    for unit in "${units[@]}"; do
      rm -f -- "$unit_dir/$unit"
      [[ ! -e "$unit_backup/$unit" && ! -L "$unit_backup/$unit" ]] || \
        cp -a -- "$unit_backup/$unit" "$unit_dir/"
    done
    systemctl --user daemon-reload || true
    if [[ -f "$unit_backup/enabled-timers" ]]; then
      while IFS= read -r timer; do
        systemctl --user enable "$timer" || true
      done <"$unit_backup/enabled-timers"
    fi
    echo 'Deploy failed; previous release and user-unit definitions remain available. Services are stopped.' >&2
  fi
  rm -rf -- "$unit_backup"
}
trap restore_units_on_failure EXIT
"$release/deploy/aurora/install-user-services.sh" \
  --root "$release" \
  --state "$state_dir" \
  --gateway-port "$gateway_port" \
  --adminbot-port "$adminbot_port" \
  --no-start
# Keep the old release addressable until its replacement is built, the state is verified, and
# service definitions are installed. Rename a fresh symlink so readers never see a missing current.
next_current="${current}.next.$$"
ln -s "$release" "$next_current"
mv -Tf -- "$next_current" "$current"
trap - EXIT
if ((seeded_state)); then
  rm -- "$pending_marker"
fi
rm -rf -- "$unit_backup"
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

    # Staged inside the state directory rather than next to openclaw.json in the home directory:
    # the snapshot is the size of the database, and landing it on the home volume is the thing
    # moving state off /h was meant to stop.
    remote_upload="${REMOTE_STATE}/.adminbot-db-upload.$$"
    remote_database="${REMOTE_STATE}/adminbot.sqlite"
    "${SSH[@]}" mkdir -p "$REMOTE_STATE"
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
    "${SSH_TTY[@]}" \
      "set -euo pipefail; set -a; . $REMOTE_ENV; set +a; ${REMOTE_HOME}/.local/bin/gog auth add \"\$GOG_ACCOUNT\" --remote --force-consent --services gmail,calendar,drive,docs,sheets,contacts"
    ;;

  install-services)
    (($# == 0)) || die "install-services takes no arguments"
    "${SSH[@]}" "$(remote_install_script)" \
      --root "$REMOTE_CURRENT" \
      --state "$REMOTE_STATE" \
      --gateway-port "$GATEWAY_PORT" \
      --adminbot-port "$ADMINBOT_PORT" \
      --no-start
    ;;

  start)
    (($# == 0)) || die "start takes no arguments"
    "${SSH[@]}" "$(remote_install_script)" \
      --root "$REMOTE_CURRENT" \
      --state "$REMOTE_STATE" \
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
    exec "${SSH_TTY[@]}" journalctl --user -u "$systemd_unit" -f
    ;;

  *)
    die "unknown command: $COMMAND"
    ;;
esac
