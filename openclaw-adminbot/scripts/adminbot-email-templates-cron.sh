#!/usr/bin/env bash
# Weekly check that the email-template Google Doc and the shipped copy still say the same thing.
#
# Check-only, and deliberately so. The doc is where the templates are written and reviewed, so it
# is ahead of the code by design for as long as it takes somebody to fold an edit in; what must not
# happen is that nobody notices. Exits non-zero on any difference, which shows the run red in the
# Control UI's Cron tab with the diff in its output -- that is the whole notification.
#
# It never writes emails.ts. The doc is a working document: it has carried a half-finished sentence
# and a literal ([LINK]) in an approved template, and an unattended writer would have mailed both to
# applicants. A person reads the diff and makes the edit.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "email template check" || exit 1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TSX_BIN="$REPO_ROOT/node_modules/.bin/tsx"
[[ -x "$TSX_BIN" ]] || {
  printf 'email template check: tsx is missing; run pnpm install in %s\n' "$REPO_ROOT" >&2
  exit 1
}

# The doc read goes through gog, which needs the account the guidebook sync uses. Named here rather
# than defaulted inside the script so a missing token reads as configuration, not as a parse error.
if [[ -z "${GOG_ACCOUNT:-}" ]]; then
  printf 'email template check: GOG_ACCOUNT is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
fi

exec "$TSX_BIN" "$REPO_ROOT/scripts/adminbot-email-templates-sync.ts"
