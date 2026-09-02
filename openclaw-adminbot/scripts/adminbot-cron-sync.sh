#!/usr/bin/env bash
# Applies config/adminbot-cron.json to the gateway's cron store.
#
# Registration used to be a `pnpm openclaw cron add` block copied out of whichever doc happened to
# describe that feature. Three of the fourteen wrappers had one; the rest were registered by hand
# on the host and existed nowhere in the repo, so "what does AdminBot run, and when" could only be
# answered by reading the cron store on Aurora -- and a job that was never registered is silent:
# nobody is nudged and nothing errors.
#
# Idempotent. A job already in the store is edited to match the manifest rather than added twice,
# so this is safe to run on every deploy and is the intended way to change a schedule.
#
# Usage:
#   scripts/adminbot-cron-sync.sh [--dry-run] [--only <name>]
#
# It never removes a job the manifest does not mention. Deleting somebody's ad-hoc job because it
# is not in a file they have not read is not this script's call to make; it names them instead.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="$REPO_ROOT/config/adminbot-cron.json"

# Aurora keeps node and pnpm in ~/.local/bin, which a non-interactive ssh shell does not put on
# PATH. Every remote block in aurora-adminbot-host.sh exports this for the same reason; this script
# is meant to be runnable there too and was not, so it failed on every job with "pnpm: command not
# found" -- twenty-eight times, having already printed what it was about to do.
export PATH="$HOME/.local/bin:$PATH"

# `pnpm openclaw` goes through scripts/run-node.mjs, which rebuilds a stale dist before running --
# what you want on a working copy. A deployed release has no pnpm and needs no rebuild, so it falls
# back to the built entry point, which is the same one aurora-adminbot-host.sh invokes remotely.
if [[ -n "${OPENCLAW_BIN:-}" ]]; then
  OPENCLAW="$OPENCLAW_BIN"
elif command -v pnpm >/dev/null 2>&1; then
  OPENCLAW="pnpm openclaw"
elif [[ -f "$REPO_ROOT/openclaw.mjs" ]]; then
  OPENCLAW="node $REPO_ROOT/openclaw.mjs"
else
  printf 'adminbot-cron-sync: no pnpm on PATH and no %s/openclaw.mjs; set OPENCLAW_BIN\n' \
    "$REPO_ROOT" >&2
  exit 1
fi
DRY_RUN=0
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --only) ONLY="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf 'adminbot-cron-sync: unknown argument %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ -f "$MANIFEST" ]] || {
  printf 'adminbot-cron-sync: no manifest at %s\n' "$MANIFEST" >&2
  exit 1
}

# The store is read once. Asking the gateway per job turns a sixteen-job sync into sixteen round
# trips, and a partial answer halfway through would leave the set half-applied.
existing="$($OPENCLAW cron list --json 2>/dev/null || echo '[]')"

python3 - "$MANIFEST" "$REPO_ROOT" "$existing" "$DRY_RUN" "$ONLY" <<'PY' > /tmp/adminbot-cron-plan.$$
import json, shlex, sys

manifest_path, repo_root, existing_raw, dry_run, only = sys.argv[1:6]
manifest = json.load(open(manifest_path))

try:
    parsed = json.loads(existing_raw)
except json.JSONDecodeError:
    parsed = []
rows = parsed.get("jobs", parsed) if isinstance(parsed, dict) else parsed
known = {row.get("name") for row in rows if isinstance(row, dict)}

for job in manifest["jobs"]:
    name = job["name"]
    if only and name != only:
        continue
    # Paths are absolute in the store: cron runs from the gateway's cwd, not the repo's.
    argv = [part.replace("scripts/", f"{repo_root}/scripts/", 1) if part.startswith("scripts/") else part
            for part in job["argv"]]
    verb = "edit" if name in known else "add"
    args = [verb, "--name", name]
    if verb == "add":
        args += ["--description", job["description"]]
    args += [
        "--cron", job["cron"],
        "--command-argv", json.dumps(argv),
        "--command-cwd", repo_root,
        "--timeout-seconds", str(job.get("timeoutSeconds", 900)),
    ]
    if verb == "add":
        # Cron output belongs in the run history, not in somebody's DMs: these are sweeps whose
        # normal outcome is a one-line count nobody needs delivered.
        args.append("--no-deliver")
    print(f"{verb}\t{name}\t" + " ".join(shlex.quote(a) for a in args))

for name in sorted(known - {job["name"] for job in manifest["jobs"]}):
    print(f"unmanaged\t{name}\t")
PY

status=0
# The plan is read on fd 3, and every command gets its stdin from /dev/null.
#
# Both halves matter. `openclaw cron add` reads stdin -- it prints prompts and notices through a
# TUI -- so on the first iteration it swallowed the entire remaining plan, and the rest of the jobs
# were never registered: they were echoed to the terminal as the CLI drained them. One job in
# eighteen landed, and the run still exited 0.
while IFS=$'\t' read -r verb name args <&3; do
  case "$verb" in
    unmanaged)
      printf 'adminbot-cron-sync: %s is in the store but not in the manifest — left alone\n' "$name"
      ;;
    add|edit)
      if [[ "$DRY_RUN" == "1" ]]; then
        printf 'adminbot-cron-sync: would %s %s\n' "$verb" "$name"
        continue
      fi
      printf 'adminbot-cron-sync: %s %s\n' "$verb" "$name"
      # shellcheck disable=SC2086
      if ! eval "$OPENCLAW cron $args" </dev/null; then
        printf 'adminbot-cron-sync: %s failed for %s\n' "$verb" "$name" >&2
        status=1
      fi
      ;;
  esac
done 3< /tmp/adminbot-cron-plan.$$
rm -f /tmp/adminbot-cron-plan.$$

exit "$status"
