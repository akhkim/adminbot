#!/usr/bin/env bash
# Make sure "Use my precise location" can name a city: install GeoNames' cities1000 extract and
# point the service at it.
#
# Run by auto-deploy.sh after a release has built and before the swap, so the restart that follows
# picks up whatever this changes. Safe to run by hand as well:
#
#   bash deploy/aurora/install-geonames.sh --root <deployment root> --release <release dir> [--env-file <path>]
#
# Shaped like install-geoip.sh, for the same reasons:
#
#   - The table lives at <root>/geonames/, beside the releases, so every release reads the same
#     files. The download is scripts/adminbot-geonames-refresh.sh, which only renames files into
#     place after they have checked out, so a bad download never replaces a good table.
#   - A table younger than GEONAMES_MAX_AGE_DAYS is kept as it is. Cities do not move; a deploy a
#     season apart refreshing it is plenty.
#   - Only a *missing* ADMINBOT_GEONAMES_DIR is appended to the env file the unit reads; an
#     operator's own value is never rewritten.
#   - Nothing here fails the deploy. Without the table the button answers "couldn't find a city"
#     and the map falls back to the other sources, so a download failure is a ::warning::, not a
#     blocked release.
set -euo pipefail

ROOT=""
RELEASE=""
ENV_FILE=""
GEONAMES_MAX_AGE_DAYS="${GEONAMES_MAX_AGE_DAYS:-90}"

warn() {
  printf 'warning: geonames: %s\n' "$*" >&2
  if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
    printf '::warning title=Device location::%s\n' "$*"
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
  ENV_FILE="$(systemctl --user show jinesis-adminbot.service -p EnvironmentFiles --value 2>/dev/null |
    awk 'NR==1 {print $1}')"
fi
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  warn "could not find the AdminBot env file (got '${ENV_FILE:-nothing}'); device location left as it was"
  exit 0
fi

env_value() {
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

dir="$(env_value ADMINBOT_GEONAMES_DIR)"
if [[ -z "$dir" ]]; then
  dir="$ROOT/geonames"
fi
cities="$dir/cities1000.txt"
fresh=""
if [[ -s "$cities" ]] && [[ -n "$(find "$cities" -mtime "-$GEONAMES_MAX_AGE_DAYS" -print 2>/dev/null)" ]]; then
  fresh=1
  printf 'geonames: %s is under %s days old; kept\n' "$cities" "$GEONAMES_MAX_AGE_DAYS"
fi
if [[ -z "$fresh" ]]; then
  if ! (cd "$RELEASE" && bash scripts/adminbot-geonames-refresh.sh "$dir"); then
    if [[ -s "$cities" ]]; then
      warn "refreshing $dir failed; the service keeps the older table"
    else
      warn "downloading GeoNames cities1000 failed; \"Use my precise location\" cannot name a city until scripts/adminbot-geonames-refresh.sh succeeds"
      exit 0
    fi
  fi
fi

# Only point the service at a table that exists.
if [[ -s "$cities" ]] && ! grep -Eq "^[[:space:]]*ADMINBOT_GEONAMES_DIR=" "$ENV_FILE"; then
  {
    printf '\n# Added by deploy/aurora/install-geonames.sh on %s\n' "$(date -u +%Y-%m-%d)"
    printf 'ADMINBOT_GEONAMES_DIR=%s\n' "$dir"
  } >>"$ENV_FILE"
  printf 'geonames: set ADMINBOT_GEONAMES_DIR in %s\n' "$ENV_FILE"
fi
