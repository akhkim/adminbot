import { DatabaseSync } from "node:sqlite";
import { TaskRuntime } from "./runtime.js";
const db = new DatabaseSync(process.argv[2]);
const mode = process.argv[3];
const runtime = new TaskRuntime({ db, persist: true });
db.exec("CREATE TABLE IF NOT EXISTS crash_effects (name TEXT PRIMARY KEY)");
const effect = (name: string) => db.prepare("INSERT INTO crash_effects VALUES(?)").run(name);
const stop = () => {
  process.send?.("checkpoint");
  return new Promise<never>(() => {});
};
runtime.register("crash", 1, async (_, ctx) => {
  await ctx.step("completed", {}, () => {
    effect("completed");
    return "saved";
  });
  if (mode === "after_step") {
    return stop();
  }
  if (mode === "during_step") {
    return ctx.step("uncertain", {}, () => {
      effect("uncertain");
      return stop();
    });
  }
  if (mode === "during_commit") {
    return ctx.commit("commit", {}, () => {
      effect("commit");
      process.send?.("checkpoint");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return 3;
    });
  }
  ctx.commit("commit", {}, () => {
    effect("commit");
    return 3;
  });
  return stop();
});
runtime.submit({ kind: "crash", owner: "owner", key: "stable", input: null });
setInterval(() => {}, 1000);
