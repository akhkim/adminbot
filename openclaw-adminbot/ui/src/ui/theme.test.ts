// Control UI tests cover theme behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseThemeSelection, resolveSystemTheme, resolveTheme } from "./theme.ts";

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

  it("follows the machine when the mode is system", () => {
    systemPrefers("light");
    expect(resolveTheme("claw", "system")).toBe("light");
    systemPrefers("dark");
    expect(resolveTheme("claw", "system")).toBe("dark");
  });

  it("keeps the custom escape hatch dark whatever the mode says", () => {
    // A pasted palette is a whole theme, not a variant of ours to take a light version of.
    expect(resolveTheme("custom", "dark")).toBe("custom");
    expect(resolveTheme("custom", "light")).toBe("custom");
    systemPrefers("light");
    expect(resolveTheme("custom", "system")).toBe("custom");
  });
});

describe("resolveSystemTheme", () => {
  it("mirrors the operating system", () => {
    systemPrefers("light");
    expect(resolveSystemTheme()).toBe("light");
    systemPrefers("dark");
    expect(resolveSystemTheme()).toBe("dark");
  });

  it("falls back to dark where it cannot ask", () => {
    // A server render, a test environment and an old browser all land here. Dark is what this app
    // looked like for everyone until light existed, so guessing light would change the appearance
    // for people who never expressed a preference.
    vi.stubGlobal("matchMedia", undefined);
    expect(resolveSystemTheme()).toBe("dark");
  });
});

describe("parseThemeSelection", () => {
  it("gives back a light preference somebody stored before light was removed", () => {
    expect(parseThemeSelection("light", undefined)).toEqual({ theme: "claw", mode: "light" });
    expect(parseThemeSelection("lightTheme", undefined)).toEqual({ theme: "claw", mode: "light" });
    expect(parseThemeSelection("docsTheme", undefined)).toEqual({ theme: "claw", mode: "light" });
  });

  it("gives back a stored system preference as system, not as dark", () => {
    expect(parseThemeSelection("system", undefined)).toEqual({ theme: "claw", mode: "system" });
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
