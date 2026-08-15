// @vitest-environment node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Calendar tab shipped inert: every field it writes was typed on AppViewState and on the
// controller's host, but none was declared `@state()` on the app element. An undeclared field is
// not a reactive property, so loading events changed nothing on screen and typing in the assistant
// did not re-render. Rendering a plain object — which is what every view test does — cannot catch
// that, so the check has to look at the element itself.
const appSource = await readFile(fileURLToPath(new URL("../app.ts", import.meta.url)), "utf8");
const viewStateSource = await readFile(
  fileURLToPath(new URL("../app-view-state.ts", import.meta.url)),
  "utf8",
);

/** Field names on AppViewState that belong to the Calendar tab and hold state rather than behaviour. */
function calendarStateFields(): string[] {
  const fields = new Set<string>();
  for (const match of viewStateSource.matchAll(/^\s{2}(calendar[A-Za-z]*)\??:/gmu)) {
    const name = match[1];
    // The handlers are methods, not state; they are bound on the element separately.
    if (name && !/^calendar(Load|Request|Propose|Save|Send)/u.test(name)) {
      fields.add(name);
    }
  }
  return [...fields];
}

describe("the Calendar tab's state", () => {
  it("declares every field it writes as a reactive property on the app element", () => {
    const fields = calendarStateFields();
    // Guard the guard: if the extraction stops finding fields, the test would pass vacuously.
    expect(fields.length).toBeGreaterThan(8);

    const undeclared = fields.filter(
      (field) => !new RegExp(`@state\\(\\)\\s+${field}[?:\\s]`, "u").test(appSource),
    );
    expect(undeclared).toEqual([]);
  });
});
