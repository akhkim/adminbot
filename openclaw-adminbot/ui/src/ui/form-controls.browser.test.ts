// Control UI tests cover form controls behavior.
import { chromium, type Browser, type Page } from "playwright";
import { describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeBrowserLayout = canRunPlaywrightChromium(chromiumExecutablePath)
  ? describe
  : describe.skip;

type MobileFixture = {
  browser: Browser;
  page: Page;
};

function readUiCss(): string {
  const files = [
    "ui/src/styles/base.css",
    "ui/src/styles/components.css",
    "ui/src/styles/config.css",
    "ui/src/styles/usage.css",
    "ui/src/styles/chat/layout.css",
  ];
  return files.map((file) => readStyleSheet(file)).join("\n");
}

function controlsHtml() {
  return `
    <main>
      <label class="field"><input value="field input" /></label>
      <label class="field"><textarea>field textarea</textarea></label>
      <label class="field"><select><option>field select</option></select></label>
      <input class="config-search__input" value="search" />
      <input class="settings-theme-import__input" value="theme" />
      <label class="config-raw-field"><textarea>raw config</textarea></label>
      <input class="cfg-input" value="config input" />
      <input class="cfg-input cfg-input--sm" value="small config input" />
      <textarea class="cfg-textarea">config textarea</textarea>
      <textarea class="cfg-textarea cfg-textarea--sm">small config textarea</textarea>
      <label class="cfg-number"><input class="cfg-number__input" value="1" /></label>
      <select class="cfg-select"><option>config select</option></select>
      <input class="usage-date-input" value="2026-05-31" />
      <select class="usage-select"><option>usage select</option></select>
      <input class="usage-query-input" value="usage query" />
      <div class="usage-filters-inline">
        <select><option>inline usage select</option></select>
        <input type="text" value="inline usage input" />
      </div>
      <div class="agent-chat__composer-combobox"><textarea>chat composer</textarea></div>
      <div class="chat-compose"><label class="chat-compose__field"><textarea>chat compose</textarea></label></div>
    </main>
  `;
}

async function openMobileFixture(): Promise<MobileFixture> {
  const browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
  let page: Page | undefined;
  try {
    page = await browser.newPage({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    await page.setContent(
      `<!doctype html><html data-theme-mode="dark"><head><style>${readUiCss()}</style></head><body>${controlsHtml()}</body></html>`,
    );
    return { browser, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await browser.close().catch(() => {});
    throw error;
  }
}

async function closeMobileFixture(fixture: MobileFixture): Promise<void> {
  await fixture.page.close().catch(() => {});
  await fixture.browser.close().catch(() => {});
}

describeBrowserLayout("touch-primary form controls", () => {
  it("keeps text-entry controls large enough to avoid mobile focus zoom", async () => {
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const metrics = await page.evaluate(() => {
        const selectors = [
          ".field input",
          ".field textarea",
          ".field select",
          ".config-search__input",
          ".settings-theme-import__input",
          ".config-raw-field textarea",
          ".cfg-input",
          ".cfg-input--sm",
          ".cfg-textarea",
          ".cfg-textarea--sm",
          ".cfg-number__input",
          ".cfg-select",
          ".usage-date-input",
          ".usage-select",
          ".usage-query-input",
          '.usage-filters-inline input[type="text"]',
          ".usage-filters-inline select",
          ".agent-chat__composer-combobox > textarea",
          ".chat-compose .chat-compose__field textarea",
        ];
        return {
          touchPrimary: matchMedia("(hover: none) and (pointer: coarse)").matches,
          sizes: selectors.map((selector) => {
            const node = document.querySelector(selector);
            if (!(node instanceof HTMLElement)) {
              throw new Error(`Missing control ${selector}`);
            }
            return {
              selector,
              fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
            };
          }),
        };
      });

      expect(metrics.touchPrimary).toBe(true);
      for (const size of metrics.sizes) {
        expect(size.fontSize, size.selector).toBeGreaterThanOrEqual(16);
      }
    } finally {
      await closeMobileFixture(fixture);
    }
  });

  it("leaves the platform's own select arrow unpainted", async () => {
    // Inverted on purpose from what this used to assert. The chevron was once drawn as a
    // background image with `appearance: none`, and Chrome repaints the control strip while a
    // select's popup is open -- which tiled that image into a row of arrows across the closed box
    // with the label smeared under it. `color-scheme: dark` now makes the native arrow theme
    // itself, so the rule is that nothing paints over it. See the comment at `select.input`
    // in components.css.
    const fixture = await openMobileFixture();
    const { page } = fixture;
    try {
      const selects = await page.locator(".cfg-select, .field select").evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node as HTMLElement);
          return {
            image: style.backgroundImage,
            appearance: style.appearance,
            paddingRight: Number.parseFloat(style.paddingRight),
          };
        }),
      );

      expect(selects).toHaveLength(2);
      for (const select of selects) {
        // Nothing to tile: this is the assertion that would have caught the repaint bug.
        expect(select.image).toBe("none");
        // The platform still draws the control, so the arrow is there without us drawing it.
        expect(select.appearance).not.toBe("none");
        // Room between the longest label and the arrow the platform puts in the corner.
        expect(select.paddingRight).toBeGreaterThan(0);
      }
    } finally {
      await closeMobileFixture(fixture);
    }
  });
});
