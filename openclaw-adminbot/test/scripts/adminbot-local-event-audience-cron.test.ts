import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("local lunch cron", () => {
  it.each([false, true])(
    "checks both series and stops on a missing guest list (bad read: %s)",
    (badRead) => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-lunch-"));
      try {
        const envFile = path.join(dir, "env");
        const log = path.join(dir, "calls");
        writeFileSync(envFile, "ADMINBOT_SERVICE_TOKEN=synthetic-test-token\n");
        writeFileSync(
          path.join(dir, "gog"),
          `#!/bin/bash
if [[ "$TEST_BAD_READ" == 1 && "\${@: -1}" == monday ]]; then echo '{}'; else echo '{"attendees":[{"email":"room@example.test"}]}'; fi
`,
          { mode: 0o700 },
        );
        writeFileSync(
          path.join(dir, "curl"),
          `#!/bin/bash
while (( $# )); do
  if [[ "$1" == -d ]]; then printf '%s\\n' "$2" >> "$TEST_CALLS"; fi
  shift
done
printf '{"proposals":[],"keep":[]}\\n200'
`,
          { mode: 0o700 },
        );
        let failed = false;
        try {
          execFileSync(
            "bash",
            [
              "scripts/adminbot-local-event-audience-cron.sh",
              "--calendar-id",
              "lab@example.test",
              "--event-id",
              "monday",
              "--event-id",
              "thursday",
            ],
            {
              env: {
                ...process.env,
                PATH: `${dir}:${process.env.PATH}`,
                ADMINBOT_ENV_FILE: envFile,
                GOG_BIN: path.join(dir, "gog"),
                TEST_CALLS: log,
                TEST_BAD_READ: badRead ? "1" : "0",
              },
              stdio: "pipe",
            },
          );
        } catch {
          failed = true;
        }
        expect(failed).toBe(badRead);
        if (!badRead) {
          const calls = readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          expect(calls.map((row) => row.event_id)).toEqual(["monday", "thursday"]);
          expect(calls.every((row) => row.calendar_id === "lab@example.test")).toBe(true);
          expect(calls.every((row) => row.attendees[0] === "room@example.test")).toBe(true);
        } else {
          expect(() => readFileSync(log)).toThrow();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
