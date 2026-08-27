import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAdminBotMockService } from "./server.js";

// `/` hands a person the Control UI; `/adminbot` keeps the built-in console. The split is the
// whole point of the route, so both halves are asserted together — a redirect that also swallowed
// the console would leave no operator surface on this origin when the Control UI is down.

type RunningService = {
  mock: ReturnType<typeof createAdminBotMockService>;
  cleanupPaths: string[];
};

const running: RunningService[] = [];
const originalControlUiUrl = process.env.ADMINBOT_CONTROL_UI_URL;

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (!entry) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      entry.mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    entry.mock.close();
    for (const cleanupPath of entry.cleanupPaths) {
      await rm(cleanupPath, { force: true });
    }
  }
  if (originalControlUiUrl === undefined) {
    delete process.env.ADMINBOT_CONTROL_UI_URL;
  } else {
    process.env.ADMINBOT_CONTROL_UI_URL = originalControlUiUrl;
  }
});

async function startService(): Promise<string> {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-root-redirect-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: "test-service-token",
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
    dcsFormRunner: async () => {},
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", () => {
      mock.server.off("error", reject);
      resolve();
    });
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push({ mock, cleanupPaths: [sensitiveInfoPath] });
  return `http://127.0.0.1:${address.port}`;
}

describe("GET /", () => {
  it("redirects to the configured Control UI", async () => {
    process.env.ADMINBOT_CONTROL_UI_URL = "https://jinesis-admin.vercel.app";
    const baseUrl = await startService();

    const response = await fetch(`${baseUrl}/`, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://jinesis-admin.vercel.app/");
    // Configuration can be corrected; a cached 301 could not be.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("honours the public host from the tunnel rather than the socket", async () => {
    // Behind the tunnel the request arrives on 127.0.0.1 with the real host forwarded. The
    // redirect must be decided on what the browser typed, not on the loopback socket.
    process.env.ADMINBOT_CONTROL_UI_URL = "https://admin.safe.eu";
    const baseUrl = await startService();

    const response = await fetch(`${baseUrl}/`, {
      redirect: "manual",
      headers: { "x-forwarded-host": "admin.safe.eu", "x-forwarded-proto": "https" },
    });

    // Same origin as the incoming request once forwarding is honoured, so it must not redirect.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("AdminBot Console");
  });

  it("serves the console instead of looping when the Control UI is this same origin", async () => {
    const baseUrl = await startService();
    process.env.ADMINBOT_CONTROL_UI_URL = baseUrl;

    const response = await fetch(`${baseUrl}/`, { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("AdminBot Console");
  });
});

describe("GET /adminbot", () => {
  it("still serves the built-in console", async () => {
    process.env.ADMINBOT_CONTROL_UI_URL = "https://jinesis-admin.vercel.app";
    const baseUrl = await startService();

    const response = await fetch(`${baseUrl}/adminbot`, { redirect: "manual" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("AdminBot Console");
  });
});
