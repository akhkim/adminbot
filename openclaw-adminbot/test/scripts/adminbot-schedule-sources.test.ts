import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("validates official schedule evidence and refresh transitions", () => {
  const fixture = fileURLToPath(new URL("./adminbot-schedule-sources.test.py", import.meta.url));
  expect(() => execFileSync("python3", [fixture], { encoding: "utf8" })).not.toThrow();
});
