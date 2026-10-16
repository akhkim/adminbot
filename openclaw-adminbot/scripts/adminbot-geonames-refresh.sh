#!/usr/bin/env bash
# Installs or refreshes the offline city table that "Use my precise location" reads
# (ADMINBOT_GEONAMES_DIR; see docs/tools/adminbot-geoip.md).
#
# Downloads GeoNames' "cities1000" extract (every populated place of 1000 people or more, CC BY 4.0
# -- the member map shows the credit the licence asks for) and its first-level region names, checks
# both, and renames them into place only then. A failed or partial download never replaces the files
# the service is reading: the new copies are written beside the destination and renamed over the
# old ones, which is atomic on one filesystem, and the service reloads on cities1000.txt's changed
# mtime without a restart. admin1CodesASCII.txt goes first, so a reload never pairs new cities with
# missing regions.
#
#   bash scripts/adminbot-geonames-refresh.sh [destination directory]
#
# The destination is the argument, else ADMINBOT_GEONAMES_DIR from the AdminBot env file; with
# neither set it reports a skip and exits 0.
#
# ADMINBOT_GEONAMES_BASE_URL and ADMINBOT_GEONAMES_MIN_ROWS exist for the test, which serves a
# synthetic extract from a file:// directory; nothing in production sets them.
set -euo pipefail

LABEL="geonames refresh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

destination="${1:-}"
if [[ -z "$destination" ]]; then
  # shellcheck source=scripts/lib/adminbot-cron-env.sh
  . "$SCRIPT_DIR/lib/adminbot-cron-env.sh"
  adminbot_load_cron_env "$LABEL" || exit 1
  destination="${ADMINBOT_GEONAMES_DIR:-}"
  if [[ -z "$destination" ]]; then
    printf '%s: skipped -- ADMINBOT_GEONAMES_DIR is not set in %s\n' "$LABEL" "$ADMINBOT_ENV_FILE"
    exit 0
  fi
fi

base_url="${ADMINBOT_GEONAMES_BASE_URL:-https://download.geonames.org/export/dump}"
# The real extract has well over 100k rows; a much shorter file is a truncated or wrong download.
min_rows="${ADMINBOT_GEONAMES_MIN_ROWS:-100000}"

mkdir -p "$destination"
# Temporaries live beside the destination so the final renames never cross a filesystem.
workdir="$(mktemp -d "$destination/.geonames-refresh.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

fetch() {
  if ! curl --fail --silent --show-error --location --max-time 900 \
    --output "$workdir/$1" "$base_url/$1" 2>"$workdir/curl.err"; then
    printf '%s: %s/%s not available (%s); kept the current files\n' \
      "$LABEL" "$base_url" "$1" "$(tr -d '\n' <"$workdir/curl.err")" >&2
    exit 1
  fi
}

fetch cities1000.zip
fetch admin1CodesASCII.txt

# unzip where the host has it, else Python's zipfile; either way only the one member is read.
if command -v unzip >/dev/null 2>&1; then
  unzip -p "$workdir/cities1000.zip" cities1000.txt >"$workdir/cities1000.txt" 2>"$workdir/unzip.err" || true
elif command -v python3 >/dev/null 2>&1; then
  python3 -I -c 'import sys, zipfile; sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read("cities1000.txt"))' \
    "$workdir/cities1000.zip" >"$workdir/cities1000.txt" 2>"$workdir/unzip.err" || true
else
  printf '%s: neither unzip nor python3 is installed; kept the current files\n' "$LABEL" >&2
  exit 1
fi

# Every row is 19 tab-separated columns; count only the rows that are, so an HTML error page or a
# truncated file cannot pass on its line count alone.
rows="$(awk -F '\t' 'NF == 19 {n++} END {print n + 0}' "$workdir/cities1000.txt")"
if ((rows < min_rows)); then
  printf '%s: cities1000.txt has %s well-formed rows (expected at least %s); kept the current files\n' \
    "$LABEL" "$rows" "$min_rows" >&2
  exit 1
fi
regions="$(awk -F '\t' 'NF >= 2 && $1 ~ /^[A-Z][A-Z]\./ {n++} END {print n + 0}' "$workdir/admin1CodesASCII.txt")"
if ((regions == 0)); then
  printf '%s: admin1CodesASCII.txt has no region rows; kept the current files\n' "$LABEL" >&2
  exit 1
fi

chmod 0644 "$workdir/cities1000.txt" "$workdir/admin1CodesASCII.txt"
mv -f "$workdir/admin1CodesASCII.txt" "$destination/admin1CodesASCII.txt"
mv -f "$workdir/cities1000.txt" "$destination/cities1000.txt"
printf '%s: installed %s places and %s regions at %s\n' "$LABEL" "$rows" "$regions" "$destination"
