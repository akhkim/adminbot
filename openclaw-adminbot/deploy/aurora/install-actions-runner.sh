#!/usr/bin/env bash
# Install the GitHub Actions runner that deploys AdminBot on Aurora, as a systemd user service.
#
# Run on Aurora as the service account, from a checkout or release of this repository. The
# registration token is read from stdin so it never lands in shell history or a process list:
#
#   gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token -q .token |
#     ssh aurora 'bash -l ~/services/openclaw-adminbot/current/deploy/aurora/install-actions-runner.sh \
#       --repo <owner>/<repo> --root /w/406/adminbot --accept-network-state'
#
# The token expires an hour after it is issued. Re-running replaces the registration in place.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

RUNNER_VERSION="2.337.0"
RUNNER_SHA256="70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
RUNNER_LABEL="aurora-deploy"
WORKFLOW_PATH=".github/workflows/deploy-aurora.yaml"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY=""
DEPLOY_ROOT=""
RUNNER_DIR="$HOME/actions-runner"
WORK_DIR=""
ACCEPT_NETWORK_STATE="0"
UNIT="jinesis-actions-runner.service"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --repo)
      (($# >= 2)) || die "--repo requires <owner>/<repo>"
      REPOSITORY="$2"
      shift 2
      ;;
    --root)
      (($# >= 2)) || die "--root requires a value"
      DEPLOY_ROOT="${2%/}"
      shift 2
      ;;
    --runner-dir)
      (($# >= 2)) || die "--runner-dir requires a value"
      RUNNER_DIR="${2%/}"
      shift 2
      ;;
    --work-dir)
      (($# >= 2)) || die "--work-dir requires a value"
      WORK_DIR="${2%/}"
      shift 2
      ;;
    --accept-network-state)
      ACCEPT_NETWORK_STATE="1"
      shift
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo <owner>/<repo> is required"
[[ "$DEPLOY_ROOT" == /* ]] || die "--root <absolute path> is required"
# The runner's checkout is the whole repository; keep it off the routinely full home volume.
WORK_DIR="${WORK_DIR:-$DEPLOY_ROOT/runner-work}"
[[ ! -t 0 ]] || die "pipe the registration token on stdin"
IFS= read -r token || true
[[ -n "$token" ]] || die "no registration token on stdin"

guard_source="$SCRIPT_DIR/runner-job-guard.sh"
[[ -f "$guard_source" ]] || die "missing $guard_source"
command -v systemctl >/dev/null || die "systemd is required"
systemctl --user show-environment >/dev/null || die "user systemd is unavailable"

mkdir -p -- "$RUNNER_DIR" "$WORK_DIR"
chmod 700 -- "$RUNNER_DIR" "$WORK_DIR"

if [[ ! -x "$RUNNER_DIR/config.sh" || "$(cat "$RUNNER_DIR/.installed-version" 2>/dev/null)" != "$RUNNER_VERSION" ]]; then
  tarball="$(mktemp "${TMPDIR:-/tmp}/actions-runner.XXXXXX.tar.gz")"
  trap 'rm -f -- "$tarball"' EXIT
  curl --fail --location --silent --show-error --retry 3 \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz" \
    --output "$tarball"
  printf '%s  %s\n' "$RUNNER_SHA256" "$tarball" | sha256sum --check --status ||
    die "runner download does not match the pinned checksum"
  tar -xzf "$tarball" -C "$RUNNER_DIR"
  printf '%s\n' "$RUNNER_VERSION" >"$RUNNER_DIR/.installed-version"
fi

# Stop a previous install before re-registering it.
systemctl --user stop "$UNIT" 2>/dev/null || true
if [[ -f "$RUNNER_DIR/.runner" ]]; then
  (cd "$RUNNER_DIR" && ./config.sh remove --token "$token") ||
    printf 'warning: could not remove the previous registration; replacing it\n' >&2
fi

(
  cd "$RUNNER_DIR"
  ./config.sh --unattended --replace \
    --url "https://github.com/${REPOSITORY}" \
    --token "$token" \
    --name "aurora-$(hostname -s)" \
    --labels "$RUNNER_LABEL" \
    --no-default-labels \
    --work "$WORK_DIR"
)

# The guard, with the allowed values written into it (see the file for why).
mkdir -p -- "$RUNNER_DIR/hooks"
sed \
  -e "s|__ALLOWED_REPOSITORY__|${REPOSITORY}|" \
  -e "s|__ALLOWED_WORKFLOW_REF__|${REPOSITORY}/${WORKFLOW_PATH}@refs/heads/main|" \
  "$guard_source" >"$RUNNER_DIR/hooks/job-started.sh"
chmod 500 "$RUNNER_DIR/hooks/job-started.sh"

# The runner reads .env at startup. config.sh writes LANG and PATH there; replace the lines this
# installer owns and keep the rest.
env_file="$RUNNER_DIR/.env"
touch "$env_file"
grep -vE '^(ACTIONS_RUNNER_HOOK_JOB_STARTED|AURORA_DEPLOY_ROOT|AURORA_ACCEPT_NETWORK_STATE)=' "$env_file" >"$env_file.new" || true
{
  printf 'ACTIONS_RUNNER_HOOK_JOB_STARTED=%s\n' "$RUNNER_DIR/hooks/job-started.sh"
  printf 'AURORA_DEPLOY_ROOT=%s\n' "$DEPLOY_ROOT"
  printf 'AURORA_ACCEPT_NETWORK_STATE=%s\n' "$ACCEPT_NETWORK_STATE"
} >>"$env_file.new"
mv -f -- "$env_file.new" "$env_file"
chmod 600 "$env_file"

unit_dir="$HOME/.config/systemd/user"
mkdir -p -- "$unit_dir"
cat >"$unit_dir/$UNIT" <<EOF
[Unit]
Description=GitHub Actions runner that deploys AdminBot (${REPOSITORY})
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$RUNNER_DIR
ExecStart=$RUNNER_DIR/run.sh
Restart=always
RestartSec=15
# A deploy in progress gets time to finish its swap or rollback before the runner is stopped.
KillMode=process
KillSignal=SIGTERM
TimeoutStopSec=10min
UMask=0077

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
systemctl --user --no-pager status "$UNIT" | head -5

linger="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
[[ "$linger" == "yes" ]] ||
  printf 'warning: lingering is off; the runner stops at logout. Ask CSLab: loginctl enable-linger %s\n' "$USER" >&2
printf 'runner installed: label=%s work=%s root=%s accept_network_state=%s\n' \
  "$RUNNER_LABEL" "$WORK_DIR" "$DEPLOY_ROOT" "$ACCEPT_NETWORK_STATE"
