# Sharing AdminBot's model GPU

AdminBot's local model (`jinesis-vllm`, Qwen3.5-122B NVFP4) has its own GPU on Aurora. AdminBot
has priority on it, but most of the day the model is idle, so other jobs under the `akim` account
(for example jev post-training) may use the GPU while it is free.

## How it works

- `jinesis-vllm-gate` owns `127.0.0.1:8000`, the address AdminBot already uses. vLLM listens on a
  Unix socket in `$XDG_RUNTIME_DIR/jinesis-gpu7/` (mode 0700) with sleep mode on.
- After `GATE_IDLE_SECONDS` (default 15 minutes) without a request, the gate puts the model to sleep:
  the weights move to host RAM and the GPU's memory is released.
- The next AdminBot request **stops every borrowed job** (SIGTERM, then SIGKILL after
  `GATE_PREEMPT_GRACE_SECONDS`, default 60), waits for the GPU to empty, and wakes the model. It
  wakes in seconds, not the ~20-minute cold start.
- The gate forwards only `/health` and `/v1/*`. Sleep mode needs vLLM's dev mode, which adds
  unauthenticated control endpoints (`/collective_rpc`, `/update_weights`, …). Those are reachable
  only on the private socket, never from the shared loopback port.

## Borrowing the GPU

```bash
gpu7-borrow python train.py --config jev.yaml
```

- The job waits until the model is asleep, then runs on the model's GPU (`CUDA_VISIBLE_DEVICES` is
  set for you) in its own process group.
- **It can be stopped at any time** when AdminBot needs the GPU. Save a checkpoint when you get
  SIGTERM and exit; anything still running after the grace period is killed. The wrapper exits
  143 (SIGTERM) or 137 (SIGKILL) and prints `stopped so AdminBot could use the GPU`, so a retry
  loop can tell a preemption apart from a crash.
- `--max-wait-seconds N` gives up with exit 75 if the model stays busy for N seconds. The default
  waits forever.
- Only jobs started through `gpu7-borrow` are stopped. Anything else on the GPU makes the wake
  wait, and then fail, for lack of memory.

Check the state: `python3 ~/.local/share/jinesis-adminbot/gpu-share/jinesis_gpu_share.py status`.

## Installing

```bash
cd /w/406/adminbot/current
deploy/aurora/install-gpu-share.sh --gpu-uuid GPU-…            # dry run: prints what it writes
deploy/aurora/install-gpu-share.sh --gpu-uuid GPU-… --apply    # restarts jinesis-vllm (~20 min)
```

Tests: `python3 -m unittest discover -s deploy/aurora/gpu-share -p 'test_*.py'`.
