#!/usr/bin/env bash
# Writes AdminBot's env file on the AWS host from SSM Parameter Store, under /adminbot/.
#
# Secrets live in Parameter Store, not in the repo or on an operator's laptop; the instance role
# reads them. Each parameter /adminbot/<NAME> becomes NAME=<value> in the 0600 env file, replacing
# an existing line or appending one; keys not in Parameter Store are left alone, so the template's
# non-secret settings survive. Values travel over a pipe, never argv, and are never printed.
set -euo pipefail
export PATH=$HOME/.local/bin:$PATH

ROOT_DIR="/srv/adminbot"
PREFIX="/adminbot/"
REGION="${AWS_REGION:-}"

usage() {
  cat <<'EOF'
Usage: deploy/aws/render-env.sh [--root <dir>] [--prefix /adminbot/] [--region <region>]

Fills ~/.config/jinesis-adminbot/adminbot.env from SSM parameters under the
prefix, creating it from the release template if it does not exist, then
restarts the model tunnels. Prints key names only, never values.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --root)
      (($# >= 2)) || die "--root requires a value"
      ROOT_DIR="${2%/}"
      shift 2
      ;;
    --prefix)
      (($# >= 2)) || die "--prefix requires a value"
      PREFIX="$2"
      shift 2
      ;;
    --region)
      (($# >= 2)) || die "--region requires a value"
      REGION="$2"
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

((EUID != 0)) || die "run as the AdminBot service account, not root"
[[ "$PREFIX" =~ ^/[A-Za-z0-9_.-]+/$ ]] || die "--prefix must look like /name/"
command -v aws >/dev/null || die "the AWS CLI is missing"

if [[ -z "$REGION" ]]; then
  # The instance's own region, from IMDSv2 (the host requires tokens).
  token="$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)" ||
    die "cannot reach instance metadata; pass --region"
  REGION="$(curl -fsS -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/placement/region)"
fi

config_dir="$HOME/.config/jinesis-adminbot"
env_file="$config_dir/adminbot.env"
if [[ ! -f "$env_file" ]]; then
  template="$ROOT_DIR/current/deploy/aurora/adminbot.env.example"
  [[ -f "$template" ]] || die "no env file and no release template at $template; install a release first"
  install -d -m 0700 "$config_dir"
  sed -e "s|__HOME__|$HOME|g" -e "s|__USER__|$USER|g" "$template" >"$env_file"
  chmod 600 "$env_file"
fi

aws ssm get-parameters-by-path --region "$REGION" --path "$PREFIX" --recursive --with-decryption \
  --query 'Parameters[].{name:Name,value:Value}' --output json |
  PREFIX="$PREFIX" ENV_FILE="$env_file" node -e '
    const fs = require("node:fs");
    const { PREFIX: prefix, ENV_FILE: file } = process.env;
    const params = JSON.parse(fs.readFileSync(0, "utf8")) ?? [];
    if (!params.length) throw new Error(`no parameters under ${prefix}`);
    // The file is read by systemd (EnvironmentFile) and sourced by bash in the installer, so a value
    // must mean the same thing to both. Plain values go unquoted; anything else is double-quoted, and
    // a value neither form can carry safely is refused rather than written ambiguously.
    const encode = (key, value) => {
      if (/^[A-Za-z0-9_.\/:@+=,-]*$/.test(value)) return value;
      if (/[\n\r"\\$`]/.test(value)) throw new Error(`${key} contains characters the env file cannot hold`);
      return `"${value}"`;
    };
    const updates = new Map();
    for (const { name, value } of params) {
      const key = name.slice(prefix.length);
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`parameter ${name} is not an env var name`);
      updates.set(key, encode(key, value));
    }
    const lines = fs.readFileSync(file, "utf8").split("\n");
    const seen = new Set();
    const out = lines.map((line) => {
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
      if (!key || !updates.has(key)) return line;
      seen.add(key);
      return `${key}=${updates.get(key)}`;
    });
    if (out.at(-1) === "") out.pop();
    for (const [key, value] of updates) if (!seen.has(key)) out.push(`${key}=${value}`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${out.join("\n")}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.log(`updated ${updates.size} keys: ${[...updates.keys()].sort().join(", ")}`);
  '

if grep -q '^VLLM_API_KEY=vllm-local$' "$env_file"; then
  printf 'warning: VLLM_API_KEY is still the vllm-local default; set /adminbot/VLLM_API_KEY to the key Aurora'\''s vLLM uses\n' >&2
fi
unit_dir="$HOME/.config/systemd/user"
if [[ -f "$unit_dir/jinesis-model-tunnel-vllm.service" ]] && command -v cloudflared >/dev/null &&
  grep -q '^ADMINBOT_MODEL_HOST_VLLM=.' "$env_file" && grep -q '^TUNNEL_SERVICE_TOKEN_ID=.' "$env_file"; then
  systemctl --user enable jinesis-model-tunnel-vllm.service jinesis-model-tunnel-ollama.service
  systemctl --user restart jinesis-model-tunnel-vllm.service jinesis-model-tunnel-ollama.service
fi
