#!/usr/bin/env bash
# Install papermentor-pdf on the AdminBot host, for the PaperMentor tab: members upload an Overleaf
# source zip, the service reviews it here and hands back the post-review zip, the annotated PDF and
# the report (extensions/adminbot/src/connectors/papermentor-uploads.ts).
#
# Run by hand on Aurora, from a release directory:
#
#   bash deploy/aurora/install-papermentor-pdf.sh --source <papermentor-pdf checkout or git URL> \
#     --ref <commit> [--dir <install dir>] [--env-file <path>] [--no-tectonic]
#
#   - The checkout is copied at exactly <ref> (git archive, no .git, no .env, no session state) into
#     <dir>, default ~/.local/share/jinesis-adminbot/papermentor-pdf, and its dependencies installed
#     from its own package-lock.json with the node the service runs on. A rerun replaces it.
#   - Tectonic, a single-binary LaTeX engine that fetches packages on first use, goes into
#     <dir>/../bin at a pinned version, checked against GitHub's published sha256 before it is
#     unpacked. It is the only compiler the service uses for an uploaded zip: latexmk would read a
#     latexmkrc (Perl) from the upload. Without it the review still runs; the comments then come
#     back in the zip and the report with no PDF. --no-tectonic skips it.
#   - Only *missing* keys are appended to the env file the unit reads; an operator's own value is
#     never rewritten. Restart jinesis-adminbot afterwards for the service to see them.
#   - Nothing here reads or writes a credential. The review uses the model key the env file already
#     has (LLM_GATEWAY_URL/LLM_GATEWAY_TOKEN, else OPENROUTER_API_KEY, else OPENAI_API_KEY).
set -euo pipefail

SOURCE=""
REF=""
DIR="${HOME}/.local/share/jinesis-adminbot/papermentor-pdf"
ENV_FILE=""
TECTONIC=1
TECTONIC_VERSION="0.17.0"
TECTONIC_ASSET="tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz"
# GitHub's own digest for the release asset (gh api repos/tectonic-typesetting/tectonic/releases).
TECTONIC_SHA256="8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7"

die() {
  printf 'error: papermentor-pdf: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --source)
      SOURCE="${2:?--source requires a value}"
      shift 2
      ;;
    --ref)
      REF="${2:?--ref requires a value}"
      shift 2
      ;;
    --dir)
      DIR="${2:?--dir requires a value}"
      shift 2
      ;;
    --env-file)
      ENV_FILE="${2:?--env-file requires a value}"
      shift 2
      ;;
    --no-tectonic)
      TECTONIC=""
      shift
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done
[[ -n "$SOURCE" && -n "$REF" ]] || {
  printf 'usage: %s --source <checkout or git URL> --ref <commit> [--dir <dir>] [--env-file <path>] [--no-tectonic]\n' "$0" >&2
  exit 2
}
[[ "$REF" =~ ^[0-9a-f]{7,40}$ ]] || die "--ref must be a commit id, so the install is exactly what was reviewed"

NODE="${NODE:-$(systemctl --user show jinesis-adminbot.service -p ExecStart --value 2>/dev/null |
  sed -n 's/.*path=\([^ ;]*\).*/\1/p' | head -n 1)}"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -x "$NODE" ]] || die "no node found; set NODE=/path/to/node"
NPM="$(dirname "$NODE")/npm"
[[ -x "$NPM" ]] || NPM="$(command -v npm || true)"
[[ -x "$NPM" ]] || die "no npm next to $NODE"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The tree at exactly REF, as git sees it: never a working copy's .env or session file.
if [[ -d "$SOURCE/.git" || -f "$SOURCE/.git" ]]; then
  git -C "$SOURCE" archive --format=tar "$REF" | tar -x -C "$work"
else
  git clone --quiet --no-checkout "$SOURCE" "$work/clone"
  git -C "$work/clone" archive --format=tar "$REF" | tar -x -C "$work"
  rm -rf "$work/clone"
fi
[[ -f "$work/bin/papermentor.mjs" && -f "$work/package-lock.json" ]] ||
  die "$REF does not look like papermentor-pdf (no bin/papermentor.mjs or package-lock.json)"

(cd "$work" && PATH="$(dirname "$NODE"):$PATH" "$NPM" ci --omit=dev --no-audit --no-fund --loglevel=error)

mkdir -p "$(dirname "$DIR")"
rm -rf "$DIR.new"
mv "$work" "$DIR.new"
trap - EXIT
rm -rf "$DIR.old"
[[ -d "$DIR" ]] && mv "$DIR" "$DIR.old"
mv "$DIR.new" "$DIR"
rm -rf "$DIR.old"
chmod -R go-rwx "$DIR"
printf '%s\n' "$REF" >"$DIR/INSTALLED_REF"
printf 'papermentor-pdf: installed %s into %s\n' "$REF" "$DIR"

BIN_DIR="$(dirname "$DIR")/bin"
if [[ -n "$TECTONIC" ]]; then
  if [[ -x "$BIN_DIR/tectonic" ]] && "$BIN_DIR/tectonic" --version 2>/dev/null | grep -q "$TECTONIC_VERSION"; then
    printf 'papermentor-pdf: tectonic %s already in %s\n' "$TECTONIC_VERSION" "$BIN_DIR"
  else
    tmp="$(mktemp -d)"
    curl -fsSL --retry 3 -o "$tmp/$TECTONIC_ASSET" \
      "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${TECTONIC_ASSET}"
    printf '%s  %s\n' "$TECTONIC_SHA256" "$tmp/$TECTONIC_ASSET" | sha256sum -c --quiet - ||
      die "tectonic download does not match its published sha256; not installed"
    mkdir -p "$BIN_DIR"
    tar -xzf "$tmp/$TECTONIC_ASSET" -C "$tmp" tectonic
    install -m 0755 "$tmp/tectonic" "$BIN_DIR/tectonic"
    rm -rf "$tmp"
    printf 'papermentor-pdf: installed tectonic %s into %s\n' "$TECTONIC_VERSION" "$BIN_DIR"
  fi
fi

if [[ -z "$ENV_FILE" ]]; then
  ENV_FILE="$(systemctl --user show jinesis-adminbot.service -p EnvironmentFiles --value 2>/dev/null |
    awk 'NR==1 {print $1}')"
fi
if [[ -z "$ENV_FILE" || ! -f "$ENV_FILE" ]]; then
  printf 'papermentor-pdf: no env file found; add these to the service environment yourself:\n'
  printf '  ADMINBOT_PAPERMENTOR_PDF_DIR=%s\n  ADMINBOT_PAPERMENTOR_BIN_DIR=%s\n' "$DIR" "$BIN_DIR"
  exit 0
fi
added=""
for pair in "ADMINBOT_PAPERMENTOR_PDF_DIR=$DIR" "ADMINBOT_PAPERMENTOR_BIN_DIR=$BIN_DIR"; do
  key="${pair%%=*}"
  if ! grep -Eq "^[[:space:]]*${key}=" "$ENV_FILE"; then
    if [[ -z "$added" ]]; then
      printf '\n# Added by deploy/aurora/install-papermentor-pdf.sh on %s\n' "$(date -u +%Y-%m-%d)" >>"$ENV_FILE"
    fi
    printf '%s\n' "$pair" >>"$ENV_FILE"
    added="$added $key"
  fi
done
if [[ -n "$added" ]]; then
  printf 'papermentor-pdf: set%s in %s; restart jinesis-adminbot to pick it up\n' "$added" "$ENV_FILE"
else
  printf 'papermentor-pdf: %s already names the install; restart jinesis-adminbot to load the new version\n' "$ENV_FILE"
fi
