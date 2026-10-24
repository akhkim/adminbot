// Control UI tests cover theme behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveTheme } from "./theme.ts";

/** Pretends the operating system is asking for one scheme or the other. */
function systemPrefers(scheme: "light" | "dark") {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-color-scheme: light") === (scheme === "light"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveTheme", () => {
  it("paints what the mode asks for", () => {
    expect(resolveTheme("claw", "dark")).toBe("dark");
    expect(resolveTheme("claw", "light")).toBe("light");
  });

  it("ignores what the operating system prefers", () => {
    // There is no system mode: a light machine still gets the dark default until somebody picks
    // light here.
    systemPrefers("light");
    expect(resolveTheme("claw", "dark")).toBe("dark");
    systemPrefers("dark");
    expect(resolveTheme("claw", "light")).toBe("light");
  });

  it("keeps the custom escape hatch dark whatever the mode says", () => {
    // A pasted palette is a whole theme, not a variant of ours to take a light version of.
    expect(resolveTheme("custom", "dark")).toBe("custom");
    expect(resolveTheme("custom", "light")).toBe("custom");
  });
});

describe("parseThemeSelection", () => {
  it("gives back a light preference somebody stored before light was removed", () => {
    expect(parseThemeSelection("light", undefined)).toEqual({ theme: "claw", mode: "light" });
    expect(parseThemeSelection("lightTheme", undefined)).toEqual({ theme: "claw", mode: "light" });
    expect(parseThemeSelection("docsTheme", undefined)).toEqual({ theme: "claw", mode: "light" });
  });

  it("migrates the removed system mode to dark", () => {
    expect(parseThemeSelection("claw", "system")).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection("system", undefined)).toEqual({ theme: "claw", mode: "dark" });
    // A stored "system" mode was a choice, so it is not overridden by a legacy light theme name.
    expect(parseThemeSelection("lightTheme", "system")).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection("custom", "system")).toEqual({ theme: "custom", mode: "dark" });
  });

  it("normalizes the removed knot/dash theme families instead of throwing", () => {
    expect(parseThemeSelection("knot", "dark")).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection("dash", undefined)).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection("fieldmanual", undefined)).toEqual({ theme: "claw", mode: "dark" });
  });

  it("takes an explicit mode over anything the legacy theme name implies", () => {
    expect(parseThemeSelection("light", "dark")).toEqual({ theme: "claw", mode: "dark" });
  });

  it("preserves the custom theme escape hatch", () => {
    expect(parseThemeSelection("custom", "dark")).toEqual({ theme: "custom", mode: "dark" });
  });

  it("falls back to dark for a value nothing recognises", () => {
    expect(parseThemeSelection(undefined, undefined)).toEqual({ theme: "claw", mode: "dark" });
    expect(parseThemeSelection(42, {})).toEqual({ theme: "claw", mode: "dark" });
  });
});
