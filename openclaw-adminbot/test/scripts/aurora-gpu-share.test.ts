// Runs the GPU-share gate's own Python tests (deploy/aurora/gpu-share) in the node lane, so CI
// covers the gate that fronts AdminBot's model: forwarding, the wall around vLLM's dev-mode
// endpoints, idle sleep, preempting borrowers, and the borrow wrapper.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
const hasPython = python.status === 0;

describe("deploy/aurora/gpu-share", () => {
  it.skipIf(!hasPython)(
    "passes its unittest suite",
    () => {
      const dir = path.resolve(import.meta.dirname, "../../deploy/aurora/gpu-share");
      const run = spawnSync(
        "python3",
        ["-m", "unittest", "discover", "-s", dir, "-p", "test_*.py"],
        {
          encoding: "utf8",
          timeout: 120_000,
        },
      );
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
      expect(run.stderr).toMatch(/\bOK\b/u);
    },
    150_000,
  );
});
