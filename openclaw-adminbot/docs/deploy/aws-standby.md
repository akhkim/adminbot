# AWS standby

The AWS instance that runs the lab's Overleaf stack also holds a **standby** copy of AdminBot.
Aurora stays the only live writer. The standby has a built release, every unit written, secrets
in place and working links to Aurora's models, but its service, gateway, email job and sheet
poller are not running. Failover starts them, after Aurora's writers stop and their final state has
been copied over. That procedure is not written yet.

Both hosts cannot serve at once. Each has its own SQLite database, each gateway would run the
scheduled jobs (duplicate email), a second Slack socket-mode connection takes a share of events,
and a second `cloudflared` serving the production tunnel splits `admin.safe.eu` between two
databases. `deploy/aws/status.sh` fails if any of those is running on the standby.

The standby still depends on Aurora's GPU: private-model features fail closed when Aurora is down.
What it removes is the dependence on Aurora's host for everything else.

## How the standby reaches Aurora's models

Every private model path refuses a non-loopback endpoint, so the standby runs two
`cloudflared access tcp` clients that listen on `127.0.0.1:8000` (vLLM) and `127.0.0.1:11434`
(Ollama). They connect through Cloudflare to two hostnames on Aurora's existing named tunnel, each
behind a Cloudflare Access application that admits only this host's service token.

Cloudflare's edge terminates that connection, so **Cloudflare can read the prompts in transit**,
raw private content included. Keeping them from Cloudflare needs vLLM to serve its own TLS with the
standby trusting its certificate; that is not set up.

## One-time setup

Do these in order. Step 2 must be finished before step 3: a model hostname routed to the tunnel
without Access in front of it puts the model on the open internet.

1. **AWS (Terraform, not the console):** the instance role needs `ssm:GetParametersByPath` on
   `arn:aws:ssm:<region>:<account>:parameter/adminbot/*`. Close inbound 22; Session Manager is the
   shell.
2. **Cloudflare Access** (Zero Trust → Access): create a service token for the AWS host, then one
   self-hosted application per model hostname (for example `vllm.safe.eu` and `ollama.safe.eu`)
   whose **only** policy is Service Auth for that token.
3. **Cloudflare DNS:** route both hostnames to Aurora's tunnel (`aurora-adminbot`). Before any
   ingress rule exists, `https://<host>/` must answer 401, 403 or a redirect to
   `cloudflareaccess.com`. A 404 means Access is not in front of it; stop and fix step 2.
4. **Aurora:** give vLLM a real API key instead of `vllm-local`, then rerun the tunnel setup with
   the model hostnames. It probes each hostname the same way and refuses to write an ingress rule
   unless Access answers:
   ```bash
   GW_HOST=gateway.safe.eu MODEL_VLLM_HOST=vllm.safe.eu MODEL_OLLAMA_HOST=ollama.safe.eu \
     deploy/aurora/cloudflare-tunnel.sh
   ```
   This restarts Aurora's `cloudflared`, so `admin.safe.eu` blips for a few seconds.
5. **Parameter Store:** one SecureString per secret under `/adminbot/`, named like the env var
   (`/adminbot/OPENCLAW_GATEWAY_TOKEN`, `/adminbot/VLLM_API_KEY`, …). Include the Access token as
   `/adminbot/TUNNEL_SERVICE_TOKEN_ID` and `/adminbot/TUNNEL_SERVICE_TOKEN_SECRET`, and the two
   hostnames as Strings `/adminbot/ADMINBOT_MODEL_HOST_VLLM` and `/adminbot/ADMINBOT_MODEL_HOST_OLLAMA`.
6. **Host account and cloudflared**, as root through Session Manager:
   ```bash
   sudo deploy/aws/bootstrap-host.sh
   ```
   This creates the unprivileged `adminbot` account (never in the `docker` group), `/srv/adminbot`,
   enables lingering, and installs `cloudflared` from Cloudflare's signed apt repository.
7. As `adminbot`, install Node 22 with `deploy/aurora/install-node-user.sh` from any release
   checkout.

## Deploying a release

Build on x86_64 Linux with Node 22 (WSL or CI), never on the instance, which shares its memory
with Overleaf:

```bash
deploy/aws/build-release.sh --ref origin/main
# -> ~/adminbot-releases/adminbot-<commit>.tar.gz and .sha256
```

Copy both files to `/srv/adminbot/incoming/` on the instance, then as `adminbot`:

```bash
/srv/adminbot/current/deploy/aws/install-release.sh --tarball /srv/adminbot/incoming/adminbot-<commit>.tar.gz
deploy/aws/render-env.sh      # first install, or after a Parameter Store change
deploy/aws/status.sh
```

For the very first install there is no `current` yet; run `install-release.sh` from the unpacked
tarball instead. `install-release.sh` refuses to run while any writer is active, verifies the
checksum, unpacks into `/srv/adminbot/releases/<commit>`, points `current` at it, writes the units
with `install-user-services.sh --no-start`, and (re)starts only the two model links. It keeps three
releases.

## Status

`deploy/aws/status.sh` is read-only and exits non-zero unless the host is a healthy standby: a
release is installed, no writer runs, `VLLM_API_KEY` is not the default, both model links answer,
and no `cloudflared` on the host serves a tunnel (the `access tcp` clients are allowed).
