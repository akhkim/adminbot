#!/usr/bin/env bash
# Make sure sign-in geolocation is on: install the DB-IP City Lite database and point the service at
# it, and trust the tunnel's forwarded client address so a sign-in is located at the member rather
# than at the proxy.
#
# Run by auto-deploy.sh after a release has built and before the swap, so the restart that follows
# picks up whatever this changes. Safe to run by hand as well:
#
#   bash deploy/aurora/install-geoip.sh --root <deployment root> --release <release dir> [--env-file <path>]
#
# What it does, and why each step is shaped the way it is:
#
#   - The database lives at <root>/geoip/dbip-city-lite.mmdb, beside the releases, so every release
#     reads the same file and a deploy never has to copy 130 MB. The download is the existing
#     scripts/adminbot-geoip-refresh.sh, which only renames a file into place after it has gunzipped
#     and opened as a city database, so a bad download never replaces a good file.
#   - A database younger than GEOIP_MAX_AGE_DAYS is kept as it is: the monthly cron job
#     (adminbot-geoip-refresh) keeps it current, and a deploy does not need to re-download it.
#   - The env file the unit actually reads is asked of systemd, not assumed, and only a *missing*
#     key is appended. An operator's own value -- including an explicit ADMINBOT_TRUST_PROXY=0 or a
#     different database path -- is never rewritten.
#   - Nothing here fails the deploy. A download failure leaves the service exactly as it was (still
#     off if it was off), so blocking a code release on db-ip.com being reachable would trade a
#     working deploy for nothing. It is loud instead: every failure is printed as a GitHub Actions
#     `::warning::` annotation, which shows on the run summary, and the workflow's next step reads
#     the service's own startup line and warns again if geolocation is still off.
set -euo pipefail

ROOT=""
RELEASE=""
ENV_FILE=""
GEOIP_MAX_AGE_DAYS="${GEOIP_MAX_AGE_DAYS:-32}"

warn() {
  # Plain stderr for a terminal, and an annotation the Actions run summary shows.
  printf 'warning: geoip: %s\n' "$*" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::warning title=IP geolocation::%s\n' "$*"
  fi
}

while (($# > 0)); do
  case "$1" in
    --root)
      ROOT="${2:?--root requires a value}"
      shift 2
      ;;
    --release)
      RELEASE="${2:?--release requires a value}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
[[ -n "$ROOT" && -n "$RELEASE" ]] || {
  printf 'usage: %s --root <deployment root> --release <release dir> [--env-file <path>]\n' "$0" >&2
  exit 2
}

if [[ -z "$ENV_FILE" ]]; then
  # "EnvironmentFiles=/path (ignore_errors=no)"; the first one is the AdminBot env file.
  ENV_FILE="$(systemctl --user show jinesis-adminbot.service -p EnvironmentFiles --value 2>/dev/null |
    awk 'NR==1 {print $1}')"
fi
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  warn "could not find the AdminBot env file (got '${ENV_FILE:-nothing}'); IP geolocation left as it was"
  exit 0
fi

# The value the env file sets for a key, or nothing. Last assignment wins, as it does for systemd.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Append KEY=VALUE when the file does not set KEY at all. Never edits an existing line.
ensure_env_default() {
  local key="$1" value="$2"
  if grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"; then
    printf 'geoip: %s already set in %s; left as it is\n' "$key" "$ENV_FILE"
    return 0
  fi
  {
    printf '\n# Added by deploy/aurora/install-geoip.sh on %s\n' "$(date -u +%Y-%m-%d)"
    printf '%s=%s\n' "$key" "$value"
  } >>"$ENV_FILE"
  printf 'geoip: set %s in %s\n' "$key" "$ENV_FILE"
}

# 1. The tunnel. The service only listens on loopback, so every outside request reaches it through
#    cloudflared; without this every sign-in is located at 127.0.0.1, which is never looked up, and
#    nothing is recorded. remoteIp() reads the address Cloudflare itself added, so a client cannot
#    choose its own by sending the header.
ensure_env_default ADMINBOT_TRUST_PROXY 1

# 2. The database.
mmdb="$(env_value ADMINBOT_GEOIP_MMDB_PATH)"
if [[ -z "$mmdb" ]]; then
  mmdb="$ROOT/geoip/dbip-city-lite.mmdb"
fi
fresh=""
if [[ -s "$mmdb" ]] && [[ -n "$(find "$mmdb" -mtime "-$GEOIP_MAX_AGE_DAYS" -print 2>/dev/null)" ]]; then
  fresh=1
  printf 'geoip: %s is under %s days old; kept\n' "$mmdb" "$GEOIP_MAX_AGE_DAYS"
fi
if [[ -z "$fresh" ]]; then
  if ! (cd "$RELEASE" && bash scripts/adminbot-geoip-refresh.sh "$mmdb"); then
    if [[ -s "$mmdb" ]]; then
      warn "refreshing $mmdb failed; the service keeps the older copy"
    else
      warn "downloading the DB-IP City Lite database failed; sign-in geolocation stays OFF until scripts/adminbot-geoip-refresh.sh succeeds"
      exit 0
    fi
  fi
fi

# Only point the service at a file that exists: a path to nothing would make the service log a
# provider that answers nothing.
if [[ -s "$mmdb" ]]; then
  ensure_env_default ADMINBOT_GEOIP_MMDB_PATH "$mmdb"
fi
