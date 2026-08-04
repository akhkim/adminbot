# Bootstrap the Aurora AdminBot runtime

Run this after deploying a committed release and uploading the populated
AdminBot environment and OpenClaw configuration.

CSLab must first install the system Tailscale daemon, provision Aurora in the
intended tailnet, authorize the CS account as the Tailscale operator, provision
`/mfs1/u/<cs-user>` for the model filesystem, and enable user lingering:

```bash
sudo tailscale set --operator=<cs-user>
sudo loginctl enable-linger <cs-user>
```

The NVFP4 checkpoint requires a Blackwell GPU; the setup refuses to continue on
anything else.

From a CS VPN or on-campus shell, connect to Aurora and run:

```bash
ssh aurora.ais.sandbox -l <cs-user>

/h/405/<cs-user>/services/openclaw-adminbot/current/deploy/aurora/bootstrap-runtime.sh \
  --root /h/405/<cs-user>/services/openclaw-adminbot/current \
  --gpu <gpu-index-or-uuid>
```

Use the stable UUID reported by `nvidia-smi -L` when possible. The script is a
thin front end over two steps. First it runs `setup-qwen35-vllm.sh`, which:

- installs vLLM and the Hugging Face CLI into
  `/mfs1/u/<cs-user>/jinesis-vllm-qwen35/venv`, without sudo;
- downloads `nvidia/Qwen3.5-122B-A10B-NVFP4` into that tree's Hugging Face cache;
- creates and starts `jinesis-vllm.service`, bound to `127.0.0.1:8000` and
  restricted to the selected GPU;
- disables the old user Ollama service, which this runtime replaced;
- writes `VLLM_API_KEY`, `ADMINBOT_LOCAL_MODEL`, and `ADMINBOT_LOCAL_BASE_URL`
  into `~/.config/jinesis-adminbot/adminbot.env`, and registers the model in
  `~/.openclaw/openclaw.json`; and
- verifies the served model id, a temperature-zero JSON-schema privacy request,
  and a native structured tool call before it will report success.

See [Qwen3.5 NVFP4 on Aurora](/deploy/aurora-qwen35-vllm) for the model runtime
itself, including context sizing and rollback.

Then it runs `install-user-services.sh`, which installs and starts
`jinesis-adminbot.service` and `jinesis-openclaw-gateway.service`. It also
writes a oneshot `jinesis-adminbot-email.service` but no timer for it: the
hourly email pass is scheduled as an OpenClaw cron job instead, so the schedule
cannot be owned twice — see the `adminbot-email-automation` skill.

Finally, unless `--skip-tailscale` is passed, `bootstrap-runtime.sh` itself
publishes the loopback Gateway with tailnet-only Tailscale Serve. It does not
expose port 8765 and does not use Tailscale Funnel.

Useful options:

```text
--gateway-port <port>     Default: 18789
--adminbot-port <port>    Default: 8765
--skip-install            Reuse the existing vLLM environment
--skip-model-download     Reuse the existing Hugging Face snapshot
--skip-vllm-start         Configure vLLM without starting it
--skip-tailscale          Do not configure Tailscale Serve
--skip-adminbot-start     Install service units without starting them
```

`--skip-vllm-start` also leaves AdminBot and the Gateway stopped: they have
nothing to infer against until vLLM is up, so it implies
`--skip-adminbot-start`.

After completion, obtain the tailnet-only HTTPS/WSS URL with:

```bash
tailscale serve status
```

Inspect failures with:

```bash
systemctl --user status jinesis-vllm.service
journalctl --user -u jinesis-vllm.service -n 200 --no-pager
systemctl --user status jinesis-adminbot.service
systemctl --user status jinesis-openclaw-gateway.service
```
