# Bootstrap the Aurora AdminBot runtime

Run this after deploying a committed release and uploading the populated
AdminBot environment and OpenClaw configuration.

CSLab must first install Ollama and the system Tailscale daemon, provision
Aurora in the intended tailnet, authorize the CS account as the Tailscale
operator, and enable user lingering:

```bash
sudo tailscale set --operator=<cs-user>
sudo loginctl enable-linger <cs-user>
```

From a CS VPN or on-campus shell, connect to Aurora and run:

```bash
ssh aurora.ais.sandbox -l <cs-user>

/h/405/<cs-user>/services/openclaw-adminbot/current/deploy/aurora/bootstrap-runtime.sh \
  --root /h/405/<cs-user>/services/openclaw-adminbot/current \
  --gpu <gpu-index-or-uuid>
```

Use the stable UUID reported by `nvidia-smi -L` when possible. The script:

- creates and starts a user `jinesis-ollama.service`;
- binds Ollama to `127.0.0.1:11434`;
- stores model data under `/mfs1/u/<user>/ollama-models`;
- bounds its model pull to 30 minutes;
- updates `OLLAMA_BASE_URL` and `ADMINBOT_LOCAL_MODEL` in the private env file;
- starts AdminBot, the OpenClaw Gateway, and the hourly email timer;
- publishes only the loopback Gateway with tailnet-only Tailscale Serve; and
- verifies the Ollama API, AdminBot API, Gateway service, and email timer.

It does not expose port 8765 and does not use Tailscale Funnel.

Useful options:

```text
--model <ollama-model>
--pull-timeout 60m
--skip-model-pull
--skip-tailscale
--skip-adminbot-start
```

After completion, obtain the tailnet-only HTTPS/WSS URL with:

```bash
tailscale serve status
```

Inspect failures with:

```bash
systemctl --user status jinesis-ollama.service
journalctl --user -u jinesis-ollama.service -n 100 --no-pager
systemctl --user status jinesis-adminbot.service
systemctl --user status jinesis-openclaw-gateway.service
```
