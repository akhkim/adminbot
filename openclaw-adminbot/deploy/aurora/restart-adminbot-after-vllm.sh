#!/usr/bin/env bash
set -euo pipefail

# A model upgrade must not revive a database writer while deployment is snapshotting state.
lock_dir="$HOME/.config/jinesis-adminbot/.writer.lock"
mkdir -p -- "$(dirname -- "$lock_dir")"
mkdir -m 700 -- "$lock_dir" 2>/dev/null || {
  echo 'Refusing to restart AdminBot: another writer operation holds the account lock.' >&2
  exit 1
}
lock_token="qwen-restart-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
if ! printf '%s\n' "$lock_token" >"$lock_dir/owner"; then
  rm -f -- "$lock_dir/owner"
  rmdir -- "$lock_dir"
  exit 1
fi

release_writer_lock() {
  status=$?
  trap - EXIT
  if [[ -f "$lock_dir/owner" && "$(cat "$lock_dir/owner")" == "$lock_token" ]]; then
    rm -- "$lock_dir/owner"
    rmdir -- "$lock_dir"
  else
    echo 'Warning: AdminBot writer lock needs operator review.' >&2
    status=1
  fi
  exit "$status"
}
trap release_writer_lock EXIT

systemctl --user try-restart jinesis-adminbot.service jinesis-openclaw-gateway.service
