#!/usr/bin/env bash
set -euo pipefail

# Resolve from the executable, so this works from any current directory.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/openclaw-adminbot"
exec node scripts/run-adminbot-dev.mjs "$@"
