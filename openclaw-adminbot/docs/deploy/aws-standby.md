# AWS standby

The AWS instance that runs the lab's Overleaf stack also holds a **standby** copy of AdminBot.
Aurora stays the only live writer. The standby has a built release, every unit written, secrets
in place and working model tunnels, but its service, gateway, email job and sheet poller are not
running. Failover starts them, after Aurora's writers stop and their final state has been copied
over. That procedure is not in this change yet.

Both hosts cannot serve at once. Each has its own SQLite database, each gateway would run the
scheduled jobs (duplicate email), a second Slack socket-mode connection takes a share of events,
and a second `cloudflared` on the production tunnel splits `admin.safe.eu` between two databases.
`deploy/aws/status.sh` fails if any of those is running on the standby.

The standby still depends on Aurora's GPU: private-model features fail closed when Aurora is down.
What it removes is the dependence on Aurora's host for everything else.

## One-time setup

1. **AWS (Terraform, not the console):** the instance role needs `ssm:GetParametersByPath` on
   `arn:aws:ssm:<region>:<account>:parameter/adminbot/*`. Close inbound 22; Session Manager is
   the shell.
2. **Parameter Store:** one SecureString per secret under `/adminbot/`, named like the env var
   (`/adminbot/OPENCLAW_GATEWAY_TOKEN`, `/adminbot/VLLM_API_KEY`, …), plus a String
   `/adminbot/ADMINBOT_TUNNEL_TARGET` holding Aurora's Tailscale IPv4 address.
3. **Tailscale** on the instance and on Aurora, with a tailnet policy that lets only this host
   reach Aurora on 8000 and 11434. Aurora's vLLM must use a real API key, not `vllm-local`.
4. **Host account**, as root through Session Manager:
   ```bash
   sudo deploy/aws/bootstrap-host.sh
   ```
   This creates the unprivileged `adminbot` account (never in the `docker` group), `/srv/adminbot`,
   and enables lingering.
5. As `adminbot`, install Node 22 with `deploy/aurora/install-node-user.sh` from any release
   checkout.

## Deploying a release

Build on x86_64 Linux with Node 22 (WSL or CI), never on the instance, which shares its memory
with Overleaf:

```bash
deploy/aws/build-release.sh --ref origin/main
# -> ~/adminbot-releases/adminbot-<commit>.tar.gz and .sha256
```

Copy both files to `/srv/adminbot/incoming/` on the instance (over the tailnet), then as `adminbot`:

```bash
/srv/adminbot/current/deploy/aws/install-release.sh --tarball /srv/adminbot/incoming/adminbot-<commit>.tar.gz
deploy/aws/render-env.sh      # first install, or after a Parameter Store change
deploy/aws/status.sh
```

For the very first install there is no `current` yet; run `install-release.sh` from the unpacked
tarball instead. `install-release.sh` refuses to run while any writer is active, verifies the
checksum, unpacks into `/srv/adminbot/releases/<commit>`, points `current` at it, writes the units
with `install-user-services.sh --no-start`, and (re)starts only the two model tunnels. It keeps
three releases.

## Status

`deploy/aws/status.sh` is read-only and exits non-zero unless the host is a healthy standby: a
release is installed, no writer runs, `VLLM_API_KEY` is not the default, both tunnels answer, and
no `cloudflared` runs on the host.
