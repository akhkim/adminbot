#!/usr/bin/env bash
# Snapshot of decisions, presentation, titles, review scores and meta-reviews on the PI's own
# OpenReview submissions, every six hours, for the paper OpenReview sync and the paper sheet export
# to read. Needs OPENREVIEW_USERNAME / OPENREVIEW_PASSWORD (the PI's login) in the env file.
#
# The export runs as a different Unix user that has no OpenReview login, so it never calls
# OpenReview itself: this job, which already holds the credentials, writes one JSON file next to
# the database (group-readable through the setgid state directory) and the export reads it. The
# file is replaced atomically and only when the bridge answered ok, so a failed pass leaves the
# previous snapshot in place instead of blanking the sheet's OpenReview column.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "openreview results" || exit 1

TARGET="${ADMINBOT_OPENREVIEW_RESULTS_JSON:-$(dirname "${ADMINBOT_DB_PATH:-$HOME/.openclaw/state/adminbot.sqlite}")/openreview-author-results.json}"
PYTHON="${ADMINBOT_PYTHON:-/usr/bin/python3}"
# openreview-py is installed by deploy/aurora/install-user-services.sh into this directory, not into
# the interpreter's site-packages. The AdminBot service unit puts it on PYTHONPATH, but this job runs
# under the OpenClaw gateway, whose unit does not, so the bridge has to be pointed at it here.
PYTHON_LIBS="$HOME/.local/share/jinesis-adminbot/python-libs"
export PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}$PYTHON_LIBS"
tmp="$(mktemp "${TARGET}.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

"$PYTHON" "$(dirname "${BASH_SOURCE[0]}")/adminbot-openreview.py" author-results >"$tmp"

TARGET="$TARGET" PYTHON="$PYTHON" PYTHON_LIBS="$PYTHON_LIBS" "$PYTHON" - "$tmp" <<'PY'
import datetime, json, os, sys

path = sys.argv[1]
with open(path) as handle:
    result = json.load(handle)
if not result.get("ok"):
    hint = ""
    if result.get("reason") == "missing_dependency":
        # The one failure an operator fixes on the host rather than in OpenReview: say where.
        hint = (
            f" ({os.environ['PYTHON']} with PYTHONPATH={os.environ.get('PYTHONPATH', '')}; install"
            f" scripts/adminbot-openreview-requirements.txt into {os.environ['PYTHON_LIBS']} by"
            " re-running deploy/aurora/install-user-services.sh, or point ADMINBOT_PYTHON at an"
            " interpreter that has it)"
        )
    print(f"openreview results: {result.get('reason')}: {result.get('error')}{hint}", file=sys.stderr)
    raise SystemExit(1)
result["fetched_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
with open(path, "w") as handle:
    json.dump(result, handle)
submissions = result.get("submissions", [])
errors = sum(1 for entry in submissions if entry.get("error"))
print(f"openreview results: {len(submissions)} submissions, {errors} unreadable forums -> {os.environ['TARGET']}")
PY

chmod 640 "$tmp"
mv "$tmp" "$TARGET"
trap - EXIT
