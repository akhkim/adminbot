// Tests GOG command detection for one-shot keyring password prompts.
import { describe, expect, it } from "vitest";
import { commandUsesGog } from "./gog-keyring-password.js";

describe("commandUsesGog", () => {
  it("detects gog and gog-wrapper commands", () => {
    expect(commandUsesGog("gog gmail watch start")).toBe(true);
    expect(commandUsesGog("/tmp/bin/gog-wrapper calendar events")).toBe(true);
    expect(commandUsesGog("echo ok && gog tasks list")).toBe(true);
  });

  it("ignores unrelated command text", () => {
    expect(commandUsesGog("echo gog")).toBe(false);
    expect(commandUsesGog("agoggle --version")).toBe(false);
    expect(commandUsesGog(undefined)).toBe(false);
  });
});
