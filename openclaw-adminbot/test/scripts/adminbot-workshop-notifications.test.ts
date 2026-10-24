import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("separates workshop notification dates and shared requirements", () => {
  const fixture = fileURLToPath(
    new URL("./adminbot-workshop-notifications.test.py", import.meta.url),
  );
  expect(() => execFileSync("python3", [fixture], { encoding: "utf8" })).not.toThrow();
});
