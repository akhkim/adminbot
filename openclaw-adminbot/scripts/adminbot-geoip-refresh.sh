#!/usr/bin/env bash
# Installs or refreshes the local IP-to-city database that sign-in geolocation reads
# (ADMINBOT_GEOIP_MMDB_PATH; see docs/tools/adminbot-geoip.md).
#
# Downloads DB-IP's free "IP to City Lite" database (CC BY 4.0 -- the member map shows the credit
# the licence asks for) for the current month, or the previous month's when the current one is not
# published yet, and swaps it into place only after it has been gunzipped and opened as a city
# database. A failed or partial download never replaces the file the service is reading: the new
# copy is written next to the destination and renamed over it, which is atomic on one filesystem,
# and the service picks it up by its changed mtime without a restart.
#
#   bash scripts/adminbot-geoip-refresh.sh [destination.mmdb]
#
# The destination is the argument, else ADMINBOT_GEOIP_MMDB_PATH from the AdminBot env file. Under
# cron with neither set it reports a skip and exits 0, so registering the job before the database is
# configured does not show a failing run every month.
#
# ADMINBOT_GEOIP_BASE_URL and ADMINBOT_GEOIP_MONTH exist for the test, which serves a synthetic
# database from a file:// directory; nothing in production sets them.
set -euo pipefail

LABEL="geoip refresh"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

destination="${1:-}"
if [[ -z "$destination" ]]; then
  # shellcheck source=scripts/lib/adminbot-cron-env.sh
  . "$SCRIPT_DIR/lib/adminbot-cron-env.sh"
  adminbot_load_cron_env "$LABEL" || exit 1
  destination="${ADMINBOT_GEOIP_MMDB_PATH:-}"
  if [[ -z "$destination" ]]; then
    printf '%s: skipped -- ADMINBOT_GEOIP_MMDB_PATH is not set in %s\n' "$LABEL" "$ADMINBOT_ENV_FILE"
    exit 0
  fi
fi

base_url="${ADMINBOT_GEOIP_BASE_URL:-https://download.db-ip.com/free}"
month="${ADMINBOT_GEOIP_MONTH:-$(date -u +%Y-%m)}"
if [[ ! "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  printf '%s: month must be YYYY-MM, got %q\n' "$LABEL" "$month" >&2
  exit 1
fi

previous_month() {
  local year="${1%-*}" mon="${1#*-}"
  mon=$((10#$mon - 1))
  if ((mon == 0)); then
    mon=12
    year=$((year - 1))
  fi
  printf '%04d-%02d' "$year" "$mon"
}

destination_dir="$(dirname "$destination")"
mkdir -p "$destination_dir"
# Temporaries live beside the destination so the final rename never crosses a filesystem.
workdir="$(mktemp -d "$destination_dir/.geoip-refresh.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

downloaded=""
for candidate in "$month" "$(previous_month "$month")"; do
  url="$base_url/dbip-city-lite-$candidate.mmdb.gz"
  if curl --fail --silent --show-error --location --max-time 900 \
    --output "$workdir/city.mmdb.gz" "$url" 2>"$workdir/curl.err"; then
    downloaded="$candidate"
    break
  fi
  printf '%s: %s not available (%s)\n' "$LABEL" "$url" "$(tr -d '\n' <"$workdir/curl.err")" >&2
done
if [[ -z "$downloaded" ]]; then
  printf '%s: no database for %s or the month before; kept the current file\n' "$LABEL" "$month" >&2
  exit 1
fi

if ! gzip -t "$workdir/city.mmdb.gz" 2>/dev/null; then
  printf '%s: dbip-city-lite-%s.mmdb.gz is not a valid gzip file; kept the current file\n' \
    "$LABEL" "$downloaded" >&2
  exit 1
fi
gzip -dc "$workdir/city.mmdb.gz" >"$workdir/city.mmdb"

# Open it with the same reader the service uses, and insist on a city database: a country-only
# file would open fine and quietly turn every city pin back into a country.
if ! (cd "$REPO_ROOT" && node -e '
  const fs = require("node:fs");
  const { Reader } = require("mmdb-lib");
  const reader = new Reader(fs.readFileSync(process.argv[1]));
  const type = String(reader.metadata.databaseType || "");
  if (!/city/i.test(type)) {
    throw new Error(`not a city database: ${type || "no database_type"}`);
  }
  reader.get("1.1.1.1");
' "$workdir/city.mmdb" 2>"$workdir/open.err"); then
  printf '%s: dbip-city-lite-%s.mmdb does not open as a city database (%s); kept the current file\n' \
    "$LABEL" "$downloaded" "$(tail -n 1 "$workdir/open.err")" >&2
  exit 1
fi

chmod 0644 "$workdir/city.mmdb"
mv -f "$workdir/city.mmdb" "$destination"
printf '%s: installed dbip-city-lite-%s at %s (%s bytes)\n' \
  "$LABEL" "$downloaded" "$destination" "$(wc -c <"$destination" | tr -d ' ')"
