# Hosting AdminBot on Aurora

Aurora is a private AIS sandbox node, not an Internet-facing server. It is
reachable only from the CS VPN or the on-campus network:

```bash
ssh aurora.ais.sandbox -l <cs-user>
```

AdminBot does not need a GPU to remain online. Run the Gateway, AdminBot API,
and hourly email processor as user-level systemd services. Keep code, secrets,
SQLite state, and configuration in the backed-up CS home directory. Put package
and model caches on `/mfs1/u/<user>`; do not put durable state in `/tmp`.

## Architecture

```text
Browser / local OpenClaw UI
        |
        | CS VPN + SSH local forwarding
        v
127.0.0.1:18789  ->  aurora 127.0.0.1:18789  OpenClaw Gateway
127.0.0.1:8765   ->  aurora 127.0.0.1:8765   AdminBot API
                                             |
                                             +-- Gmail/Drive/Calendar via gog
                                             +-- Slack through OpenClaw config
                                             +-- hourly systemd email timer
```

Both services remain loopback-only. Do not bind the AdminBot API to
`10.63.12.33` or expose port 8765 publicly.

## Prerequisites on Aurora

- A CSLab Unix account and CS VPN/on-campus access.
- Node.js 22.19 or newer and `corepack`/`pnpm`, installed in the user account or
  loaded from an approved `/w/pkgs` toolchain.
- `gog` at `~/.local/bin/gog`.
- `gws` at `~/.local/bin/gws` if calendar ACL sharing is required.
- An Ollama-compatible private model endpoint, normally
  `http://127.0.0.1:11434`.
- The populated OpenClaw config and environment file described below.
- User lingering enabled by CSLab so user-systemd services survive logout:

  ```text
  loginctl enable-linger <cs-user>
  ```

  This normally requires CSLab/Eugenia. The installer warns when lingering is
  disabled.

## 1. Check connectivity

From the repository on a machine connected to the CS VPN:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> check
```

This confirms the host, account, `/mfs1` mount, Node version, systemd, and
lingering status.

## 2. Deploy a committed revision

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> --ref HEAD deploy
```

Deployment uses `git archive`, so it sends only the selected committed revision
and never copies the dirty working tree, `.git`, local secrets, `node_modules`,
or local state. Aurora builds the release, then atomically updates:

```text
/h/405/<user>/services/openclaw-adminbot/current
```

Releases are versioned under `releases/`. The AdminBot `state/` path is linked
to `~/.openclaw/state`, keeping SQLite state outside a replaceable release.

The deploy command installs service definitions but does not start them.

## 3. Configure secrets and OpenClaw

Copy the example locally, populate every required placeholder, then upload it:

```bash
cp deploy/aurora/adminbot.env.example /tmp/adminbot.env
chmod 600 /tmp/adminbot.env
$EDITOR /tmp/adminbot.env
scripts/aurora-adminbot-host.sh --user <cs-user> upload-env /tmp/adminbot.env
```

Generate `OPENCLAW_GATEWAY_TOKEN` with a cryptographically random value, such as
`openssl rand -hex 32`. The environment file must contain the persistent gog
keyring password but must never be committed.

Upload a reviewed Aurora-specific OpenClaw configuration:

```bash
scripts/aurora-adminbot-host.sh \
  --user <cs-user> \
  upload-config ~/.openclaw/openclaw.json
```

Review machine-specific absolute paths before uploading. The AdminBot service
URL should remain `http://127.0.0.1:8765`.

## 4. Authenticate Google on Aurora

OAuth refresh tokens and file-keyring contents are machine-local. Authenticate
the AdminBot account on Aurora rather than copying the entire local keyring:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> auth-gog
```

The command uses gog's remote/manual OAuth mode. Open the printed URL locally,
approve `jinesis.adminbot@gmail.com`, then paste the resulting redirect URL
back into the SSH session.

Calendar event creation uses gog. Calendar ACL changes ("See all events") use
the separate `gws` CLI, so also authenticate `gws` on Aurora and confirm:

```bash
gws auth status
gws calendar acl list --params '{"calendarId":"jinesis.lab@gmail.com"}'
```

## 5. Start and verify

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> start
scripts/aurora-adminbot-host.sh --user <cs-user> status
```

The start command refuses to proceed while the env file contains
`REPLACE_ME`, while `openclaw.json` is missing, or while gog authentication is
unavailable.

Inspect logs independently:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> logs adminbot
scripts/aurora-adminbot-host.sh --user <cs-user> logs gateway
scripts/aurora-adminbot-host.sh --user <cs-user> logs email
```

## Optional Google Sheet member poller

Aurora can poll one Google Sheet tab every minute and import safe member-profile changes through
the loopback AdminBot API. Add these values to
`~/.config/jinesis-adminbot/adminbot.env`, then rerun the normal `start` command:

```bash
ADMINBOT_MEMBER_SHEET_ID=1AbC...
ADMINBOT_MEMBER_SHEET_RANGE='Members!A:Z'

scripts/aurora-adminbot-host.sh --user <cs-user> start
```

The tab must contain an `AdminBot ID` column whose values exactly match existing roster member
IDs. It may contain these spreadsheet-owned columns:

- `Name`, `Slack User ID`, `Role`, `Research Branch`, `Research Topics`, `Projects`
- `Hours Per Week`, `Location`, `Affiliation`, `Timezone`
- `Personal Website`, `OpenReview ID`, `Notes`, `Availability Doc URL`

Separate `Research Topics` and `Projects` entries with commas, semicolons, or newlines. Blank cells
mean “leave the database value unchanged.” Unknown IDs, duplicate IDs, missing IDs, invalid hours,
and service validation failures fail the poll without creating or deleting members.

Columns such as `Email`, `Privilege Level`, `Status`, `Collaborator Subgroup`, and
`Access Overrides` are read-only from this poller's perspective and are ignored. The AdminBot
service independently rejects them for the poller's service credential.

Before enabling the timer, the installer runs one dry pass that reads both the Sheet and AdminBot
but writes nothing. Inspect recurring runs with:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> logs sheet-poller
systemctl --user status jinesis-adminbot-sheet-poller.timer
```

To test the configured mapping manually without changing the database:

```bash
set -a
. ~/.config/jinesis-adminbot/adminbot.env
set +a
node_modules/.bin/tsx scripts/adminbot-member-sheet-poller.ts --dry-run
```

## 6. Connect to the hosted services

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> connect
```

Keep that SSH session open. Local applications can then use:

- Gateway WebSocket: `ws://127.0.0.1:18789`
- AdminBot API: `http://127.0.0.1:8765`

The Gateway requires `OPENCLAW_GATEWAY_TOKEN`.

The Vercel-hosted UI cannot directly reach Aurora's private `10.63.0.0/16`
address. An SSH tunnel works for the operator's browser only. Multi-user remote
access requires a CSLab-approved HTTPS/WSS reverse proxy or approved private
network ingress. Ask Eugenia before installing Tailscale, Docker, a public
reverse proxy, or making firewall changes.

## Migration safety

The current machine's OpenClaw hourly email cron must remain enabled until the
Aurora timer completes a successful production run. After verifying the Aurora
email-service journal and SQLite effects, disable the old cron to prevent two
hosts from processing the same inbox concurrently.

Do not copy `/tmp`, `node_modules`, or local model caches to Aurora. Do not store
OAuth tokens, SQLite state, or reimbursement output in `/tmp` or in a release
directory.
