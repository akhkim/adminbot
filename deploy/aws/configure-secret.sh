#!/bin/bash
set -euo pipefail
set +x

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <secret-arn> <organization-uuid>" >&2
  exit 64
fi

SECRET_ARN=$1
ORGANIZATION_ID=$2
if [[ ! "$ORGANIZATION_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
  echo "organization UUID is invalid" >&2
  exit 65
fi

TEMPORARY_FILE=$(mktemp)
IDENTITY_KEY=$(openssl rand -base64 48 | tr -d '\n')
cleanup() {
  unset IDENTITY_KEY
  if command -v shred >/dev/null 2>&1; then
    shred --remove "$TEMPORARY_FILE"
  else
    rm -f "$TEMPORARY_FILE"
  fi
}
trap cleanup EXIT
chmod 0600 "$TEMPORARY_FILE"

ORGANIZATION_ID="$ORGANIZATION_ID" IDENTITY_KEY="$IDENTITY_KEY" \
  python3 - "$TEMPORARY_FILE" <<'PYTHON'
import json
import os
import sys

with open(sys.argv[1], "w", encoding="utf-8") as output:
    json.dump(
        {
            "ADMINBOT_ORGANIZATION_ID": os.environ["ORGANIZATION_ID"],
            "ADMINBOT_IDENTITY_KEY_SECRET": os.environ["IDENTITY_KEY"],
        },
        output,
        separators=(",", ":"),
    )
PYTHON

aws secretsmanager put-secret-value \
  --secret-id "$SECRET_ARN" \
  --secret-string "file://$TEMPORARY_FILE" \
  --output json \
  --query '{ARN:ARN,VersionId:VersionId}'
