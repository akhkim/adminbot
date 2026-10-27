#!/usr/bin/env bash
# One pass of the PaperMentor review collector, shaped for an OpenClaw cron job.
#
# Reads the reviews PaperMentor cached on the Overleaf host and reports the counting half of each
# to AdminBot, which is what turns "the author ticked a box" into "the reviewer said so". The
# comments themselves never leave that machine -- see contracts/papermentor.ts.
#
# Safe to run as often as you like: a review is identified by its project and the instant it ran,
# so re-reading the same cached file records nothing new.
#
# Where it runs is a deployment choice. On the Overleaf host, point ADMINBOT_URL at the AdminBot
# service; on the AdminBot host, mount or sync the cache directory and leave ADMINBOT_URL unset so
# it posts to loopback.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "papermentor runs" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'papermentor runs: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'papermentor runs: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

# Named before any work happens: the cache directory is the one piece of configuration this pass
# cannot run without, and a missing one should say so rather than read as "no reviews today".
# One line, naming whether the path was configured or is the built-in default (the Overleaf
# host's own path, which an AdminBot host only has if the cache is mounted there). A directory this
# user cannot list is the same failure: the walk would otherwise die on it with a bare EACCES.
if [[ -n "${ADMINBOT_PAPERMENTOR_CACHE_DIR:-}" ]]; then
  CACHE_DIR="$ADMINBOT_PAPERMENTOR_CACHE_DIR"
  CACHE_SOURCE="from ADMINBOT_PAPERMENTOR_CACHE_DIR"
else
  CACHE_DIR="/var/lib/overleaf/ai-tutor-cache"
  CACHE_SOURCE="the default: ADMINBOT_PAPERMENTOR_CACHE_DIR is not set in $ADMINBOT_ENV_FILE or the environment"
fi
if [[ ! -d "$CACHE_DIR" ]]; then
  problem="is not a directory"
elif [[ ! -r "$CACHE_DIR" || ! -x "$CACHE_DIR" ]]; then
  problem="is not readable by $(id -un)"
else
  problem=""
fi
[[ -z "$problem" ]] || {
  printf 'papermentor runs: PaperMentor cache %s %s (%s); set ADMINBOT_PAPERMENTOR_CACHE_DIR to the cache directory mounted or synced from the Overleaf host, or run this job there\n' \
    "$CACHE_DIR" "$problem" "$CACHE_SOURCE" >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-papermentor-runs.ts" "$@"
