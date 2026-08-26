// The cron sync, against a gateway CLI that behaves like the real one.
//
// `openclaw cron add` reads stdin -- it renders prompts and notices through a TUI. The first
// version of this script fed the plan into the loop's stdin, so the first `add` drained the whole
// remaining plan and seventeen of eighteen jobs were never registered. The run still exited 0 and
// printed the swallowed lines, which is exactly the shape of failure that gets deployed.
//
// So the stub here drains stdin on purpose. A sync that only works against a well-behaved CLI is a
// sync that works in this test and nowhere else.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/adminbot-cron-sync.sh");
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "config/adminbot-cron.json"), "utf8"),
) as { jobs: Array<{ name: string }> };

const temporaries: string[] = [];

/** A stand-in for `openclaw cron` that drains stdin, as the real one does. */
function greedyStub(existing: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-sync-"));
  temporaries.push(dir);
  const stub = path.join(dir, "openclaw-stub.sh");
  fs.writeFileSync(
    stub,
    `#!/usr/bin/env bash\n` +
      `if [[ "$1" == "cron" && "$2" == "list" ]]; then echo '${existing}'; exit 0; fi\n` +
      `cat >/dev/null\n` +
      `printf 'CALL %s %s\\n' "$2" "$4"\n`,
    { mode: 0o755 },
  );
  return stub;
}

function run(stub: string, args: string[] = []): string {
  return execFileSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_BIN: stub },
  });
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/adminbot-cron-sync.sh", () => {
  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", script])).not.toThrow();
  });

  it("registers every job even though the CLI eats its stdin", () => {
    const output = run(greedyStub("[]"));
    const registered = [...output.matchAll(/^CALL add (\S+)$/gmu)].map((match) => match[1]);
    expect(registered.toSorted()).toEqual(manifest.jobs.map((job) => job.name).toSorted());
  });

  it("edits what is already there instead of adding it twice", () => {
    const existing = JSON.stringify({ jobs: manifest.jobs.slice(0, 3) }).replaceAll("'", "");
    const output = run(greedyStub(existing));
    expect([...output.matchAll(/^CALL edit (\S+)$/gmu)]).toHaveLength(3);
    expect([...output.matchAll(/^CALL add (\S+)$/gmu)]).toHaveLength(manifest.jobs.length - 3);
  });

  it("names a job it did not put there, and leaves it alone", () => {
    const output = run(greedyStub(JSON.stringify({ jobs: [{ name: "someones-own-job" }] })));
    expect(output).toContain("someones-own-job is in the store but not in the manifest");
    expect(output).not.toContain("CALL add someones-own-job");
  });

  it("changes nothing on a dry run", () => {
    const output = run(greedyStub("[]"), ["--dry-run"]);
    expect(output).toContain("would add adminbot-email");
    expect(output).not.toContain("CALL ");
  });

  it("applies one job with --only", () => {
    const output = run(greedyStub("[]"), ["--only", "adminbot-nudge-escalation"]);
    expect([...output.matchAll(/^CALL \S+ (\S+)$/gmu)].map((match) => match[1])).toEqual([
      "adminbot-nudge-escalation",
    ]);
  });
});
