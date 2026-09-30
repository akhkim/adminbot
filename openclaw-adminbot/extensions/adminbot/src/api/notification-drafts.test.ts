import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";
const apps: ReturnType<typeof createAdminBotMockService>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await new Promise<void>((resolve) => {
      app.server.close(() => resolve());
    });
    app.close();
  }
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});
async function setup(databasePath?: string) {
  const app = createAdminBotMockService({
    databasePath,
    serviceToken: "synthetic-service",
    notificationDraftScriptPath: path.resolve(
      "scripts/openreview-notifications/adminbot_bridge.py",
    ),
  });
  apps.push(app);
  const base = await app.listen(0);
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("No server");
  }
  const url = base.replace(":0", ":" + address.port) + "/tools/notification-drafts";
  function headers(admin: boolean) {
    const id = admin ? "test-admin" : "test-member";
    app.service.upsertLabMember({
      id,
      name: "Synthetic User",
      privilege_level: admin ? "admin" : "member",
    });
    app.store.saveSession({
      member_id: id,
      token_hash: createHash("sha256").update(id).digest("hex"),
      created_at: new Date().toISOString(),
      last_seen_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60000).toISOString(),
    });
    return { Authorization: "Bearer " + id, "Content-Type": "application/json" };
  }
  return { app, url, headers };
}
const input = {
  min_date: "2026-09-01",
  conference: "neurips",
  template: 1,
  images: false,
  notifications: [
    {
      id: "synthetic",
      cdate: 1790000000000,
      domain: "NeurIPS.cc/2026/Conference",
      content: {
        subject: "Decision notification for your submission 1: Synthetic Learning Study",
        text: "Decision: Accept",
      },
    },
  ],
};
it("accepts notification requests larger than the former 10 MB backend limit", async () => {
  const { url, headers } = await setup();
  const response = await fetch(url, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify({
      ...input,
      exportMetadata: "x".repeat(12 * 1024 * 1024),
    }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).announcements[0].text).toContain("Synthetic Learning Study");
});
it("runs the imported parser through authenticated HTTP and allows repeat generation", async () => {
  const { url, headers } = await setup();
  const auth = headers(true);
  for (let i = 0; i < 2; i++) {
    const response = await fetch(url, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.announcements[0].text).toContain("Synthetic Learning Study");
    expect(result.announcements[0].paper_count).toBe(1);
    expect(result.images).toEqual([]);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});
it("matches OpenReview authors to SQLite members and ignores client-supplied handles", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "adminbot-author-test-"));
  directories.push(directory);
  await mkdir(path.join(directory, "openreview"));
  await writeFile(path.join(directory, "openreview", "__init__.py"), "");
  await writeFile(
    path.join(directory, "openreview", "api.py"),
    `
from types import SimpleNamespace
class OpenReviewClient:
    def __init__(self, **kwargs):
        assert kwargs["username"] == "synthetic@example.invalid"
        self.profile = SimpleNamespace(id="~Synthetic_Admin1")
    def get_note(self, note_id):
        assert note_id == "syntheticPaper"
        return SimpleNamespace(content={"authors": {"value": [{"username": "~Test_Author1"}]}})
`,
  );
  vi.stubEnv("PYTHONPATH", directory);
  vi.stubEnv("OPENREVIEW_USERNAME", "synthetic@example.invalid");
  vi.stubEnv("OPENREVIEW_PASSWORD", "synthetic-password");
  const { app, url, headers } = await setup(path.join(directory, "members.sqlite"));
  const auth = headers(true);
  app.service.upsertLabMember({
    id: "synthetic-author",
    name: "Test Author",
    openreview_id: "~Test_Author1",
    twitter_url: "https://x.com/TestHandle",
  });
  const before = app.store.listLabMembers();
  const response = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      ...input,
      members: [{ openreview_id: "~Test_Author1", handle: "InjectedHandle" }],
      notifications: [
        {
          ...input.notifications[0],
          content: {
            ...input.notifications[0].content,
            text: "Decision: Accept\nhttps://openreview.net/forum?id=syntheticPaper",
          },
        },
      ],
    }),
  });
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.announcements[0].text).toContain("Authors: @TestHandle");
  expect(result.announcements[0].text).not.toContain("InjectedHandle");
  expect(result.warnings).toEqual([]);
  expect(app.store.listLabMembers()).toEqual(before);
});
it("denies anonymous, member, service-token and foreign-origin requests", async () => {
  const { url, headers } = await setup();
  for (const [auth, status] of [
    [{ "Content-Type": "application/json" }, 401],
    [headers(false), 403],
    [{ Authorization: "Bearer synthetic-service", "Content-Type": "application/json" }, 403],
    [{ ...headers(true), Origin: "https://untrusted.example" }, 403],
  ] as const) {
    expect(
      (await fetch(url, { method: "POST", headers: auth, body: JSON.stringify(input) })).status,
    ).toBe(status);
  }
});
it("handles malformed input, invalid dates, and empty results", async () => {
  const { url, headers } = await setup();
  const auth = headers(true);
  for (const body of [
    "{",
    JSON.stringify({ ...input, notifications: {} }),
    JSON.stringify({ ...input, template: 11 }),
  ]) {
    expect((await fetch(url, { method: "POST", headers: auth, body })).status).toBe(400);
  }
  const invalid = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...input, min_date: "2026-99-99" }),
  });
  expect(invalid.status).toBe(422);
  const empty = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ ...input, notifications: [] }),
  });
  expect((await empty.json()).announcements).toEqual([]);
});
