# Aurora push — ready to run

Everything below is prepared but **not executed**. Deploying restarts AdminBot and the Gateway on
Aurora, and the reference-check tool sends outward email once approved, so this is yours to run.

Ref to deploy: **`cb927f8a579`** (`feat(adminbot): branch the paper timeline and derive conferences from active papers`),
the same commit the live Vercel bundle was built from. It is committed, so the "never deploy from a
dirty tree" rule holds.

## 1. Deploy the release

```bash
cd <path-to-your-clone>
read -rs AURORA_SSH_PASSWORD; export AURORA_SSH_PASSWORD   # avoids a prompt per SSH/SCP call
scripts/aurora-adminbot-host.sh --user <cs-user> --ref cb927f8a579 deploy
```

This uploads, builds, and installs the release, then regenerates the systemd units. Note that
`install-user-services.sh` deletes `jinesis-adminbot-email.timer` by design — the hourly email pass
is an OpenClaw cron job now, which step 2 pushes.

## 2. Push the cron jobs (needed — the schedule lives here, not on Aurora)

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> sync-cron-jobs
```

Sends all three local jobs, rewriting the repo path to the remote release path:

| Job                                     | Schedule             | Notes                                                                          |
| --------------------------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `adminbot-email-automation`             | `7 * * * *`          | Recreated this session; the previous job had vanished                          |
| `adminbot-openreview`                   | `15 0,6,12,18 * * *` | Now green locally after the env-file fix                                       |
| `tool: hallucinated reference check`    | disabled             | Run-on-command; scoped to 2 papers/venue (a full sweep exceeds the 60 min cap) |
| `tool: deadline calendar — preview`     | disabled             | Run-on-command; writes nothing                                                 |
| `tool: deadline calendar — conferences` | disabled             | Run-on-command; **writes to the lab calendar**                                 |
| `tool: deadline calendar — all venues`  | disabled             | Run-on-command; **writes ~100 events**                                         |
| `tool: refresh deadline venues`         | disabled             | Run-on-command                                                                 |
| `tool: refresh deadline matches`        | disabled             | Run-on-command; needs the two sheet ids                                        |
| `tool: deadline reminders — preview`    | disabled             | Run-on-command; needs matches.json first                                       |

The seven `tool:` jobs are what populates **Tasks & Tools → Run on command**. They are disabled, so
they never fire on their own; the sync preserves that. Until this step runs they exist only on this
machine, which is why the tab looks empty on the hosted UI.

## 2b. Push the papers database (needed — the 92 sheet-sourced papers live here)

```bash
scripts/aurora-adminbot-host.sh --user <cs-user> sync-adminbot-data
```

The conference/stage backfill from the mentee survey was written to the **local** AdminBot
database. jinesis-admin.vercel.app reads _Aurora's_ AdminBot, so until this runs the site still
shows the old 37 papers with "Unspecified" conferences. The command snapshots with VACUUM INTO,
stops the service, backs up the old database with a timestamp, and swaps atomically.

## Why Aurora matters for the new timeline

The branched Gantt is computed **server-side** in `buildPaperTimeline` (`depends_on` edges plus
longest-path scheduling). The Vercel UI only packs whatever `depends_on`/offsets the API returns,
so until Aurora runs this commit the API still emits the old linear chain and the overview will
render a single lane. The announcements conference filter is client-side and already live.

## 3. Verify

```bash
ssh "<cs-user>@$AURORA_HOST"
systemctl --user status jinesis-adminbot.service jinesis-openclaw-gateway.service jinesis-vllm.service
set -a; . ~/.config/jinesis-adminbot/adminbot.env; set +a
curl -H "Authorization: Bearer $VLLM_API_KEY" http://127.0.0.1:8000/v1/models   # expect Qwen3.5-122B
node ~/services/openclaw-adminbot/current/openclaw.mjs cron list --all          # expect the 3 jobs

# the timeline should now branch: slides start with the drive PDF, not after the announcements
curl -s -H "Authorization: Bearer $ADMINBOT_SERVICE_TOKEN" http://127.0.0.1:8765/papers \
  | python3 -c "import sys,json; t=json.load(sys.stdin)['papers'][0]['timeline']; \
print('schedule days:', t['total_estimated_business_days']); \
[print(f\"  {i['step']:20s} {i['offset_start_business_day']:>2}->{i['offset_end_business_day']:<2} after={i['depends_on']}\") for i in t['items']]"
# expect 12 schedule days, slide_making 8->10 after ['submission']
```

## Env file — two additions worth making

`~/.config/jinesis-adminbot/adminbot.env` on Aurora needs nothing for the deploy to succeed, but:

- **`SEMANTIC_SCHOLAR_API_KEY`** (not yet obtained) — without it the reference check demotes every
  verdict that would accuse an author, so only DOI-level contradictions produce a warning email.
  Adding the key turns the full verdict set back on with no code change.
- **`ADMINBOT_REFERENCE_CHECK_VENUES`** — defaults to
  `EMNLP/2026/Conference,aclweb.org/ACL/ARR/2026/August`. Set it only to override.

## Files this push carries

Commits `4fcc6f1d329..cb927f8a579` on `codex/adminbot-gog-update`:

**New**

- `scripts/adminbot-reference-check.mjs`, `scripts/lib/reference-verifier.mjs`,
  `scripts/adminbot-pdf-references.py` — reference checker
- `scripts/adminbot-email-cron.sh`, `scripts/lib/adminbot-cron-env.sh` — cron wrappers
- `test/scripts/reference-verifier.test.ts`, `docs/tools/adminbot-reference-check.md`

**Changed**

- `scripts/adminbot-openreview.py` — `author-submissions` command
- `scripts/adminbot-openreview-cron.sh` — env-file resolution
- `scripts/adminbot-email-automation.ts` + its SKILL — onboarding wording
- `ui/**` — papers timeline editing, Tasks & Tools, announcements filter (already on Vercel)
- `extensions/adminbot/content/deadlines/**`, `ui/src/ui/deadlines-data.ts`,
  `scripts/adminbot-deadline-*.py` — the arian-branch merge, 78 → 106 venues
- `docs/deploy/aurora-runtime-bootstrap.md`

## Not included

These were already dirty in the working tree before this session and are **not** committed, so the
deploy will not carry them: `.gitignore`, `deploy/aurora/install-user-services.sh`,
`docs/tools/adminbot-openreview.md`, the `adminbot-paper-publish` and `adminbot-social-posts`
SKILLs, and `src/agents/bash-tools.exec*`. Commit them separately if Aurora needs them —
`install-user-services.sh` in particular has a local change to the release-root resolution.
