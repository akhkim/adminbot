# Test one Google Sheets import into SQLite

This standalone check reads a spreadsheet you choose, imports one fictional person's location
through AdminBot's existing HTTP API, and verifies it survived closing and reopening SQLite.
It needs no running AdminBot service, frontend, OpenClaw gateway, or model.

Only three new files implement this check: the script, its tests, and this guide. Existing
production code and deployment settings are unchanged.

## Prepare a test sheet

Create a separate spreadsheet, or a dedicated tab in a spreadsheet you can read. Put this in
cells A1:B2, with no other populated columns or people on that tab:

| AdminBot ID      | Location |
| ---------------- | -------- |
| dev-sheet-person | Zurich   |

Keep the headers and ID exactly as shown. You can change `Zurich` to any nonblank location.
Blank rows after the header are ignored. The script reads the whole tab and rejects extra
columns or people rather than silently importing part of a larger sheet.

Copy the normal browser URL while viewing that tab. A `gid` in the URL identifies the tab;
the spreadsheet ID identifies the workbook. Published-to-web links are not supported.

## Set up Google access once

AdminBot already uses **gog**, a command-line Google Workspace client. It handles Google sign-in
and API calls; this script reuses that reader. The sheet can remain private: the Google account
you authorize must own it or have permission to read it.

Follow the official [gog quickstart](https://github.com/openclaw/gogcli/blob/main/docs/quickstart.md)
for Google Cloud API enablement and Desktop OAuth client setup. On macOS, the current
[installation instructions](https://github.com/openclaw/gogcli#install) use:

```bash
brew install openclaw/tap/gogcli
gog --version
gog auth credentials set /absolute/path/to/client_secret.json
gog auth add you@example.com --services sheets --readonly
export GOG_ACCOUNT=you@example.com
```

Use your actual account address. For older gog versions, consult `gog auth credentials --help`
if `set` is not recognized. `GOG_BIN` can name an absolute executable path if gog is not on PATH.
The reader also checks `~/.local/bin/gog`. Keep downloaded OAuth credentials outside the repo;
do not paste tokens into the script or sheet. The script does not load `.env` files automatically.

## Run the check

Use Node 22.19+ with workspace dependencies installed. Run from `openclaw-adminbot/`:

```bash
node --import tsx scripts/adminbot-member-sheet-smoke.ts \
  --sheet "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit#gid=YOUR_TAB_ID"
```

Alternatively, pass a spreadsheet ID and an explicit tab name:

```bash
node --import tsx scripts/adminbot-member-sheet-smoke.ts \
  --sheet "YOUR_SHEET_ID" --tab "Sync Test"
```

`--tab` overrides the URL's tab. If neither is supplied, a workbook with exactly one tab is
accepted automatically; otherwise the error lists tab names to choose from. A nonexistent
tab fails instead of falling back to another tab or the lab spreadsheet.

For the example above, successful output includes:

```text
Location before: "Toronto"
Sheet location: "Zurich"
Dry-run preview: 1 update(s)
Location after reopening SQLite: "Zurich"
PASS: 1 update(s) applied and persisted; repeat import: 0 updates.
Temporary service stopped and database removed. Google Sheets was only read.
```

Append `--dry-run` to preview only. That still creates the temporary database and seeds Toronto,
but sends no profile update; reopening SQLite must still show Toronto. If the Sheet already says
Toronto, a normal run correctly reports zero updates.

## What is isolated

Each invocation reads a fresh Sheet snapshot, starts its own loopback service on a free port,
generates a temporary service token, and creates a temporary SQLite database. It ignores the
production service URL, port, token, and database configuration. No login credentials or external
connector executors are provisioned. Only the synthetic member's location can be imported.

The dry run, application, and repeat check use the same validated snapshot. Edit the Sheet and
rerun the command to test another value. The temporary service and database are cleaned up after
success or a handled failure; this is a persistence check, not a retained local roster.

Google Sheets is only read. Nothing is installed or scheduled. Multiple people, production
imports, automatic polling, and push notifications are outside this first step.

## Troubleshooting and tests

- **Missing gog:** install it, or export `GOG_BIN=/absolute/path/to/gog` before running.
- **Google read failed:** check the spreadsheet ID, signed-in account, Sheets API enablement,
  sheet sharing permissions, and gog authentication. Reauthorize if the grant expired. Raw
  Google/keyring errors are deliberately omitted from the script's normal output.
- **Wrong layout:** use the two headers in row 1 and the single `dev-sheet-person` row shown above.
- **Unknown tab:** copy the URL from the desired tab, or supply its exact title with `--tab`.
- **Missing tsx or unsupported SQLite:** install workspace dependencies and use the supported Node runtime.

Automated tests need no Google account. They use synthetic Sheet responses (and a fake gog for
the CLI check), real loopback HTTP, and real temporary SQLite databases:

```bash
node scripts/run-vitest.mjs run test/scripts/adminbot-member-sheet-smoke.test.ts
```
