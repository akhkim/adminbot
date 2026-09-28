#!/usr/bin/env bash
# Builds a self-contained AdminBot release tarball for the AWS host, on a machine that is not it.
#
# The AWS instance shares 8 GB with the lab's Overleaf stack and is already in swap; a `pnpm build`
# of this workspace there would push Overleaf into heavy swapping. So the release is built here, from
# a committed ref only (a dirty tree is not reproducible and is not what review saw), and shipped
# with its node_modules. Native modules must match the target, which is why the build must run on
# x86_64 Linux with Node 22, the same as the instance.
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
REF="HEAD"
OUT_DIR="$HOME/adminbot-releases"

usage() {
  cat <<'EOF'
Usage: deploy/aws/build-release.sh [--ref <git-ref>] [--out <dir>]

Builds adminbot-<commit>.tar.gz and its .sha256 from a committed ref
(default: HEAD) into --out (default: ~/adminbot-releases). Run on x86_64
Linux with Node 22 so native modules match the AWS host.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --ref)
      (($# >= 2)) || die "--ref requires a value"
      REF="$2"
      shift 2
      ;;
    --out)
      (($# >= 2)) || die "--out requires a value"
      OUT_DIR="${2%/}"
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

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] ||
  die "build on x86_64 Linux so native modules match the AWS host (this is $(uname -s)-$(uname -m))"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 22 ? 0 : 1)' ||
  die "Node 22 is required to match the AWS host's native-module ABI; found $(node --version)"

commit="$(git -C "$APP_ROOT" rev-parse --verify "${REF}^{commit}")" ||
  die "not a committed Git revision: $REF"
sha="$(git -C "$APP_ROOT" rev-parse --short=12 "$commit")"
# This tree is a subdirectory of the lab repository and the root of the dev repository. Archiving
# the tree at its prefix gives the same release layout from either. It must run from the top level:
# run from the subdirectory, git archive also narrows to that subdirectory *inside* the given tree,
# looks for openclaw-adminbot/openclaw-adminbot/, and produces an empty archive without complaint.
prefix="$(git -C "$APP_ROOT" rev-parse --show-prefix)"
toplevel="$(git -C "$APP_ROOT" rev-parse --show-toplevel)"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
mkdir -p "$work/$sha" "$OUT_DIR"
git -C "$toplevel" archive --format=tar "${commit}:${prefix}" | tar -x -C "$work/$sha"
[[ -f "$work/$sha/package.json" && -f "$work/$sha/pnpm-lock.yaml" ]] ||
  die "the archive of ${commit}:${prefix} has no package.json or pnpm-lock.yaml"

pnpm_cmd=(pnpm)
command -v pnpm >/dev/null || pnpm_cmd=(corepack pnpm)
(
  cd "$work/$sha"
  CI=true "${pnpm_cmd[@]}" install --frozen-lockfile
  "${pnpm_cmd[@]}" build
)
# The same gate CI uses: a tree that builds without the extension entrypoint ships and fails later.
[[ -f "$work/$sha/dist/extensions/adminbot/api.js" ]] ||
  die "build did not produce dist/extensions/adminbot/api.js"

cat >"$work/$sha/RELEASE" <<EOF
commit=$commit
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node=$(node --version)
EOF

tarball="adminbot-${sha}.tar.gz"
tar -C "$work" -czf "$OUT_DIR/$tarball" "$sha"
(cd "$OUT_DIR" && sha256sum "$tarball" >"$tarball.sha256")
printf 'built %s\n' "$OUT_DIR/$tarball"
