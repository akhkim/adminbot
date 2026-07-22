# Qwen3.5 NVFP4 on Aurora

This setup uses one local checkpoint and one designated Blackwell GPU for both
normal AdminBot inference and local privacy classification. vLLM remains bound
to loopback and is not published through Tailscale.

After deploying the commit, run on Aurora:

```bash
/h/405/akim/services/openclaw-adminbot/current/deploy/aurora/setup-qwen35-vllm.sh \
  --root /h/405/akim/services/openclaw-adminbot/current \
  --gpu GPU-51e9e550-a798-120d-2926-5c76e25b9e56 \
  --model-home /mfs1/u/akim/jinesis-vllm-qwen35 \
  --max-model-len 65536 \
  --gpu-memory-utilization 0.90
```

The installer:

- creates `/mfs1/u/akim/jinesis-vllm-qwen35/venv`;
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

The download is resumable. Use `--skip-install` or `--skip-download` when
re-running completed phases. Use `--skip-start` to prepare everything without
allocating the GPU.

Inspect progress or failures:

```bash
systemctl --user status jinesis-vllm.service --no-pager -l
journalctl --user -u jinesis-vllm.service -f
set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a
curl -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/v1/models
```

Start with 64K context. Raising it to 128K on a 96 GiB RTX PRO 6000 must be
validated against real KV-cache allocation and concurrent tool workloads.
