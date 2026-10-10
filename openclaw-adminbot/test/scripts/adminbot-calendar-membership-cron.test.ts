import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("Sunday membership cron", () => {
  it.each([false, true])("runs both connectors when Slack fails: %s", (failSlack) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-calendar-cron-"));
    try {
      const envFile = path.join(dir, "env");
      const log = path.join(dir, "calls");
      writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
      writeFileSync(
        path.join(dir, "curl"),
        '#!/bin/bash\nprintf "%s\\n" "${@: -1}" >> "$TEST_CALLS"\nif [[ "$TEST_FAIL_SLACK" == 1 && "${@: -1}" == */active-channels/sync ]]; then exit 1; fi\n',
        { mode: 0o700 },
      );
      let failed = false;
      try {
        execFileSync("bash", ["scripts/adminbot-active-channels-cron.sh"], {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            ADMINBOT_ENV_FILE: envFile,
            TEST_CALLS: log,
            TEST_FAIL_SLACK: failSlack ? "1" : "0",
          },
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(failSlack);
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain("/members/active-channels/sync");
      expect(calls).toContain("/members/calendar-membership/sync");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
