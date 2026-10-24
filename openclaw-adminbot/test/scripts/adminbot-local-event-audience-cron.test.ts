import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("automatic lunch cron", () => {
  it("calls the server-derived policy rather than supplying recipients or fixed events", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-lunch-"));
    try {
      const log = path.join(dir, "calls");
      const env = path.join(dir, "env");
      writeFileSync(env, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
      writeFileSync(path.join(dir, "curl"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$TEST_CALLS"\n', {
        mode: 0o700,
      });
      execFileSync("bash", ["scripts/adminbot-local-event-audience-cron.sh"], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ADMINBOT_ENV_FILE: env,
          TEST_CALLS: log,
        },
      });
      const calls = readFileSync(log, "utf8");
      expect(calls).toContain("/calendar/local-lunch-invites/run");
      expect(calls).not.toContain("--data");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
