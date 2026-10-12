import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAdminBotMockService } from "./server.js";
const drive = vi.hoisted(() => vi.fn());
const cleanup = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (String(args[0]).includes("adminbot-notification-drafts-")) {
        await cleanup();
      }
      return actual.rm(...args);
    },
  };
});
vi.mock("../connectors/gog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../connectors/gog.js")>()),
  readDriveFileBase64: drive,
}));
const apps: ReturnType<typeof createAdminBotMockService>[] = [];
const directories: string[] = [];
afterEach(async () => {
  drive.mockReset();
  cleanup.mockReset();
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

it("fetches the fixed Drive CSV afresh only when no upload is supplied", async () => {
  const { url, headers } = await setup();
  const auth = headers(true);
  const csv =
    "id,date_utc,venue_domain,subject,message\nsynthetic,2026-09-21 14:13:20,NeurIPS.cc/2026/Conference,Decision notification for your submission 1: Synthetic Learning Study,Decision: Accept\n";
  drive.mockResolvedValue(Buffer.from(csv).toString("base64"));
  const send = (body: unknown) =>
    fetch(url, { method: "POST", headers: auth, body: JSON.stringify(body) });
  for (let i = 0; i < 2; i++) {
    const response = await send({ ...input, notifications: undefined });
    expect(response.status).toBe(200);
    expect((await response.json()).announcements[0].text).toContain("Synthetic Learning Study");
  }
  expect(drive).toHaveBeenCalledTimes(2);
  expect(drive).toHaveBeenCalledWith(
    "1M88hLvN6WvWIthUPTnHilWbsmOz2DZg7",
    expect.objectContaining({ maxBytes: 25 * 1024 * 1024 }),
  );
  expect((await send(input)).status).toBe(200);
  expect(drive).toHaveBeenCalledTimes(2);
  drive.mockRejectedValue(new Error("private vendor details"));
  const failed = await send({ ...input, notifications: undefined });
  expect(failed.status).toBe(500);
  expect(await failed.text()).not.toContain("private vendor details");
  expect((await send(input)).status).toBe(200);
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
  expect(
    app.service.upsertPaper({
      id: "synthetic-paper",
      title: "Synthetic Learning Study",
      authors: ["Test Author"],
      current_step: "overleaf_writing",
      artifacts: { arxiv_url: "https://arxiv.org/abs/2601.12345" },
    }).ok,
  ).toBe(true);
  const response = await fetch(url, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      ...input,
      members: [{ openreview_id: "~Test_Author1", handle: "InjectedHandle" }],
      paper_links: [
        { title: "Synthetic Learning Study", arxiv_url: "https://arxiv.org/abs/2601.99999" },
      ],
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
  expect(result.announcements[0].text).toContain(
    "1. Synthetic Learning Study (Main conference) https://arxiv.org/abs/2601.12345",
  );
  expect(result.announcements[0].text).not.toContain("2601.99999");
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

it("accepts CSV with the same results as JSON and rejects malformed CSV", async () => {
  const { url, headers } = await setup();
  const auth = headers(true);
  const send = (body: unknown) =>
    fetch(url, { method: "POST", headers: auth, body: JSON.stringify(body) });
  const json = await (await send(input)).json();
  const csv = await send({
    ...input,
    notifications: undefined,
    notifications_csv:
      "id,date_utc,venue_domain,subject,message\nsynthetic,2026-09-21 14:13:20,NeurIPS.cc/2026/Conference,Decision notification for your submission 1: Synthetic Learning Study,Decision: Accept\n",
  });
  expect(csv.status).toBe(200);
  expect(await csv.json()).toEqual(json);
  expect((await send({ ...input, notifications_csv: "bad" })).status).toBe(400);
  expect(
    (await send({ ...input, notifications: undefined, notifications_csv: "bad" })).status,
  ).toBe(422);
});

it("accepts the next generation while the previous temporary directory is being removed", async () => {
  const { url, headers } = await setup();
  const auth = headers(true);
  let release!: () => void;
  const pendingCleanup = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.mockImplementationOnce(() => pendingCleanup);
  const send = () =>
    fetch(url, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(input),
    });
  try {
    expect((await send()).status).toBe(200);
    expect(cleanup).toHaveBeenCalled();
    expect((await send()).status).toBe(200);
  } finally {
    release();
  }
});
