# Local development fixtures

`fixtures/members.json` contains five fictional people: an administrator, a member, a trial
member, an external collaborator, and a member on leave. Each gets a usable login. This dataset
is for interactive development; automated tests create temporary databases of their own.

## One-command startup

From the outer `adminbot/` repository directory, run:

```bash
./dev.sh
```

The executable works from any directory when called by its absolute path. It installs dependencies
if missing, seeds the fictional accounts, starts the backend with Node's file watcher on port 8801,
and starts the Vite frontend on port 5173. Open the **Frontend** link printed in the terminal:
it configures the UI to use the development backend. Both listeners bind to loopback.
Opening the plain Vite URL also works in a fresh browser: the picker saves the launcher's local
backend address when none is configured. If this browser already points at another backend, the
picker preserves that setting and offers a link to open the local development backend.

The frontend shows a **Local test accounts** picker: click a person to sign in, then sign out
normally to choose another. It uses the normal password login and preserves each account's role.
The default manual login is `alice@example.test` with the local test password `LocalDevOnly-123!`.
Set `ADMINBOT_DEV_PASSWORD` before running the launcher if you previously seeded another password;
existing passwords are never reset. Press Ctrl+C to stop both services. Backend code changes restart
the backend, frontend changes reload in Vite, and fixture JSON changes require rerunning the seed
or restarting this launcher.

Override `ADMINBOT_PORT` or `ADMINBOT_DEV_UI_PORT` to change ports. If either port is occupied,
the launcher exits before seeding and leaves the existing process alone.

Start your personal OpenClaw gateway before running `./dev.sh`. The launcher checks its local
port, shared-auth configuration, and allowed UI origin before seeding. It does not change your
OpenClaw settings or start/stop your gateway. The backend reuses the normal device-token issuance
and privilege-capped pairing code. No service-only bypass is needed or supported.

By default the gateway URL is `ws://127.0.0.1:18789`; set `ADMINBOT_GATEWAY_WS_URL` if your
configured gateway port differs. Both processes must share the same OpenClaw configuration,
state directory and auth secret. Add `http://127.0.0.1:5173` to `gateway.controlUi.allowedOrigins`
(or your overridden UI port), preserving existing origins, then restart the gateway. Model
credentials are required for agent chat, not fixture sign-in.

The fixture backend keeps `state/adminbot-dev.sqlite` and stubbed calendar/email invitations.
It does not load the normal host's live connector composition. The default CheckIfExist
checker needs no API key. It extracts references locally and queries public scholarly databases;
submissions perform real lookups, including in development. Selecting GPTZero instead uploads the
full PDF and requires `GPTZERO_API_KEY` with bibliography API access; submissions may incur charges.
Ctrl+C stops only the development backend and UI, leaving your personal gateway running.

The picker is injected only by the opt-in Vite development server launched through `dev.sh`.
It is excluded from builds (including builds run with the picker flag), disabled in production
mode, and not enabled by ordinary `pnpm ui:dev`. The launcher refuses `NODE_ENV=production`.
Its script is served without caching at a per-run URL, only to the same loopback origin. The
browser refuses to fill credentials if the configured backend differs from the launcher's local
backend. No authentication bypass or new login endpoint is installed in the production service.
Development passwords are accessible to the local browser; use only synthetic credentials here.

## Manual startup

From `openclaw-adminbot/`, after installing dependencies:

```bash
export ADMINBOT_DEV_PASSWORD='LocalDevOnly-123!'
node --import tsx scripts/seed-adminbot-dev.ts

ADMINBOT_DEV_EMAIL=alice@example.test \
ADMINBOT_PORT=8801 \
node --import tsx scripts/start-adminbot-dev.ts
```

Open <http://127.0.0.1:8801/adminbot>. The development database defaults to
`state/adminbot-dev.sqlite`. For the full Control UI, run `pnpm ui:dev` and configure its AdminBot
service URL to point at this development service. Sign in as `alice@example.test`,
`bob@example.test`, `carol@example.test`, `dan@example.test`, or `erin@example.test`, using the
password supplied when their accounts were first seeded. Use Alice with the development launcher:
that launcher promotes its `ADMINBOT_DEV_EMAIL` account to admin.

The seed command is also available as `pnpm adminbot:dev:seed`.

## Editing and repeating the seed

- Edit the JSON and run the seed again to update the same profiles by their stable `dev-*` IDs.
  Only fields present in the fixture are patched; removing a field from the JSON does not clear it.
- Existing passwords are preserved, even if `ADMINBOT_DEV_PASSWORD` changes. The password setting
  applies only to newly created accounts. Use the app's password-change flow for an existing account.
- Members removed from the fixture remain in the database. Unrelated members are left alone.
- IDs and email addresses are identities: keep them stable. Collisions with existing accounts or
  pending registrations are refused before any profile is updated.
- To start fresh without deleting anything, set `ADMINBOT_DEV_DATABASE=state/fresh-dev.sqlite`
  for both commands. Paths are resolved relative to `openclaw-adminbot/`.
- `ADMINBOT_DEV_FIXTURE` can select another JSON file. The database filename must end in
  `-dev.sqlite`; the normal `adminbot.sqlite` database is refused, including symlinks to it.

Supported fixture fields are `id`, `name`, `email`, `privilege_level`, `role`, `status`,
`location`, `timezone`, `affiliation`, `research_branch`, `research_topics`, `projects`,
`hours_per_week`, and `notes`. IDs must start with `dev-`; emails must use the reserved
`example.test`, `example.com`, `example.org`, or `example.net` domains. Omitted privileges default
to `external_collaborator`. All rows are validated before the destination database is opened.

The seeder uses the service's member validation and the auth claim/approval flow. It installs no
external executors or notification callbacks and never contacts Sheets, Slack, email, or Calendar.
This describes the seeder only: the development web service is not a comprehensive offline mock
of every integration. Keep real credentials out of local fixture sessions.

Commit the fictional JSON, not passwords or generated databases. `state/` remains ignored.

## Tests

```bash
node scripts/run-vitest.mjs run test/scripts/seed-adminbot-dev.test.ts
```

The tests use temporary SQLite files and check persistence, logins, repeat seeding, identity
collisions, fixture validation, and refusal to seed the normal database.
