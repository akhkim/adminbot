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
CACHE_DIR="${ADMINBOT_PAPERMENTOR_CACHE_DIR:-/var/lib/overleaf/ai-tutor-cache}"
[[ -d "$CACHE_DIR" ]] || {
  printf 'papermentor runs: %s is not a directory.\n' "$CACHE_DIR" >&2
  printf 'Set ADMINBOT_PAPERMENTOR_CACHE_DIR to the PaperMentor cache directory, or mount it here.\n' >&2
  exit 1
}

export NODE_ENV="${NODE_ENV:-production}"

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-papermentor-runs.ts" "$@"
