import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

it("loads the unpacked extension and opens its configured workspace", async () => {
  const extension = existsSync(path.resolve("../../chrome-extension/manifest.json"))
    ? path.resolve("../../chrome-extension")
    : path.resolve("../chrome-extension");
  const profile = await mkdtemp(path.join(tmpdir(), "adminbot-extension-test-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = await context.newPage();
    await page.goto("chrome://extensions/");
    const item = page.locator("extensions-item").filter({ hasText: "AdminBot Offline Workspace" });
    await item.waitFor();
    const id = await item.getAttribute("id");
    expect(id).toBeTruthy();
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.locator("#url").fill("http://127.0.0.1:5173/");
    await context.route("http://127.0.0.1:5173/**", (route) =>
      route.fulfill({ body: "Synthetic workspace" }),
    );
    const opened = context.waitForEvent("page");
    await page.getByRole("button", { name: "Open workspace" }).click();
    const workspace = await opened;
    await workspace.waitForURL("http://127.0.0.1:5173/");
    expect(workspace.url()).toBe("http://127.0.0.1:5173/");
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}, 30000);
