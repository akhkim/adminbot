# AdminBot on the AWS host

From 2026-11-26, AdminBot (the service, the OpenClaw gateway, cron and the Cloudflare tunnel)
runs on the AWS instance `overleaf-mentor-ec2` (us-east-1, Ubuntu 24.04), under the `adminbot`
account. Only the local model stays on Aurora, because that is where the GPUs are: vLLM behind its
GPU gate, and Ollama for guidebook embeddings.

## Layout

| What | Where |
|---|---|
| Releases, `current`, state, GeoIP, GeoNames | `/srv/adminbot/` (same shape as Aurora's `/w/406/adminbot/`) |
| Service env | `~adminbot/.config/jinesis-adminbot/adminbot.env` (mode 600) |
| Gateway home | `~adminbot/.openclaw` (real files; no symlinks into `/mfs1`) |
| Units | `~adminbot/.config/systemd/user/jinesis-*.service`, with linger enabled |
| Deploy runner | `jinesis-actions-runner.service`, label `adminbot-ec2-deploy`, `AURORA_DEPLOY_ROOT=/srv/adminbot` |

The deploy is the same script as before (`deploy/aurora/auto-deploy.sh`, path-parameterized by
`AURORA_DEPLOY_ROOT`). The state is on local ext4, so `AURORA_ACCEPT_NETWORK_STATE` stays `0`.
The cron sync at the end of each deploy writes every job's paths from the live release. Moving
hosts therefore rewrites all manifest jobs, but a hand-registered job keeps whatever path it was
given.

## The model tunnel

Aurora's user unit `jinesis-ec2-model-tunnel.service` opens a reverse SSH connection to the AWS
host's `adminbot` account and exposes three ports on the AWS host's loopback:

| AWS `127.0.0.1` port | Reaches on the Aurora side |
|---|---|
| 8000 | vLLM GPU gate (`ADMINBOT_LOCAL_BASE_URL` is unchanged) |
| 11434 | Ollama |
| 2222 | `apps0.cs.toronto.edu:22` (DCS username check) |

The key it uses is limited in `authorized_keys` to `restrict,port-forwarding`, with one
`permitlisten` per port and `command="/usr/sbin/nologin"`. It cannot open a shell. If the tunnel is
down, local-model calls fail closed with a connection error and the email pass retries on its
next run. Check it from either end:

```sh
# Aurora
systemctl --user status jinesis-ec2-model-tunnel
# AWS host
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/health
```

## Network

- The security group allows SSH only from Aurora's address, for the two reverse tunnels (this
  one and the private-chat one). Administer the instance through AWS Systems Manager.
- 80 and 443 stay open for Caddy (`chat.safe.eu`).
- AdminBot itself has no inbound port: `admin.safe.eu`, `gateway.safe.eu`, `vllm.safe.eu` and
  `ollama.safe.eu` all arrive through the Cloudflare tunnel, which connects outbound.
- The security group is Terraform-managed (project `overleaf-mentor`). Change the rule in
  Terraform too, or the next apply reopens port 22.

## Rollback

Aurora's last release, state and units stay in place. To go back:

1. Stop `jinesis-cloudflared`, `jinesis-openclaw-gateway` and `jinesis-adminbot` on the AWS host.
2. Copy the AWS state back to `/w/406/adminbot/state` using SQLite's backup API, not `cp`.
3. Start the Aurora units.
4. Set `runs-on` back to `aurora-deploy`.
