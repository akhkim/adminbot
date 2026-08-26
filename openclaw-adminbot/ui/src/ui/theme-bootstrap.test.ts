/* @vitest-environment jsdom */
// The inline script in index.html decides the theme before the first byte of paint, which means it
// cannot import theme.ts. Duplicated logic drifts, and the way it drifts here is invisible: the
// page paints one theme and then swaps to another, which is the exact flash a theme preference
// exists to prevent. So this runs the real inline script against the real resolver and requires
// them to agree.
//
// It also checks the palettes themselves, because a colour token declared only in the dark block
// is a colour light silently inherits from dark -- dark ink on a dark surface, on a page nobody
// looked at.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTheme, type ThemeMode, type ThemeName } from "./theme.ts";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const indexHtml = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
const baseCss = fs.readFileSync(path.join(uiRoot, "src/styles/base.css"), "utf8");

/** The bootstrap IIFE, lifted out of the page exactly as it ships. */
function bootstrapSource(): string {
  const start = indexHtml.indexOf("(function () {");
  const end = indexHtml.indexOf("})();", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return indexHtml.slice(start, end + "})();".length);
}

const SETTINGS_KEY = "openclaw.control.settings.v1";

/**
 * Evaluates the shipped inline script, which is the entire point of this file.
 *
 * `new Function` rather than a <script> element: a script tag is evaluated by jsdom against its own
 * window, where the stubbed `matchMedia` and the throwing storage this file installs are not
 * visible. Both run the same source in the same realm; only one of them can be given a machine that
 * prefers light.
 */
// oxlint-disable-next-line no-implied-eval -- see above.
const runScript = (source: string): void => void new Function(source)();

function runBootstrap(stored: unknown, systemLight: boolean): string {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
  // jsdom's own storage, not a stub: the script walks it with Object.keys, which a hand-rolled
  // object with methods on it answers with the method names.
  localStorage.clear();
  if (stored !== undefined) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("prefers-color-scheme: light") === systemLight,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  runScript(bootstrapSource());
  return document.documentElement.getAttribute("data-theme") ?? "";
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the pre-paint bootstrap agrees with theme.ts", () => {
  const cases: Array<{ theme: ThemeName; mode: ThemeMode; systemLight: boolean }> = [
    { theme: "claw", mode: "dark", systemLight: false },
    { theme: "claw", mode: "dark", systemLight: true },
    { theme: "claw", mode: "light", systemLight: false },
    { theme: "claw", mode: "light", systemLight: true },
    { theme: "claw", mode: "system", systemLight: false },
    { theme: "claw", mode: "system", systemLight: true },
    { theme: "custom", mode: "light", systemLight: true },
    { theme: "custom", mode: "system", systemLight: false },
  ];

  for (const { theme, mode, systemLight } of cases) {
    it(`${theme}/${mode} with system ${systemLight ? "light" : "dark"}`, () => {
      expect(runBootstrap({ theme, themeMode: mode }, systemLight)).toBe(resolveTheme(theme, mode));
    });
  }

  it("matches the resolver for somebody who has never chosen anything", () => {
    expect(runBootstrap(undefined, false)).toBe("dark");
    // No stored setting is not a stored preference for light, so a light machine still gets dark
    // until somebody picks "System" -- the same answer resolveTheme gives for the default mode.
    expect(runBootstrap(undefined, true)).toBe(resolveTheme("claw", "dark"));
  });

  it("sets the light/dark family alongside the palette, for form controls and scrollbars", () => {
    runBootstrap({ theme: "claw", themeMode: "light" }, false);
    expect(document.documentElement.getAttribute("data-theme-mode")).toBe("light");
    runBootstrap({ theme: "custom", themeMode: "light" }, true);
    // The custom palette is dark, whatever the mode said.
    expect(document.documentElement.getAttribute("data-theme-mode")).toBe("dark");
  });

  it("falls back to dark rather than throwing when storage is unreadable", () => {
    vi.stubGlobal("localStorage", {
      get length(): number {
        throw new Error("blocked");
      },
    });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    runScript(bootstrapSource());
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});

describe("the light palette covers the dark one", () => {
  function colourTokens(block: string): string[] {
    return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gimu)]
      .filter((match) => /#|rgba?\(|color-mix|hsl\(/iu.test(match[2] ?? ""))
      .flatMap((match) => (match[1] ? [match[1]] : []));
  }

  it("redeclares every colour the dark theme sets", () => {
    const dark = baseCss.slice(
      baseCss.indexOf(":root {"),
      baseCss.indexOf(':root[data-theme="light"]'),
    );
    const lightStart = baseCss.indexOf(':root[data-theme="light"]');
    const light = baseCss.slice(
      lightStart,
      baseCss.indexOf("}", baseCss.indexOf("color-scheme: light")),
    );

    const darkTokens = new Set(colourTokens(dark));
    const lightTokens = new Set(colourTokens(light));
    // --placeholder is deliberately absent: it is mixed from --muted and --bg, so it follows the
    // theme without being restated.
    darkTokens.delete("--placeholder");
    // --focus-ring and --shadow-glow are composed from other tokens, not colours of their own.
    darkTokens.delete("--focus-ring");
    darkTokens.delete("--shadow-glow");

    expect([...darkTokens].filter((token) => !lightTokens.has(token))).toEqual([]);
  });

  it("declares its colour scheme, so native controls follow", () => {
    expect(baseCss).toContain("color-scheme: light");
    expect(baseCss).toContain("color-scheme: dark");
  });
});
