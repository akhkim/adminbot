// @vitest-environment node
//
// One bug class, four times over: a button painted with a theme token for its background and a
// hardcoded ink colour for its text. `--text-strong` is #fafafa in the dark theme and #09090b in
// the light one, so `background: var(--text-strong); color: #0a0a0a` is a white box with black text
// in the dark theme and a black box with black text in the light one. The landing page's sign-in
// button and the guest shell's both shipped that way and were unreadable for anyone on light mode.
//
// A rule whose background follows the theme has to let its foreground follow too.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

/** Every `selector { ... }` block, flattened enough to inspect one declaration list at a time. */
function ruleBlocks(css: string): Array<{ selector: string; body: string }> {
  const blocks: Array<{ selector: string; body: string }> = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/gu;
  let match: RegExpExecArray | null = pattern.exec(css);
  while (match) {
    blocks.push({ selector: (match[1] ?? "").trim(), body: match[2] ?? "" });
    match = pattern.exec(css);
  }
  return blocks;
}

const THEME_BACKGROUND = /background(?:-color)?:\s*var\(--(?:text-strong|text|fg)[^)]*\)/u;
// A literal hex or rgb() foreground. `var(--…)` and `currentColor` follow the theme and are fine.
const LITERAL_COLOR = /(?:^|[\s;])color:\s*(#[0-9a-f]{3,8}|rgba?\()/iu;

describe("theme-inverting controls", () => {
  const files = ["layout.css", "components.css", "base.css"].filter((name) =>
    fs.existsSync(path.join(stylesDir, name)),
  );

  it("never paint a themed background with a fixed foreground", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = fs.readFileSync(path.join(stylesDir, file), "utf8");
      for (const { selector, body } of ruleBlocks(css)) {
        if (THEME_BACKGROUND.test(body) && LITERAL_COLOR.test(body)) {
          offenders.push(`${file}: ${selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // Guards the fix itself rather than only the absence of the bug: these two are the buttons a
  // signed-out visitor is looking at, and they must invert with the page.
  it("give the signed-out buttons a themed foreground", () => {
    const css = fs.readFileSync(path.join(stylesDir, "layout.css"), "utf8");
    for (const selector of [".public-signin", ".landing__cta .btn.primary"]) {
      const block = ruleBlocks(css).find((rule) => rule.selector === selector);
      expect(block, `${selector} is gone — update this test with it`).toBeDefined();
      expect(block?.body).toMatch(/color:\s*var\(--bg\)/u);
    }
  });
});

// Scan every page, including styles embedded in Lit templates. A misspelled token with a dark
// fallback still breaks light mode, so check references even when they provide a fallback.
describe("shared page colour tokens", () => {
  it("defines every colour variable used by page and component styles", () => {
    const src = path.resolve(stylesDir, "..");
    const files = fs
      .readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.(css|ts)$/.test(name) && !name.includes(".test."));
    const sources = files.map((file) => ({
      file,
      text: fs.readFileSync(path.join(src, file), "utf8"),
    }));
    const definitions = new Set(
      sources.flatMap(({ text }) => [...text.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1])),
    );
    const missing = new Set<string>();
    for (const { file, text } of sources) {
      for (const declaration of text.matchAll(
        /(?:^|[;{\s])(?:color|background(?:-color)?|border(?:-color)?|fill|stroke|outline(?:-color)?)\s*:[^;{}]+/g,
      )) {
        for (const reference of declaration[0].matchAll(/var\((--[\w-]+)/g)) {
          if (!definitions.has(reference[1])) missing.add(`${file}: ${reference[1]}`);
        }
      }
    }
    expect([...missing]).toEqual([]);
  });
});
