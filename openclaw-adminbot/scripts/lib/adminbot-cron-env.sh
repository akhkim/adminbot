# Sourced by the AdminBot cron wrappers. Loads the secrets env file into the environment.
#
# The cron jobs are created locally and synced to Aurora (docs/tools/adminbot-openreview.md), so one
# script runs on both hosts and has to find the secrets on both: the deploy host keeps them in the
# config dir the systemd units point at, a dev checkout in the ~/.openclaw/.env that
# start-adminbot.mjs already loads. Take the first that exists; ADMINBOT_ENV_FILE pins one
# explicitly. Secrets stay out of the cron spec, which is stored in the database and rendered in the
# Control UI's Cron tab.
#
# Sets ADMINBOT_ENV_FILE to the file it loaded. Callers pass a label used in the error message.
adminbot_load_cron_env() {
  local label="$1"
  local candidates=("$HOME/.config/jinesis-adminbot/adminbot.env" "$HOME/.openclaw/.env")
  if [[ -n "${ADMINBOT_ENV_FILE:-}" ]]; then
    candidates=("$ADMINBOT_ENV_FILE")
  fi
  local candidate
  for candidate in "${candidates[@]}"; do
    [[ -f "$candidate" ]] || continue
    set -a
    # shellcheck disable=SC1090
    . "$candidate"
    set +a
    ADMINBOT_ENV_FILE="$candidate"
    return 0
  done
  printf '%s: env file not found: %s\n' "$label" "${candidates[*]}" >&2
  return 1
}
