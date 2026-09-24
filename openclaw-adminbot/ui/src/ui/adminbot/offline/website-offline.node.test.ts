import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

// Production assets and real browser storage. The API uses synthetic responses; service-side
// authentication and CAS are exercised independently in server.member-drafts.test.ts.
it("reopens the built website offline and syncs autosaved edits after reconnect", async () => {
  const root = existsSync(path.resolve("dist/control-ui/index.html"))
    ? path.resolve("dist/control-ui")
    : path.resolve("../dist/control-ui");
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const relative =
      pathname.startsWith("/assets/") || pathname === "/sw.js" ? pathname.slice(1) : "index.html";
    if (relative.includes("..")) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(path.join(root, relative));
      const ext = path.extname(relative);
      res.setHeader(
        "Content-Type",
        ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : "text/html",
      );
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1365, height: 1000 } });
    let remotes = new Map<string, any>(),
      reachable = true;
    await context.route("http://127.0.0.1:8765/**", async (route) => {
      if (!reachable) return route.abort("internetdisconnected");
      const req = route.request(),
        path = new URL(req.url()).pathname;
      let body = {};
      if (path === "/auth/session")
        body = {
          expires_at: "2099-01-01T00:00:00Z",
          member: { id: "offline-test-member", name: "Test Member", privilege_level: "member" },
          gateway: { token: "" },
        };
      else if (path.startsWith("/member-drafts/")) {
        let remote = remotes.get(path) ?? null;
        if (req.method() === "PUT") {
          const b = req.postDataJSON();
          if (b.baseRevision !== (remote?.revision ?? 0))
            return route.fulfill({ status: 409, json: { draft: remote } });
          remote = {
            revision: (remote?.revision ?? 0) + 1,
            mutationId: b.mutationId,
            data: b.data,
          };
          remotes.set(path, remote);
        }
        body = { draft: remote };
      } else if (path === "/lab/members")
        body = {
          members: [{ id: "offline-test-member", name: "Test Member", privilege_level: "member" }],
        };
      else if (path === "/auth/device-token" || path === "/auth/pair-device")
        return route.fulfill({ status: 503, json: { error: { message: "unavailable" } } });
      else body = { items: [], requests: [], notifications: [], members: [], papers: [] };
      await route.fulfill({ status: 200, json: body });
    });
    let page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/`);
    await page.evaluate(() => {
      localStorage.setItem(
        "openclaw.adminbot.session.v1",
        JSON.stringify({ sessionToken: "synthetic-session", expiresAt: "2099-01-01T00:00:00Z" }),
      );
      const app = document.querySelector("openclaw-app") as any;
      app.applySettings({ ...app.settings, adminBotUrl: "http://127.0.0.1:8765" });
    });
    await page.goto(`${origin}/rec-letters`);
    let field = page.locator('[data-testid="logistics-cv-overleaf"] input');
    await field.waitFor({ timeout: 15000 }).catch(async (error) => {
      await page.screenshot({ path: "/tmp/adminbot-offline-failure.png" });
      throw new Error(
        `${error.message}; browser errors: ${errors.join("; ")}; UI: ${await page.locator("body").innerText()}`,
      );
    });
    await field.fill("https://example.test/online-draft");
    await page.getByText("All changes saved", { exact: true }).waitFor({ timeout: 15000 });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.getByText("Offline access · Ready on this device", { exact: false }).waitFor();
    reachable = false;
    await context.setOffline(true);
    await field.fill("https://example.test/offline-draft");
    await page
      .getByText("Saved on this device · waiting to sync", { exact: true })
      .waitFor({ timeout: 15000 });

    // A new phone-sized tab must reopen from disk; an in-memory mounted editor is insufficient.
    await page.close();
    page = await context.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/rec-letters`, { waitUntil: "domcontentloaded" });
    field = page.locator('[data-testid="logistics-cv-overleaf"] input');
    await field.waitFor({ timeout: 15000 });
    await expect
      .poll(() => field.inputValue(), { timeout: 10000 })
      .toBe("https://example.test/offline-draft");
    await page.locator("adminbot-offline-access summary").click();
    await page.getByText("1 draft awaiting sync or review.", { exact: false }).waitFor();
    await page.screenshot({ path: "/tmp/adminbot-offline-phone.png", fullPage: false });

    reachable = true;
    await context.setOffline(false);
    await page.getByText("All changes saved", { exact: true }).waitFor({ timeout: 20000 });
    assert.equal(
      remotes.get("/member-drafts/recommendation-letters").data.cvOverleafUrl,
      "https://example.test/offline-draft",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await field.scrollIntoViewIfNeeded();

    // A second tab starts from the same server revision, then edits during an Aurora outage.
    const other = await context.newPage();
    await other.goto(`${origin}/rec-letters`);
    const otherField = other.locator('[data-testid="logistics-cv-overleaf"] input');
    await other.getByText("All changes saved", { exact: true }).waitFor();
    reachable = false;
    await field.fill("https://example.test/first-tab");
    await otherField.fill("https://example.test/second-tab");
    await page.getByText("Saved on this device · waiting to sync", { exact: true }).waitFor();
    await other.getByText("Saved on this device · waiting to sync", { exact: true }).waitFor();
    reachable = true;
    // No online event: periodic retry must discover the server's recovery.
    const loser = await Promise.race(
      [page, other].map(async (tab) => {
        await tab
          .getByRole("button", { name: "Use server copy", exact: true })
          .waitFor({ timeout: 20000 });
        return tab;
      }),
    );
    const loserField = loser.locator('[data-testid="logistics-cv-overleaf"] input');
    assert.notEqual(
      await loserField.inputValue(),
      remotes.get("/member-drafts/recommendation-letters").data.cvOverleafUrl,
    );
    await loser.getByRole("button", { name: "Use server copy", exact: true }).click();
    await loser.getByText("All changes saved", { exact: true }).waitFor();
    assert.equal(
      await loserField.inputValue(),
      remotes.get("/member-drafts/recommendation-letters").data.cvOverleafUrl,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 60000);
