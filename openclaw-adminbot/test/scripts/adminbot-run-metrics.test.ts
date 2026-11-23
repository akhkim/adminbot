import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeRunMetrics } from "../../scripts/lib/adminbot-run-metrics.js";

describe("writeRunMetrics", () => {
  it("appends name<TAB>count lines and skips values that are not counts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "adminbot-run-metrics-"));
    try {
      const file = path.join(dir, "metrics");
      writeRunMetrics({ "emails.found": 4, errors: 0 }, file);
      writeRunMetrics({ needs_review: 2, bad: -1, half: 1.5, none: undefined }, file);
      expect(readFileSync(file, "utf8")).toBe("emails.found\t4\nerrors\t0\nneeds_review\t2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does nothing outside the cron wrapper and never throws", () => {
    expect(() => writeRunMetrics({ errors: 1 }, undefined)).not.toThrow();
    expect(() => writeRunMetrics({ errors: 1 }, "/nonexistent-dir/x/metrics")).not.toThrow();
  });
});
