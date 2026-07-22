# Install Node.js in an Aurora user account

If deployment reports that Node.js is missing, use the repository helper from
the local checkout:

```bash
scripts/aurora-install-node.sh --user <cs-user>
```

The helper uploads a small installer, downloads the pinned official Node.js 22
Linux archive on Aurora, verifies it against the release SHA-256 manifest, and
installs `node`, `npm`, `npx`, and `corepack` under `~/.local/bin` without sudo.

Verify it:

```bash
ssh aurora.ais.sandbox -l <cs-user> \
  'PATH="$HOME/.local/bin:$PATH" node --version'
```

Then rerun the deployment:

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> --ref HEAD deploy
```
