// Control UI tests cover theme behavior.
import { describe, expect, it } from "vitest";
import { parseThemeSelection, resolveSystemTheme, resolveTheme } from "./theme.ts";

describe("resolveTheme", () => {
  it("resolves the single dark theme regardless of mode", () => {
    expect(resolveTheme("claw", "dark")).toBe("dark");
    expect(resolveTheme("claw", "light")).toBe("dark");
    expect(resolveTheme("claw", "system")).toBe("dark");
  });

  it("resolves the custom theme escape hatch to its dark-only variant", () => {
    expect(resolveTheme("custom", "dark")).toBe("custom");
    expect(resolveTheme("custom", "light")).toBe("custom");
  });
});

describe("resolveSystemTheme", () => {
  it("always resolves dark (dark-only, no system preference to mirror)", () => {
    expect(resolveSystemTheme()).toBe("dark");
  });
});

describe("parseThemeSelection", () => {
  it("normalizes legacy stored values onto the single dark theme", () => {
    expect(parseThemeSelection("system", undefined)).toEqual({
      theme: "claw",
      mode: "dark",
    });
    expect(parseThemeSelection("fieldmanual", undefined)).toEqual({
      theme: "claw",
      mode: "dark",
    });
  });

  it("normalizes the removed knot/dash theme families instead of throwing", () => {
    expect(parseThemeSelection("knot", "dark")).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection("dash", undefined)).toEqual({ theme: "claw", mode: "dark" });
  });

  it("keeps a legacy light themeMode value but resolveTheme still collapses it to dark", () => {
    expect(parseThemeSelection("claw", "light")).toEqual({ theme: "claw", mode: "light" });
  });

  it("preserves the custom theme escape hatch", () => {
    expect(parseThemeSelection("custom", "dark")).toEqual({ theme: "custom", mode: "dark" });
  });
});
