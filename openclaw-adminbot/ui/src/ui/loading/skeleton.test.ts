import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { rememberPageScroll, rememberedPageScroll, restorePageScroll } from "./page-scroll.ts";
import { renderSkeleton, skeletonCount } from "./skeleton.ts";

// Vitest runs from the ui package root; jsdom gives this module a non-file URL.
const css = readFileSync(resolve(process.cwd(), "src/styles/loading.css"), "utf8");

describe("skeleton placeholder", () => {
  it("draws quiet rows that a screen reader hears as one status", () => {
    const container = document.createElement("div");
    render(renderSkeleton({ count: 3, label: "Loading events" }), container);
    const root = container.querySelector(".skeleton");
    expect(root?.getAttribute("role")).toBe("status");
    expect(root?.getAttribute("aria-busy")).toBe("true");
    expect(root?.getAttribute("aria-label")).toBe("Loading events");
    expect(container.querySelectorAll(".skeleton__row")).toHaveLength(3);
    // No words on screen and no boxed panel: the label is for assistive tech only.
    expect(container.textContent?.trim()).toBe("");
    expect(container.querySelector(".card")).toBeNull();
  });

  it("draws plain lines for text-shaped content and clamps the count", () => {
    const container = document.createElement("div");
    render(renderSkeleton({ shape: "lines", count: 99 }), container);
    expect(container.querySelectorAll(".skeleton__row")).toHaveLength(0);
    expect(container.querySelectorAll(".skeleton__line")).toHaveLength(12);
    expect(skeletonCount(0, 5)).toBe(1);
    expect(skeletonCount(undefined, 5)).toBe(5);
    expect(skeletonCount(Number.NaN, 4)).toBe(4);
  });

  it("stays invisible for the first moment so a fast load never flashes it", () => {
    const block = css.slice(
      css.indexOf(".skeleton {"),
      css.indexOf("}", css.indexOf(".skeleton {")),
    );
    expect(block).toMatch(/opacity:\s*0;/);
    const delay = /animation:\s*skeleton-reveal[^;]*?(\d+)ms forwards;/.exec(block);
    expect(Number(delay?.[1])).toBeGreaterThanOrEqual(150);
    expect(Number(delay?.[1])).toBeLessThanOrEqual(200);
  });

  it("moves only for viewers who have not asked for reduced motion", () => {
    const motion = css.slice(css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    const before = css.slice(0, css.indexOf("@media (prefers-reduced-motion: no-preference)"));
    expect(motion).toContain("skeleton-breathe");
    expect(motion).toContain("page-progress-slide");
    expect(before).not.toMatch(/animation:[^;]*(skeleton-breathe|page-progress-slide)/);
  });

  it("uses theme tokens rather than fixed colours", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });
});

describe("page scroll memory", () => {
  it("returns a page to where it was left and starts a new page at the top", () => {
    const pane = { scrollTop: 640, scrollHeight: 4000, clientHeight: 800 };
    rememberPageScroll("events", pane);
    expect(rememberedPageScroll("events")).toBe(640);
    const runs: Array<() => void> = [];
    const schedule = (run: () => void) => void runs.push(run);

    restorePageScroll(
      "adminbotMeetings",
      () => pane,
      () => true,
      schedule,
    );
    runs.shift()?.();
    expect(pane.scrollTop).toBe(0);

    restorePageScroll(
      "events",
      () => pane,
      () => true,
      schedule,
    );
    runs.shift()?.();
    expect(pane.scrollTop).toBe(640);
    expect(runs).toHaveLength(0);
  });

  it("retries while the page is still short, and yields to the viewer or a newer page", () => {
    rememberPageScroll("events", { scrollTop: 900, scrollHeight: 4000, clientHeight: 800 });
    let max = 100;
    const pane = {
      scrollHeight: 0,
      clientHeight: 0,
      _top: 0,
      get scrollTop() {
        return this._top;
      },
      set scrollTop(value: number) {
        this._top = Math.min(value, max);
      },
    };
    const runs: Array<() => void> = [];
    const schedule = (run: () => void) => void runs.push(run);
    restorePageScroll(
      "events",
      () => pane,
      () => true,
      schedule,
    );
    runs.shift()?.();
    expect(pane.scrollTop).toBe(100);
    max = 5000;
    runs.shift()?.();
    expect(pane.scrollTop).toBe(900);
    expect(runs).toHaveLength(0);

    max = 100;
    restorePageScroll(
      "events",
      () => pane,
      () => true,
      schedule,
    );
    runs.shift()?.();
    pane.scrollTop = 40;
    max = 5000;
    runs.shift()?.();
    expect(pane.scrollTop).toBe(40);

    let current = true;
    restorePageScroll(
      "events",
      () => pane,
      () => current,
      schedule,
    );
    current = false;
    runs.shift()?.();
    expect(pane.scrollTop).toBe(40);
  });
});
