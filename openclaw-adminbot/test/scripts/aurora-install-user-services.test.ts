import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SHUTDOWN_GRACE_MS } from "../../extensions/adminbot/src/inference/config.js";

const installer = path.join(process.cwd(), "deploy/aurora/install-user-services.sh");

function unitBlock(script: string, unit: string): string {
  const start = script.indexOf(`cat >"$UNIT_DIR/${unit}" <<EOF`);
  expect(start).toBeGreaterThanOrEqual(0);
  return script.slice(start, script.indexOf("\nEOF", start));
}

describe("AdminBot user service", () => {
  // SIGTERM makes the service drain the task runner for up to the shutdown grace and then close
  // its databases; systemd SIGKILLs the unit at TimeoutStopSec. A stop timeout at or below the
  // longest grace an admin can set kills the drain and the clean close it was meant to protect.
  it("allows a stop to run past the longest shutdown grace", () => {
    const block = unitBlock(fs.readFileSync(installer, "utf8"), "jinesis-adminbot.service");
    const match = /^TimeoutStopSec=(\d+)$/mu.exec(block);
    expect(match).not.toBeNull();
    expect(Number(match![1]) * 1000).toBeGreaterThanOrEqual(MAX_SHUTDOWN_GRACE_MS + 30_000);
  });
});
