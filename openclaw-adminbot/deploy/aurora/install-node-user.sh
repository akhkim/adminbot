#!/usr/bin/env bash
set -euo pipefail

VERSION="v22.23.1"
INSTALL_ROOT="$HOME/.local/lib/nodejs"
BIN_DIR="$HOME/.local/bin"

usage() {
  cat <<'EOF'
Usage: install-node-user.sh [--version v22.x.y]

Install an official Node.js 22 Linux binary in the current user's ~/.local
directory without sudo. The archive is verified against Node.js's published
SHA-256 manifest before extraction.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --version)
      (($# >= 2)) || die "--version requires a value"
      VERSION="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$VERSION" =~ ^v22\.[0-9]+\.[0-9]+$ ]] ||
  die "version must be a Node.js 22 release such as v22.23.1"

for command_name in curl sha256sum tar; do
  command -v "$command_name" >/dev/null || die "$command_name is required"
done

case "$(uname -m)" in
  x86_64 | amd64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

ARCHIVE="node-${VERSION}-linux-${ARCH}.tar.xz"
BASE_URL="https://nodejs.org/download/release/${VERSION}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jinesis-node.XXXXXX")"
trap 'rm -rf -- "$TMP_ROOT"' EXIT

printf 'Downloading Node.js %s for linux-%s\n' "$VERSION" "$ARCH"
curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
  --output "$TMP_ROOT/$ARCHIVE" "$BASE_URL/$ARCHIVE"
curl --fail --location --retry 3 --connect-timeout 15 --max-time 60 \
  --output "$TMP_ROOT/SHASUMS256.txt" "$BASE_URL/SHASUMS256.txt"

(
  cd "$TMP_ROOT"
  expected_line="$(grep -E "^[0-9a-f]{64}  ${ARCHIVE}$" SHASUMS256.txt || true)"
  [[ -n "$expected_line" ]] || die "archive is absent from the official SHA-256 manifest"
  printf '%s\n' "$expected_line" | sha256sum --check -
)

mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
destination="$INSTALL_ROOT/node-${VERSION}-linux-${ARCH}"
staging="${destination}.installing.$$"
rm -rf -- "$staging"
mkdir -p "$staging"
tar -xJf "$TMP_ROOT/$ARCHIVE" --strip-components=1 -C "$staging"
rm -rf -- "$destination"
mv -- "$staging" "$destination"

for executable in node npm npx corepack; do
  [[ -x "$destination/bin/$executable" ]] ||
    die "installed archive is missing bin/$executable"
  ln -sfn "$destination/bin/$executable" "$BIN_DIR/$executable"
done

PATH="$BIN_DIR:$PATH" node -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 22 || minor < 19) process.exit(1);
' || die "installed Node.js does not satisfy 22.19+"

printf 'installed_node=%s\n' "$(PATH="$BIN_DIR:$PATH" node --version)"
printf 'installed_path=%s\n' "$BIN_DIR/node"
printf 'Add this to interactive shells if needed: export PATH="$HOME/.local/bin:$PATH"\n'
