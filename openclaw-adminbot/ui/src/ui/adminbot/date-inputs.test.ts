// Every AdminBot date and time input binds its value with `live()`.
//
// Chrome's date and time fields drop a half-typed segment when their value is written. Most AdminBot
// forms save and redraw on each keystroke, so a plain `.value=${...}` binding writes the value back
// mid-entry: "14" in the day becomes "1", then a fresh "4". A rec letter request filed before this
// was fixed in the letters form (#422) arrived with six schools on the 4th. `live()` skips the write
// when the box already holds the value and still writes a genuinely different one (a restored draft,
// a reset), so it is safe everywhere. The behavior itself is tested in views/logistics.test.ts; this
// keeps every other date field, including ones added later, from reintroducing the plain binding.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.dirname(fileURLToPath(import.meta.url));
const DATE_TYPE = /type=(?:"(?:date|time|datetime-local|month)"|\$\{[^}]*\b(?:date|time)\b)/u;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return sources(full);
    }
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [full] : [];
  });
}

function plainDateBindings(file: string): string[] {
  const source = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  for (const tag of source.matchAll(/<input\b[^>]*?>/gsu)) {
    if (!DATE_TYPE.test(tag[0])) {
      continue;
    }
    for (const binding of tag[0].matchAll(/\.value=\$\{([^}]*)\}/gu)) {
      if (!binding[1]!.trim().startsWith("live(")) {
        const line = source.slice(0, tag.index).split("\n").length;
        found.push(`${path.relative(root, file)}:${line} .value=\${${binding[1]!.trim()}}`);
      }
    }
  }
  return found;
}

describe("AdminBot date and time inputs", () => {
  it("bind their value with live() so a redraw cannot eat a half-typed date", () => {
    expect(sources(root).flatMap(plainDateBindings)).toEqual([]);
  });

  it("recognizes the plain binding it guards against", () => {
    const sample = path.join(root, "date-inputs.test.ts");
    const scan = (markup: string) => {
      const original = fs.readFileSync;
      try {
        (fs as { readFileSync: unknown }).readFileSync = () => markup;
        return plainDateBindings(sample);
      } finally {
        (fs as { readFileSync: unknown }).readFileSync = original;
      }
    };
    expect(scan('<input type="date" .value=${draft.start} />')).toHaveLength(1);
    expect(scan('<input type=${control === "date" ? "date" : "text"} .value=${v} />')).toHaveLength(
      1,
    );
    expect(scan('<input type="date" .value=${live(draft.start)} />')).toEqual([]);
    expect(scan('<input type="text" .value=${draft.name} />')).toEqual([]);
  });
});
