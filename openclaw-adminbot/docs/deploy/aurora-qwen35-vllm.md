# Qwen3.5 NVFP4 on Aurora

This setup uses one local checkpoint and one designated Blackwell GPU for both
normal AdminBot inference and local privacy classification. vLLM remains bound
to loopback and is not published through Tailscale.

After deploying the commit, run on Aurora:

```bash
/h/405/<cs-user>/services/openclaw-adminbot/current/deploy/aurora/setup-qwen35-vllm.sh \
  --root /h/405/<cs-user>/services/openclaw-adminbot/current \
  --gpu GPU-51e9e550-a798-120d-2926-5c76e25b9e56 \
  --model-home "$JINESIS_VLLM_MODEL_HOME" \
  --max-model-len 65536 \
  --gpu-memory-utilization 0.90
```

The installer:

- creates `$JINESIS_VLLM_MODEL_HOME/venv`;
- installs vLLM and the Hugging Face CLI without sudo;
- checks for at least 80 GiB free before the first download;
- downloads `nvidia/Qwen3.5-122B-A10B-NVFP4` once into the Hugging Face cache;
- disables the old user Ollama service;
- creates and starts `jinesis-vllm.service`;
- binds the OpenAI-compatible API to `127.0.0.1:8000`;
- restricts vLLM to the selected GPU;
- configures 64K context, ModelOpt NVFP4 weights, FP8 KV cache, Qwen reasoning, and native tool parsing;
- registers the model in `~/.openclaw/openclaw.json` and makes it AdminBot's
  primary model; and
- verifies a non-thinking, temperature-zero, JSON-schema-constrained privacy
  request and a native structured tool call; and
- keeps the Qwen3-Next checkpoint by default for rollback.

## API key

vLLM is reachable through Cloudflare (behind Access) for the AWS standby, so its key is a real
secret. The script never uses the old `vllm-local` default and never replaces a working key on a
re-run: it keeps `VLLM_API_KEY` if you pass one, else the key already in
`~/.config/jinesis-adminbot/vllm.env`, else the one in `adminbot.env`, and only generates a new
one (`openssl rand -hex 32`) when none of those is a real key. It refuses `vllm-local` and anything
shorter than 32 characters.

The key lives in two files, kept in step: `vllm.env` (only the key, read by `jinesis-vllm` through
`EnvironmentFile=`) and `adminbot.env` (read by AdminBot and the Gateway). It is never on a
command line, where any Aurora user's `ps` would show it. To rotate it, rerun the script with a new
`VLLM_API_KEY`; it rewrites both files, restarts vLLM (about 25 minutes, most of it loading 78 GB
of weights from `/mfs1`), then restarts AdminBot and the Gateway. Update `/adminbot/VLLM_API_KEY`
in AWS Parameter Store to match.

vLLM's compile cache and FlashInfer's JIT cache are kept next to the model under `/mfs1/u/<user>`
(`VLLM_CACHE_ROOT`, `FLASHINFER_WORKSPACE_BASE`), and usage statistics are off
(`VLLM_NO_USAGE_STATS=1`): the home volume is quota-limited and filled up.

The download is resumable. Use `--skip-install` or `--skip-download` when
re-running completed phases. Use `--skip-start` to prepare everything without
allocating the GPU.

Inspect progress or failures:

```bash
systemctl --user status jinesis-vllm.service --no-pager -l
journalctl --user -u jinesis-vllm.service -f
# Header from a file, not argv, so the key never shows in `ps`.
curl -H @<(sed -n 's/^VLLM_API_KEY=/Authorization: Bearer /p' ~/.config/jinesis-adminbot/vllm.env) \
  http://127.0.0.1:8000/v1/models
```

Start with 64K context. Raising it to 128K on a 96 GiB RTX PRO 6000 must be
validated against real KV-cache allocation and concurrent tool workloads.
