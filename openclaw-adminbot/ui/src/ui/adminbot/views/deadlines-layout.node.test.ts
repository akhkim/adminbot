import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeLayout = canRunPlaywrightChromium(executablePath) ? describe : describe.skip;
const widths = [320, 390, 600, 760, 761, 768, 820, 1024, 1200, 1280, 1366, 1440];

describeLayout("mounted deadline layout", () => {
  let server: ControlUiE2eServer;
  let browser: Browser;

  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath, headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  for (const view of ["Groups", "Cards"] as const) {
    it(`keeps ${view} readable across widths and enlarged text`, async () => {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      try {
        await page.clock.setFixedTime(new Date("2026-09-09T12:00:00Z"));
        await page.route("**/*", (route) =>
          route.request().url().startsWith(server.baseUrl) ? route.continue() : route.abort(),
        );
        await page.goto(`${server.baseUrl}adminbot/deadlines`);
        await page.locator(".deadline-group__summary").first().waitFor();
        if (view === "Groups") {
          await page.locator(".deadline-group__summary").first().click();
        } else {
          await page.getByRole("button", { name: "Cards", exact: true }).click();
        }
        await page.evaluate(() => {
          const elements = document.querySelectorAll<HTMLElement>(
            "adminbot-deadlines-view, adminbot-deadlines-view *",
          );
          for (const element of elements) {
            element.dataset.layoutFont = getComputedStyle(element).fontSize;
          }
        });
        for (const scale of [1, 2, 3]) {
          await page.evaluate((factor) => {
            for (const element of document.querySelectorAll<HTMLElement>("[data-layout-font]")) {
              element.style.setProperty(
                "font-size",
                `${Number.parseFloat(element.dataset.layoutFont!) * factor}px`,
                "important",
              );
            }
          }, scale);
          for (const width of widths) {
            await page.setViewportSize({ width, height: 900 });
            const result = await page.evaluate((mode) => {
              const selector = mode === "Groups" ? ".deadline-group__row" : ".deadline-card";
              const rows = [...document.querySelectorAll<HTMLElement>(selector)].filter(
                (row) => row.offsetHeight > 0,
              );
              const problems: string[] = [];
              for (const row of rows) {
                const bounds = row.getBoundingClientRect();
                for (const child of row.querySelectorAll<HTMLElement>("*")) {
                  const box = child.getBoundingClientRect();
                  if (box.width > 0 && box.right > bounds.right + 1) {
                    problems.push(`overflow: ${child.className}`);
                  }
                }
                if (mode === "Groups") {
                  const boxes = [...row.children].map((child) => child.getBoundingClientRect());
                  for (let i = 0; i < boxes.length; i++) {
                    for (let j = i + 1; j < boxes.length; j++) {
                      const a = boxes[i];
                      const b = boxes[j];
                      if (
                        a.right > b.left &&
                        b.right > a.left &&
                        a.bottom > b.top &&
                        b.bottom > a.top
                      ) {
                        problems.push("overlapping row fields");
                      }
                    }
                  }
                  const title = row
                    .querySelector(".deadline-group__row-main")!
                    .getBoundingClientRect();
                  if (title.width < Math.min(200, bounds.width - 42)) {
                    problems.push("squeezed title");
                  }
                }
              }
              const workshop = rows.find((row) =>
                row.textContent?.includes("Document Intelligence"),
              );
              const date = workshop?.querySelector("time")?.getBoundingClientRect();
              const history = workshop
                ?.querySelector(".deadline-card__history-trigger")
                ?.getBoundingClientRect();
              const dateText = workshop?.querySelector("time");
              const icon = workshop?.querySelector(".deadline-card__history-trigger svg");
              return {
                iconTextRatio:
                  dateText && icon
                    ? icon.getBoundingClientRect().width /
                      Number.parseFloat(getComputedStyle(dateText).fontSize)
                    : 0,
                historyBesideDate: Boolean(date && history && history.top < date.bottom),
                compact:
                  mode !== "Groups" ||
                  getComputedStyle(rows[0]).gridTemplateColumns.split(" ").length === 4,
                count: rows.length,
                overflow: document.documentElement.scrollWidth > innerWidth,
                problems,
              };
            }, view);
            expect(result.count).toBeGreaterThan(0);
            expect(result.iconTextRatio, "history icon scales with date text").toBeCloseTo(1, 1);
            if (width === 390 && scale >= 2) {
              expect(result.historyBesideDate, "history follows the wrapped date inline").toBe(
                true,
              );
            }
            if (scale === 1 && width >= 1280) {
              expect(result.compact, "keep wide rows compact").toBe(true);
            }
            expect(result.overflow, `${view}: ${width}px at ${scale}x`).toBe(false);
            expect(result.problems, `${view}: ${width}px at ${scale}x`).toEqual([]);
          }
        }
      } finally {
        await page.close();
      }
    }, 120_000);
  }
});
