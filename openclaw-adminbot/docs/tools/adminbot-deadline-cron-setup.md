# Deadline cron setup after deployment

After deploying and starting the reviewed release, register the two existing jobs from the deployed `openclaw-adminbot` directory using the shared sync script:

```bash
bash scripts/adminbot-cron-sync.sh --only adminbot-deadline-refresh-venues
bash scripts/adminbot-cron-sync.sh --only adminbot-deadline-refresh-matches
```

Add `--dry-run` to preview either operation. Repeat the sync after a new release so the registered commands reference its paths. Existing pauses are preserved; other jobs are left alone. Ordinary service starts and restarts do not change registration.

Check the gateway after synchronization:

```bash
node openclaw.mjs cron status --json
node openclaw.mjs cron list --all --json
```

Verify that scheduling is enabled and exactly one job exists for each name. Confirm both jobs are enabled, their command paths and working directories reference the deployed release, and their next runs and timezone are correct. If a job is deliberately paused, resolve that with its operator before enabling it.

The venue job runs daily at 05:50 and matching at 06:20 in the gateway timezone. Registration does not trigger collection. For an immediate collection:

```bash
bash scripts/adminbot-deadline-cron.sh refresh-venues
```

Check the served `/deadlines/venues.json`, including per-record source-check timestamps and failure status. Registration success does not establish source freshness. Live collection and served-data verification require access to the deployed host.
