#!/usr/bin/env bash
# Weekly check of the working-groups slide, shaped for an OpenClaw cron `command` job.
#
# Reads the deck, measures each group's box, and plans the faces against the roster. When the
# slide is out of date it leaves one `slides.sync_working_groups` proposal for an admin to approve;
# when it already matches, it closes any stale one. Nothing is written to the deck from here --
# only an approved proposal, with ADMINBOT_SLIDES_WRITE=1, does that.
#
# Profile saves trigger the same plan on their own (debounced); this weekly run catches what they
# cannot, such as a box someone resized by hand. See docs/operations/slides-working-groups.md.
set -euo pipefail

# shellcheck source=scripts/lib/adminbot-cron-env.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/adminbot-cron-env.sh"
adminbot_load_cron_env "working-groups slide" || exit 1

[[ -n "${ADMINBOT_SERVICE_TOKEN:-}" ]] || {
  printf 'working-groups slide: ADMINBOT_SERVICE_TOKEN is not set in %s\n' "$ADMINBOT_ENV_FILE" >&2
  exit 1
}

PORT="${ADMINBOT_PORT:-8765}"

response="$(
  curl --silent --show-error --max-time 120 \
    --write-out '\n%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${ADMINBOT_SERVICE_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"trigger":"schedule"}' \
    "http://127.0.0.1:${PORT}/slides/working-groups/apply"
)" || {
  printf 'working-groups slide: could not reach the AdminBot service on 127.0.0.1:%s\n' "$PORT" >&2
  exit 1
}

status="${response##*$'\n'}"
body="${response%$'\n'*}"

# 503 means no deck is configured on this deployment: report it, but do not fail every week for a
# feature that was never turned on.
if [[ "$status" == "503" ]]; then
  printf 'working-groups slide: not configured (%s)\n' "$body"
  exit 0
fi
if [[ "$status" != "200" ]]; then
  printf 'working-groups slide: HTTP %s\n%s\n' "$status" "$body" >&2
  exit 1
fi

python3 - "$body" <<'PY'
import json, sys

try:
    result = json.loads(sys.argv[1])
except json.JSONDecodeError:
    print(f"working-groups slide: unreadable response: {sys.argv[1][:300]}", file=sys.stderr)
    raise SystemExit(1)

proposal = result.get("proposal") or {}
if not result.get("changed"):
    print("working-groups slide: already matches the roster")
elif result.get("reused"):
    print(f"working-groups slide: plan {proposal.get('id')} is still awaiting approval")
else:
    print(f"working-groups slide: proposed {proposal.get('id')} for approval")
for group in result.get("groups", []):
    if group.get("status") in ("update", "blocked"):
        print(
            f"  {group.get('title')}: {group.get('status')} "
            f"+{len(group.get('added', []))} -{len(group.get('removed', []))} "
            f"{group.get('moved', 0)} moved, face {group.get('face_size_in')} in"
        )
raise SystemExit(0)
PY
