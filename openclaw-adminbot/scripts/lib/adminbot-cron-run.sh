#!/usr/bin/env bash
# Runs one cron job and reports how it went to the automation health check.
#
#   adminbot-cron-run.sh <job-name> <cron-expression> -- <argv...>
#
# scripts/adminbot-cron-sync.sh puts this in front of every job in config/adminbot-cron.json, so
# no wrapper has to remember to report. The job's output and exit code pass through unchanged --
# the run list stays what it was -- and the report is best-effort: a service that is down must not
# turn every job red, and the health check notices the missing heartbeats anyway.
#
# The schedule travels with the heartbeat so the service can tell "quiet because it is Sunday"
# from "quiet because it stopped" without reading this repo's manifest. The failure detail is the
# last line the job wrote to stderr, with anything shaped like a credential removed.
#
# The heartbeat also carries how long the run took and, when the job counted anything, its counters:
# a job may append `name<TAB>count` lines to $ADMINBOT_RUN_METRICS_FILE (the email automation counts
# messages per category and status there). Counters only -- the service drops any line that is not
# a short name and a non-negative integer, so nothing a job writes there can reach the admin page
# as text.
set -uo pipefail

job="${1:?job name}"
cron="${2:?cron expression}"
shift 2
[[ "${1:-}" == "--" ]] && shift

errlog="$(mktemp)"
metrics="$(mktemp)"
trap 'rm -f "$errlog" "$metrics"' EXIT

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
started_ms="$(now_ms)"
ADMINBOT_RUN_METRICS_FILE="$metrics" "$@" 2> >(tee "$errlog" >&2)
status=$?
wait
duration_ms=$(($(now_ms) - started_ms))

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/adminbot-cron-env.sh"
if adminbot_load_cron_env "cron heartbeat" 2>/dev/null && [[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]]; then
  detail=""
  if [[ "$status" -ne 0 ]]; then
    # Node's own warnings are skipped: one printed after the real error, and its
    # "(Use `node --trace-warnings ...`)" hint, otherwise became the reported failure.
    detail="$(grep -v -E '^[[:space:]]*$|^\(node:[0-9]+\) |^\(Use `node --trace-' "$errlog" |
      tail -n 1 | cut -c1-300 |
      # A bare word after "token" is usually the error ("token has been expired or revoked"), so
      # only Bearer values and key=value / key: value pairs are treated as credentials.
      sed -E 's/(Bearer)[ ]+[^ ]+/\1 [redacted]/Ig; s/(token|secret|password|key)[ ]*[=:][ ]*[^ ]+/\1 [redacted]/Ig; s/xox[abprs]-[A-Za-z0-9-]+/[redacted]/g; s/ya29\.[A-Za-z0-9._-]+/[redacted]/g; s/sk-[A-Za-z0-9_-]{16,}/[redacted]/g')"
  fi
  body="$(JOB="$job" CRON="$cron" STATUS="$status" DETAIL="$detail" DURATION="$duration_ms" \
    METRICS="$metrics" python3 -c '
import json, os, re
status = int(os.environ["STATUS"])
counts = {}
try:
    with open(os.environ["METRICS"], encoding="utf-8", errors="replace") as lines:
        for line in lines:
            name, _, value = line.rstrip("\n").partition("\t")
            if re.fullmatch(r"[a-z][a-z0-9_.:-]{0,63}", name) and re.fullmatch(r"[0-9]{1,12}", value):
                counts[name] = counts.get(name, 0) + int(value)
except OSError:
    pass
body = {"job": os.environ["JOB"], "cron": os.environ["CRON"], "ok": status == 0,
        "exit_code": status, "detail": os.environ["DETAIL"],
        "duration_ms": max(0, int(os.environ["DURATION"]))}
if counts:
    body["metrics"] = dict(sorted(counts.items())[:40])
print(json.dumps(body))')"
  curl --silent --output /dev/null --max-time 10 \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$body" \
    "http://127.0.0.1:${ADMINBOT_PORT:-8765}/automation/health/heartbeat" ||
    printf 'cron heartbeat: could not report %s to the service\n' "$job" >&2
fi

exit "$status"
