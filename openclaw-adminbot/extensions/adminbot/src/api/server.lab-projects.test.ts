import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";

const running: Array<{ mock: ReturnType<typeof createAdminBotMockService>; cleanup: string }> = [];

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
    await rm(entry.cleanup, { force: true });
  }
});

async function startService() {
  const sensitiveInfoPath = path.join(
    os.tmpdir(),
    `adminbot-lab-projects-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    sensitiveInfoPath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  await new Promise<void>((resolve) => {
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing mock service address");
  }
  running.push({ mock, cleanup: sensitiveInfoPath });
  return { baseUrl: `http://127.0.0.1:${address.port}`, mock };
}

async function memberToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
  memberId: string,
): Promise<string> {
  const email = `${memberId}@example.test`;
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ member_id: memberId, email, password: "correcthorse" }),
  });
  const pending = (await (
    await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    })
  ).json()) as { registrations: Array<{ id: string; member_id?: string }> };
  const registration = pending.registrations.find((entry) => entry.member_id === memberId);
  if (!registration) {
    throw new Error(`no pending registration for ${memberId}`);
  }
  await mock.auth.approveRegistration(registration.id, "seed-admin");
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "correcthorse" }),
  });
  return ((await login.json()) as { session_token: string }).session_token;
}

async function seedLab(mock: ReturnType<typeof createAdminBotMockService>) {
  for (const [id, name, privilege_level] of [
    ["pi", "Synthetic PI", "admin"],
    ["student", "Synthetic Student", "member"],
    ["postdoc", "Synthetic Postdoc", "member"],
  ] as const) {
    const seeded = mock.service.upsertLabMember(
      withCompleteProfile({ id, name, email: `${id}@example.test`, privilege_level }),
    );
    expect(seeded.ok).toBe(true);
  }
  for (const input of [
    {
      id: "student-paper",
      title: "Synthetic Student Paper",
      alias: "ssp",
      author_links: [
        { name: "Synthetic Student", member_id: "student" },
        { name: "Outside Coauthor", email: "outside.coauthor@example.test" },
      ],
      notes: "private planning note",
      artifacts: {
        topic: "synthetic causal discovery",
        github_url: "https://github.com/example/ssp",
        overleaf_share_url: "https://www.overleaf.com/1234567890abcdefsecret",
        google_slides_url: "https://docs.google.com/presentation/d/synthetic",
      },
    },
    {
      id: "postdoc-paper",
      title: "Synthetic Postdoc Paper",
      author_links: [{ name: "Synthetic Postdoc", member_id: "postdoc" }],
      venue_decision: "reject",
    },
  ] as const) {
    const saved = mock.service.upsertPaper({
      authors: [],
      current_step: "overleaf_writing",
      ...input,
    });
    expect(saved.ok).toBe(true);
  }
  const update = mock.service.savePaperWeeklyUpdate({
    paperId: "student-paper",
    memberId: "student",
    body: "private weekly progress text",
  });
  expect(update.ok).toBe(true);
}

describe("GET /lab/projects", () => {
  it("lists every project in the lab for an admin, including papers the admin is not on", async () => {
    const { baseUrl, mock } = await startService();
    await seedLab(mock);
    const token = await memberToken(mock, baseUrl, "pi");

    const response = await fetch(`${baseUrl}/lab/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    const body = JSON.parse(text) as {
      projects: Array<{
        paper_id: string;
        status: string;
        topic?: string;
        members: Array<{ member_id: string; name: string }>;
        last_weekly_update?: { member_id: string; name?: string };
        links: {
          primary: { kind: string; url: string } | null;
          slack_channel: string | null;
          slides: { url: string } | null;
          poster: { url: string } | null;
        };
      }>;
    };
    const byId = new Map(body.projects.map((project) => [project.paper_id, project]));
    expect([...byId.keys()].toSorted()).toEqual(["postdoc-paper", "student-paper"]);

    const student = byId.get("student-paper");
    expect(student?.topic).toBe("synthetic causal discovery");
    expect(student?.status).toBe("active");
    expect(student?.members).toEqual([{ member_id: "student", name: "Synthetic Student" }]);
    expect(student?.links.primary).toEqual({
      kind: "github",
      url: "https://github.com/example/ssp",
    });
    expect(student?.links.slack_channel).toBe("proj-ssp");
    expect(student?.links.slides?.url).toBe("https://docs.google.com/presentation/d/synthetic");
    expect(student?.links.poster).toBeNull();
    expect(student?.last_weekly_update).toMatchObject({
      member_id: "student",
      name: "Synthetic Student",
    });
    expect(byId.get("postdoc-paper")?.status).toBe("rejected");

    // What the privacy rules keep local stays out of the list, even for an admin.
    expect(text).not.toContain("overleaf_share_url");
    expect(text).not.toContain("1234567890abcdefsecret");
    expect(text).not.toContain("outside.coauthor@example.test");
    expect(text).not.toContain("private planning note");
    expect(text).not.toContain("private weekly progress text");
  });

  it("lets the operator service token read it", async () => {
    const { baseUrl, mock } = await startService();
    await seedLab(mock);
    const response = await fetch(`${baseUrl}/lab/projects`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("refuses members, including one who is on a listed paper, and anonymous callers", async () => {
    const { baseUrl, mock } = await startService();
    await seedLab(mock);
    const route = `${baseUrl}/lab/projects`;

    expect((await fetch(route)).status).toBe(401);

    const token = await memberToken(mock, baseUrl, "student");
    const denied = await fetch(route, { headers: { Authorization: `Bearer ${token}` } });
    expect(denied.status).toBe(403);
    const text = await denied.text();
    expect(text).not.toContain("Synthetic Postdoc Paper");
    expect(text).not.toContain("Synthetic Student Paper");
  });
});
