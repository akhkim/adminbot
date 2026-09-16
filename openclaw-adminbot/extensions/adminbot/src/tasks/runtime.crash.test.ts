import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { TaskRuntime } from "./runtime.js";

it.each(["after_step", "during_step", "during_commit", "after_commit"])(
  "recovers real SIGKILL at %s without repeating committed work",
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "task-crash-"));
    const file = join(dir, "state.sqlite");
    const child = fork(
      fileURLToPath(new URL("./runtime.crash.test-support.ts", import.meta.url)),
      [file, mode],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] },
    );
    let stderr = "";
    child.stderr?.on("data", (data) => (stderr += String(data)));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Child timeout: ${stderr}`)), 10000);
        child.once("message", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`Child exited ${code}: ${stderr}`));
        });
      });
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      });
      const db = new DatabaseSync(file);
      const runtime = new TaskRuntime({ db, persist: true });
      let calls = 0;
      runtime.register("crash", 1, async (_, ctx) => {
        expect(
          await ctx.step("completed", {}, () => {
            calls++;
            throw new Error("completed step repeated");
          }),
        ).toBe("saved");
        if (mode === "during_step") {
          await ctx.step("uncertain", {}, () => "explicit retry");
        }
        ctx.commit("commit", {}, () => {
          db.prepare("INSERT INTO crash_effects VALUES('commit')").run();
          return 3;
        });
        return "done";
      });
      runtime.start();
      const task = runtime.list("owner")[0];
      if (mode === "during_step") {
        expect(task.status).toBe("needs_retry");
        expect(calls).toBe(0);
        const result = runtime.retry(task.id, "owner")!;
        expect((await result.promise)!.result).toBe("done");
      } else {
        const result = runtime.wait(task.id, "owner")!;
        expect((await result.promise)!.result).toBe("done");
      }
      expect(calls).toBe(0);
      expect(
        db.prepare("SELECT count(*) n FROM crash_effects WHERE name='completed'").get()!.n,
      ).toBe(1);
      expect(db.prepare("SELECT count(*) n FROM crash_effects WHERE name='commit'").get()!.n).toBe(
        1,
      );
      await runtime.shutdown({ graceMs: 0 });
      db.close();
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
