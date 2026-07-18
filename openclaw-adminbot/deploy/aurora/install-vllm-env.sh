#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: install-vllm-env.sh --venv PATH [--timeout DURATION]

Creates an isolated vLLM environment without requiring system python3-venv.
If uv is unavailable, installs the official standalone uv binary under
~/.local/bin, then installs vLLM and its download dependencies.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

VENV=""
INSTALL_TIMEOUT="45m"

while (($#)); do
  case "$1" in
    --venv)
      (($# >= 2)) || die "--venv requires a value"
      VENV="$2"
      shift 2
      ;;
    --timeout)
      (($# >= 2)) || die "--timeout requires a value"
      INSTALL_TIMEOUT="$2"
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

[[ -n "$VENV" ]] || die "--venv is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v timeout >/dev/null 2>&1 || die "timeout is required"

export PATH="$HOME/.local/bin:$PATH"

if ! command -v uv >/dev/null 2>&1; then
  install_dir="$HOME/.local/bin"
  installer="$(mktemp "${TMPDIR:-/tmp}/uv-install.XXXXXX.sh")"
  trap 'rm -f "$installer"' EXIT
  mkdir -p "$install_dir"

  printf 'Installing uv under %s (no root access required)\n' "$install_dir"
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 300 \
    https://astral.sh/uv/install.sh \
    --output "$installer"
  env UV_UNMANAGED_INSTALL="$install_dir" sh "$installer"
fi

UV="$(command -v uv)"
printf 'Creating vLLM environment at %s with %s\n' "$VENV" "$UV"
timeout "$INSTALL_TIMEOUT" "$UV" venv --clear --python /usr/bin/python3 "$VENV"
timeout "$INSTALL_TIMEOUT" "$UV" pip install --python "$VENV/bin/python" --upgrade \
  vllm huggingface_hub hf_transfer

[[ -x "$VENV/bin/vllm" ]] || die "vLLM installation did not create $VENV/bin/vllm"
[[ -x "$VENV/bin/hf" ]] || die "Hugging Face CLI installation did not create $VENV/bin/hf"

printf 'vLLM environment is ready: %s\n' "$VENV"
