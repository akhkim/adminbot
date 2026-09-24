# Hosting AdminBot on Aurora

Aurora is a private AIS sandbox node, not an Internet-facing server. It is
reachable only from the CS VPN or the on-campus network:

```bash
ssh <aurora-host> -l <cs-user>
```

AdminBot does not need a GPU to remain online. Run the Gateway, AdminBot API,
and hourly email processor as user-level systemd services. Keep secrets in the
account's private configuration directory and put package/model caches on
`/mfs1/u/<user>`; do not put durable state in `/tmp`.

**Storage decision still required:** SQLite's WAL mode is not supported on
network filesystems such as NFS or FUSE mounts. A successful snapshot or extra
free space does not make a network-mounted live database safe. Obtain an approved
local block-storage location or a managed PostgreSQL service, with a verified
backup/restore plan, before moving the database. The deploy command checks both
new and existing SQLite state and refuses an unsupported mount before stopping
services. An existing deployment on such a mount needs an operator-led storage
remediation; retrying deploy cannot make the mount safe.

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

Both services remain loopback-only. Do not bind the AdminBot API to the host's
private lab address or expose port 8765 publicly.

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
/mfs1/u/<cs-user>/jinesis-adminbot/current
```

Releases are versioned under `releases/`, and the AdminBot `state/` path is
linked to `/mfs1/u/<cs-user>/jinesis-adminbot/state`, keeping SQLite state
outside a replaceable release. The pnpm store is pinned beside them rather than
left to pnpm's default, which picks a location by mount point.

The code and package cache need a large volume: three releases carry their own
`node_modules`, and the pnpm store is most of a gigabyte. `/h` is routinely at
100%, and `/w/406` is a **2.1 GB, 80k-inode** volume that has already filled.
`/mfs1` has room for code and caches, but its network mount is **not** a safe
SQLite WAL destination. The current script couples `--root` and `state/`, so
that layout needs an approved storage design before using it to move live state.

`deploy` refuses to start if the target volume has less than 4 GB or 200,000
inodes free (`$AURORA_MIN_DEPLOY_FREE_MB`, `$AURORA_MIN_DEPLOY_FREE_INODES`).
This is not hypothetical caution: when `/w/406` filled, SQLite answered every
write with `disk I/O error`, including the audit row each login attempt makes,
so the service returned 500 and the Control UI rendered that as _"That email and
password did not match a lab member account"_ — to a roster of people whose
passwords were correct.

What deliberately stays in the home directory is everything that either has to
be there or should not be on a shared volume: the systemd user units in
`~/.config/systemd/user`, the toolchain in `~/.local`, and the two 0600 secret
files, `~/.config/jinesis-adminbot/adminbot.env` and `~/.openclaw/openclaw.json`.

On the first deploy to a new root, name the source explicitly with `--seed-state`.
An intentionally new installation instead requires `--init-empty-state`. Neither
option can create a new SQLite database on an unsupported filesystem. The
deploying account must own the source database and must be able to stop all
same-account writer services. Confirm no other process writes to the source
during the move, then pass `--confirm-source-quiesced`. The script stops and
checks its known writer units, but it cannot discover other writers. That flag
is an operator attestation, not an automatic proof. The snapshot is
integrity-checked and its table counts are compared with the source before the
new `current` symlink is installed. Those checks cannot detect a concurrent
update that changes a row without changing the table count, so they do not by
themselves guarantee a lossless migration. The previous state and release are
retained for rollback.
If service installation fails, the previous unit definitions are restored, but
the services stay stopped until an operator reviews and restarts them.

Moving to a _different_ root has nothing to inherit from. Name the source only
after arranging approved local storage for both the source snapshot and target:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> \
  --root <approved-local-root> \
  --seed-state <quiesced-local-state-dir> \
  --confirm-source-quiesced \
  deploy
```

The prior network-mount-to-network-mount recipe is deliberately blocked. An
operator must plan the live migration with CSLab and verify where the state will
live; this runbook does not authorize copying live lab data to a workstation or
a new host.

Without either explicit flag, a deploy into an empty new root is **refused**.
There is no automatic fallback to another state directory; an old copy could
silently roll the lab back while looking like a clean deploy. Use
`--init-empty-state` only when creating a genuinely new installation with no
existing records to preserve.

The source is left in place as a fallback. Historical snapshots beside the live
databases (`*.backup-*`, `*.bak-*`, `*.before-*`, `*.empty-*`) and transient
`-wal`/`-shm` files are not copied. Nothing is copied over an existing state
directory. A new state directory is staged and renamed only after verification.
If a later step fails, a pending marker blocks a retry from using that snapshot
until an operator reviews it. A retry never treats a half-completed seed as live
state.

The deploy command installs service definitions but does not start them.
It holds a per-root lock while stopping services, building, seeding, and
switching `current`. A second deploy is refused. If an interrupted run leaves
the lock behind, inspect the state, units, and `current` before an operator
removes it; do not blindly retry.

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
approve the AdminBot Google account (`GOG_ACCOUNT` in `adminbot.env`), then
paste the resulting redirect URL
back into the SSH session.

Calendar event creation uses gog. Calendar ACL changes ("See all events") use
the separate `gws` CLI, so also authenticate `gws` on Aurora and confirm:

```bash
gws auth status
gws calendar acl list --params "{\"calendarId\":\"$ADMINBOT_LAB_EMAIL\"}"
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
the loopback AdminBot API. (The Membership tab's roster grid reads the lab's spreadsheet with no
configuration at all; these variables are the poller's, and re-point the grid as a side effect --
`ADMINBOT_MEMBER_SHEET_URL`, `_GID` or `_TAB` re-point the grid alone, see
[docs/tools/adminbot.md](../tools/adminbot.md).) Add these values to
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

The Vercel-hosted UI cannot directly reach Aurora's private lab-network
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
