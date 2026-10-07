#!/usr/bin/env bash
# Build a release beside the live one on Aurora, swap to it, and roll back if it is not healthy.
#
# Run by the self-hosted GitHub Actions runner on Aurora (.github/workflows/deploy-aurora.yaml),
# on the host itself; nothing here crosses SSH. It automates the manual release swap that has been
# used since the deployment root moved to NFS: build while the services keep running, then a
# stop/repoint/start that is an outage of a couple of seconds. `aurora-adminbot-host.sh deploy`
# stops the services before it builds, so it is not reused here.
#
# Everything that could make an unattended deploy do damage fails closed:
#
#   - The target must contain the live release's commit. Deploy branches have carried commits that
#     were not on main; shipping main over one of those would silently drop them. A target that is
#     already contained in the live release (an older CI run finishing late) is skipped, not shipped.
#   - A change to how the units are generated is not something a path substitution can carry, so a
#     release that changes install-user-services.sh or install-member-sheet-poller.sh is refused and
#     left for a manual `install-services`.
#   - SQLite state on a network filesystem is refused unless the host operator opted in with
#     AURORA_ACCEPT_NETWORK_STATE=1 in the runner's own environment -- a setting on Aurora, not one a
#     commit can flip.
#   - Services are only touched once the new release has built. A release that does not answer the
#     health probes is rolled back to the previous one, and the job fails.
#
# Rollback restores code, not data: a release that migrated the database forward leaves the
# migration in place when the previous code comes back.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

ROOT="${AURORA_DEPLOY_ROOT:-}"
SOURCE=""
REF=""
KEEP_RELEASES="3"
ADMINBOT_PORT="8765"
GATEWAY_PORT="18789"
HEALTH_TIMEOUT_SECONDS="${AURORA_DEPLOY_HEALTH_TIMEOUT:-180}"
HEALTH_INTERVAL_SECONDS="${AURORA_DEPLOY_HEALTH_INTERVAL:-3}"
MIN_FREE_MB="4096"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: deploy/aurora/auto-deploy.sh --source <git checkout> --ref <commit> [--root <path>]

  --source <dir>   Git checkout of the repository (repository root, not openclaw-adminbot/)
  --ref <commit>   Commit to deploy
  --root <path>    Deployment root (default: $AURORA_DEPLOY_ROOT; there is no built-in default)
EOF
}

while (($# > 0)); do
  case "$1" in
    --root)
      (($# >= 2)) || die "--root requires a value"
      ROOT="$2"
      shift 2
      ;;
    --source)
      (($# >= 2)) || die "--source requires a value"
      SOURCE="$2"
      shift 2
      ;;
    --ref)
      (($# >= 2)) || die "--ref requires a value"
      REF="$2"
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

[[ -n "$SOURCE" && -n "$REF" ]] || {
  usage >&2
  exit 2
}
# No default root on purpose: the host script's default (/mfs1) holds a stale database, and a
# deploy that lands there comes up healthy on old data.
[[ -n "$ROOT" ]] || die "pass --root or set AURORA_DEPLOY_ROOT"
ROOT="${ROOT%/}"
[[ "$ROOT" == /* && "$ROOT" != *".."* && "$ROOT" != "$HOME" ]] || die "unsafe deployment root: $ROOT"
depth="${ROOT#/}"
depth="${depth//[!\/]/}"
((${#depth} >= 2)) || die "deployment root is too shallow: $ROOT"

CURRENT="$ROOT/current"
STATE="$ROOT/state"
RELEASES="$ROOT/releases"
UNIT_DIR="$HOME/.config/systemd/user"
WRITER_UNITS=(jinesis-adminbot.service jinesis-openclaw-gateway.service)
# The units whose definitions name the release directory. Matches what install-user-services.sh
# and install-member-sheet-poller.sh generate.
RELEASE_UNITS=(
  jinesis-adminbot.service
  jinesis-openclaw-gateway.service
  jinesis-adminbot-email.service
  jinesis-adminbot-sheet-poller.service
)

git -C "$SOURCE" rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout: $SOURCE"
target_commit="$(git -C "$SOURCE" rev-parse --verify --quiet "${REF}^{commit}")" ||
  die "not a commit in $SOURCE: $REF"
target_sha="${target_commit:0:12}"

# ---------------------------------------------------------------------------------------------
# The account-wide writer lock shared with aurora-adminbot-host.sh and install-user-services.sh,
# so this cannot interleave with a manual deploy, a database sync or a unit reinstall.
lock_dir="$HOME/.config/jinesis-adminbot/.writer.lock"
lock_token="auto-deploy-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
mkdir -p -- "$(dirname -- "$lock_dir")"
mkdir -m 700 -- "$lock_dir" 2>/dev/null ||
  die "another AdminBot writer operation holds the account lock ($lock_dir); retry when it finishes"
printf '%s\n' "$lock_token" >"$lock_dir/owner"
release_lock() {
  if [[ -f "$lock_dir/owner" && "$(cat -- "$lock_dir/owner")" == "$lock_token" ]]; then
    rm -f -- "$lock_dir/owner"
    rmdir -- "$lock_dir" 2>/dev/null || true
  fi
}
new_release=""
cleanup() {
  status=$?
  trap - EXIT
  # A release that never went live is removed; one that went live and was rolled back is kept for
  # inspection (see rollback below), so new_release is cleared before that point.
  if ((status != 0)) && [[ -n "$new_release" && -d "$new_release" ]]; then
    rm -rf -- "$new_release"
  fi
  release_lock
  exit "$status"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------------------------
# What is live, and is the target a step forward from it?
[[ -L "$CURRENT" ]] || die "$CURRENT is not a symlink; refusing to deploy over it"
live_release="$(readlink -f -- "$CURRENT")"
[[ -d "$live_release" && "$(dirname -- "$live_release")" == "$RELEASES" ]] ||
  die "current points outside $RELEASES: $live_release"
live_name="$(basename -- "$live_release")"
live_sha="${live_name%%-*}"
[[ "$live_sha" =~ ^[0-9a-f]{12}$ ]] || die "cannot read a commit from the live release name: $live_name"

printf 'live:   %s\n' "$live_name"
printf 'target: %s  %s\n' "$target_sha" "$(git -C "$SOURCE" log -1 --format='%cd  %s' --date=short "$target_commit")"

if [[ "$live_sha" == "$target_sha" ]]; then
  echo "$target_sha is already live; nothing to do."
  exit 0
fi
live_commit="$(git -C "$SOURCE" rev-parse --verify --quiet "${live_sha}^{commit}")" ||
  die "the live commit $live_sha is not in this checkout's history (a deploy branch that was never pushed?); deploy by hand"
if git -C "$SOURCE" merge-base --is-ancestor "$target_commit" "$live_commit"; then
  echo "$target_sha is already contained in the live release $live_sha; skipping (a newer deploy won)."
  exit 0
fi
git -C "$SOURCE" merge-base --is-ancestor "$live_commit" "$target_commit" ||
  die "$target_sha does not contain the live commit $live_sha; merge the live deploy branch into main first"

# ---------------------------------------------------------------------------------------------
# State and units, before anything is built.
[[ -d "$STATE" && ! -L "$STATE" && -f "$STATE/adminbot.sqlite" && ! -L "$STATE/adminbot.sqlite" ]] ||
  die "$STATE/adminbot.sqlite is missing or a symlink"
for marker in .adminbot-seed-pending .adminbot-sync-pending; do
  [[ ! -e "$STATE/$marker" ]] || die "an incomplete database operation ($marker) needs operator review"
done
for location in "$STATE" "$STATE/adminbot.sqlite"; do
  filesystem="$(stat -f -c %T -- "$location")"
  case "$filesystem" in
    ext2 | ext3 | ext4 | ext2/ext3 | xfs | btrfs | zfs | f2fs) ;;
    *)
      [[ "${AURORA_ACCEPT_NETWORK_STATE:-0}" == "1" ]] ||
        die "SQLite state is on $filesystem; move it to local storage, or set AURORA_ACCEPT_NETWORK_STATE=1 in the runner's environment on Aurora"
      printf 'warning: SQLite state is on %s (accepted by AURORA_ACCEPT_NETWORK_STATE)\n' "$filesystem" >&2
      ;;
  esac
done

for unit in "${RELEASE_UNITS[@]}"; do
  [[ -f "$UNIT_DIR/$unit" ]] || die "$UNIT_DIR/$unit is missing; run install-services by hand"
done
for unit in "${WRITER_UNITS[@]}"; do
  working_dir="$(systemctl --user show "$unit" -p WorkingDirectory --value)"
  [[ "$working_dir" == "$live_release" ]] ||
    die "$unit runs from $working_dir, not the live release; fix the units by hand first"
done

for script in deploy/aurora/install-user-services.sh deploy/aurora/install-member-sheet-poller.sh; do
  if ! git -C "$SOURCE" show "${target_commit}:openclaw-adminbot/${script}" | cmp -s - "$live_release/$script"; then
    die "$script changed since the live release; unit definitions need a manual deploy (aurora-adminbot-host.sh)"
  fi
done

free_mb="$(df -Pm -- "$ROOT" | awk 'NR==2 {print $4}')"
if [[ "$free_mb" =~ ^[0-9]+$ ]] && ((free_mb < MIN_FREE_MB)); then
  die "$ROOT has ${free_mb} MB free, below the ${MIN_FREE_MB} MB a release needs"
fi

# ---------------------------------------------------------------------------------------------
# Build beside the live release. The services keep running throughout.
new_release="$RELEASES/${target_sha}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -- "$new_release"
git -C "$SOURCE/openclaw-adminbot" archive --format=tar "$target_commit" | tar -x -C "$new_release"
if [[ -d "$live_release/node_modules" ]]; then
  echo "Reusing node_modules from $live_name"
  cp -al -- "$live_release/node_modules" "$new_release/node_modules" || {
    echo "warning: could not hardlink-copy node_modules; installing from scratch" >&2
    rm -rf -- "$new_release/node_modules"
  }
fi
(
  cd "$new_release"
  export npm_config_store_dir="$ROOT/.pnpm-store"
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
)
[[ -x "$new_release/node_modules/.bin/tsx" ]] || die "build finished without tsx"
[[ -f "$new_release/dist/entry.js" || -f "$new_release/dist/entry.mjs" ]] || die "build finished without dist/entry"
ln -sfn -- "$STATE" "$new_release/state"

# ---------------------------------------------------------------------------------------------
# Swap. A cancelled job must not leave the units half-rewritten, so interrupts are ignored from
# here until the swap (or its rollback) is complete.
trap '' INT TERM HUP
unit_backup="$(mktemp -d "$ROOT/.units.auto-deploy.XXXXXX")"
for unit in "${RELEASE_UNITS[@]}"; do
  cp -a -- "$UNIT_DIR/$unit" "$unit_backup/"
done

# These run as `if` conditions, where errexit is off, so every step is chained explicitly: a failure
# anywhere must reach the rollback below rather than stop half way.
point_current_at() {
  local next="${CURRENT}.next.$$"
  ln -sfn -- "$1" "$next" && mv -Tf -- "$next" "$CURRENT"
}

restart_writers() {
  systemctl --user daemon-reload &&
    systemctl --user stop jinesis-openclaw-gateway.service jinesis-adminbot.service &&
    point_current_at "$1" &&
    systemctl --user start jinesis-adminbot.service jinesis-openclaw-gateway.service
}

rewrite_units() {
  local unit
  for unit in "${RELEASE_UNITS[@]}"; do
    sed -i "s|${live_release}|${new_release}|g" "$UNIT_DIR/$unit" || return 1
  done
}

restore_units() {
  local unit
  for unit in "${RELEASE_UNITS[@]}"; do
    cp -a -- "$unit_backup/$unit" "$UNIT_DIR/$unit" || return 1
  done
}

probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$1$2" || true
}

# The same checks used by hand after every swap: public pages answer, protected routes demand
# auth (a 401 proves the service is up and still enforcing it), and the Gateway is healthy.
healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while ((SECONDS < deadline)); do
    if systemctl --user is-active --quiet jinesis-adminbot.service &&
      systemctl --user is-active --quiet jinesis-openclaw-gateway.service &&
      [[ "$(probe "$ADMINBOT_PORT" /adminbot)" == 200 ]] &&
      [[ "$(probe "$ADMINBOT_PORT" /deadlines)" == 200 ]] &&
      [[ "$(probe "$ADMINBOT_PORT" /lab/members)" == 401 ]] &&
      [[ "$(probe "$GATEWAY_PORT" /healthz)" == 200 ]]; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL_SECONDS"
  done
  printf 'health after %ss: /adminbot=%s /deadlines=%s /lab/members=%s gateway /healthz=%s\n' \
    "$HEALTH_TIMEOUT_SECONDS" "$(probe "$ADMINBOT_PORT" /adminbot)" "$(probe "$ADMINBOT_PORT" /deadlines)" \
    "$(probe "$ADMINBOT_PORT" /lab/members)" "$(probe "$GATEWAY_PORT" /healthz)" >&2
  return 1
}

swapped_at="$(date -u +%H:%M:%SZ)"
if rewrite_units && restart_writers "$new_release" && healthy; then
  rm -rf -- "$unit_backup"
  printf 'deployed %s at %s (previous: %s)\n' "$(basename -- "$new_release")" "$swapped_at" "$live_name"
else
  # From here the new release may be what `current` names, so it must survive the exit trap; it
  # stays for inspection and the next successful deploy prunes it.
  failed_release="$new_release"
  new_release=""
  echo "Release $(basename -- "$failed_release") failed to come up; rolling back to $live_name" >&2
  if restore_units && restart_writers "$live_release" && healthy; then
    rm -rf -- "$unit_backup"
    die "rolled back to $live_name; the failed build is at $failed_release (journalctl --user -u jinesis-adminbot)"
  fi
  die "ROLLBACK FAILED: check $CURRENT and the units by hand; unit backups are in $unit_backup"
fi
new_release_name="$(basename -- "$new_release")"
new_release=""
trap - INT TERM HUP

# ---------------------------------------------------------------------------------------------
# Prune to the newest KEEP_RELEASES releases, never touching the one now live or the one it
# replaced (the rollback target).
cd "$RELEASES"
[[ "$PWD" == "$RELEASES" ]] || die "releases resolved to $PWD"
kept=0
while IFS= read -r old; do
  [[ -n "$old" && "$old" != "$new_release_name" && "$old" != "$live_name" ]] || continue
  kept=$((kept + 1))
  ((kept < KEEP_RELEASES)) || rm -rf -- "$old"
done < <(ls -1t)
