#!/usr/bin/env bash
set -euo pipefail

# Resolve from the executable, so this works from any current directory.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/openclaw-adminbot"
# Optional, git-ignored local credentials; exported shell variables take precedence.
exec node --env-file-if-exists=.env.dev.local scripts/run-adminbot-dev.mjs "$@"
