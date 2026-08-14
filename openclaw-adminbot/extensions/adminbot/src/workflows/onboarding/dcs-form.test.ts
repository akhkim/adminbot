import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDcsFormRunner } from "./dcs-form.js";

// Exercises the real execFile path (no `run` override) against a tiny fixture script instead of
// the actual Playwright-driven one, so the connector's argv-encoding and stdout-parsing are
// covered without ever touching a browser or the real DCS form.
function writeFixtureScript(body: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "dcs-form-fixture-"));
  const file = path.join(dir, "fixture.mjs");
  writeFileSync(file, body, "utf8");
  return { path: file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("dcs form runner", () => {
  it("is undefined when neither a script path nor a run override is configured", () => {
    expect(createDcsFormRunner({})).toBeUndefined();
  });

  it("prefers an injected run override to spawning anything", async () => {
    const calls: Array<{ firstName: string; lastName: string; email: string }> = [];
    const submit = createDcsFormRunner({
      // A real scriptPath is present too, to prove `run` wins rather than both firing.
      scriptPath: "/should/not/be/used.ts",
      run: async (params) => {
        calls.push(params);
      },
    });
    expect(submit).toBeDefined();

    await submit!({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" });

    expect(calls).toEqual([{ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }]);
  });

  it("propagates a rejection from the run override", async () => {
    const submit = createDcsFormRunner({
      run: async () => {
        throw new Error("form layout changed");
      },
    });

    await expect(
      submit!({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }),
    ).rejects.toThrow("form layout changed");
  });

  describe("spawning the real script (no run override)", () => {
    let fixture: { path: string; cleanup: () => void } | undefined;

    afterEach(() => {
      fixture?.cleanup();
      fixture = undefined;
    });

    it("passes firstName/lastName/email as one JSON argv, and resolves on {ok:true}", async () => {
      const receivedPath = path.join(tmpdir(), `dcs-form-received-${Date.now()}.json`);
      fixture = writeFixtureScript(
        `import { writeFileSync } from "node:fs";\n` +
          `writeFileSync(${JSON.stringify(receivedPath)}, process.argv[2]);\n` +
          `process.stdout.write(JSON.stringify({ ok: true }));\n` +
          `process.exitCode = 0;\n`,
      );
      const submit = createDcsFormRunner({ scriptPath: fixture.path });

      await expect(
        submit!({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }),
      ).resolves.toBeUndefined();

      const received = JSON.parse(readFileSync(receivedPath, "utf8")) as Record<string, string>;
      expect(received).toEqual({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.test",
      });
      rmSync(receivedPath, { force: true });
    });

    it("rejects with the script's own error when it reports {ok:false}", async () => {
      fixture = writeFixtureScript(
        `process.stdout.write(JSON.stringify({ ok: false, error: "sponsor not found" }));\n` +
          `process.exitCode = 1;\n`,
      );
      const submit = createDcsFormRunner({ scriptPath: fixture.path });

      await expect(
        submit!({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }),
      ).rejects.toThrow("sponsor not found");
    });

    it("rejects when the script produces no parseable JSON at all", async () => {
      fixture = writeFixtureScript(
        `console.log("totally unexpected crash");\nprocess.exitCode = 1;\n`,
      );
      const submit = createDcsFormRunner({ scriptPath: fixture.path });

      await expect(
        submit!({ firstName: "Ada", lastName: "Lovelace", email: "ada@example.test" }),
      ).rejects.toThrow(/no JSON result/u);
    });
  });
});
