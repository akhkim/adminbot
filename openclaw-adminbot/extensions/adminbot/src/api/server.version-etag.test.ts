import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotMeetingRecord } from "../contracts/actions.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "version-etag-service-token";
const PASSWORD = "correcthorse";

type Lab = Awaited<ReturnType<typeof startLab>>;
const running: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const lab of running.splice(0)) {
    await lab.close();
  }
  vi.restoreAllMocks();
});

function meeting(id: string, minutes: number): AdminBotMeetingRecord {
  return {
    id,
    topic: `Meeting ${id}`,
    started_at: `2026-09-${id.padStart(2, "0")}T15:00:00.000Z`,
    duration_minutes: minutes,
    recording: { share_url: `https://zoom.example/${id}` },
    attendees: [
      { member_id: "ada", display_name: "ada", present: true },
      { member_id: "grace", display_name: "grace", present: true },
    ] as AdminBotMeetingRecord["attendees"],
    source: "manual",
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  };
}

async function startLab() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "adminbot-version-etag-"));
  const databasePath = path.join(tempDir, "state.sqlite");
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    databasePath,
    calendarInviteRunner: async () => {},
    accountApprovedEmailRunner: async () => {},
  });
  await new Promise<void>((resolve, reject) => {
    mock.server.once("error", reject);
    mock.server.listen(0, "127.0.0.1", resolve);
  });
  running.push({
    close: async () => {
      await new Promise<void>((resolve) => mock.server.close(() => resolve()));
      await rm(tempDir, { recursive: true, force: true });
    },
  });
  const address = mock.server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing server address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const tokens: Record<string, string> = {};
  for (const [id, privilege] of [
    ["ada", "member"],
    ["grace", "member"],
    ["zhijing", "admin"],
  ] as const) {
    const email = `${id}@cs.toronto.edu`;
    expect(
      mock.service.upsertLabMember({ id, name: id, email, privilege_level: privilege }).ok,
    ).toBe(true);
    await fetch(`${baseUrl}/auth/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ member_id: id, email, password: PASSWORD }),
    });
    const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    const { registrations } = (await pending.json()) as {
      registrations: { id: string; member_id?: string }[];
    };
    const claim = registrations.find((entry) => entry.member_id === id)!;
    expect((await mock.auth.approveRegistration(claim.id, "test-admin")).ok).toBe(true);
    const login = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    tokens[id] = ((await login.json()) as { session_token: string }).session_token;
  }
  for (const [id, author] of [
    ["p1", "ada"],
    ["p2", "grace"],
  ]) {
    expect(
      mock.service.upsertPaper({
        id,
        title: `Paper ${id}`,
        authors: [author],
        venue: "ICLR",
        current_step: "overleaf_writing",
      }).ok,
    ).toBe(true);
  }
  mock.store.saveMeeting(meeting("1", 30));
  mock.store.saveMeeting(meeting("2", 60));
  const get = async (route: string, as: string, etag?: string) =>
    await fetch(`${baseUrl}${route}`, {
      headers: {
        Authorization: `Bearer ${as === "service" ? SERVICE_TOKEN : tokens[as]}`,
        ...(etag ? { "If-None-Match": etag } : {}),
      },
    });
  return { mock, databasePath, get };
}

const ROUTES = [
  "/member-map",
  "/member-map?unplaced=list",
  "/papers",
  "/papers?limit=50&offset=0",
  "/papers?scope=mine",
  "/meetings",
  "/meetings?limit=10",
];

/** Every store read a body build of these routes makes. */
function bodyBuildSpies(lab: Lab) {
  return [
    vi.spyOn(lab.mock.service, "memberMap"),
    vi.spyOn(lab.mock.store, "listPapers"),
    vi.spyOn(lab.mock.store, "countPapers"),
    vi.spyOn(lab.mock.store, "listMeetings"),
    vi.spyOn(lab.mock.store, "listMeetingsPage"),
  ];
}

async function tagOf(lab: Lab, route: string, as: string): Promise<string> {
  const response = await lab.get(route, as);
  expect(response.status, `${route} as ${as}`).toBe(200);
  await response.arrayBuffer();
  return response.headers.get("etag") ?? "";
}

describe("version ETags on the heavy list routes (sqlite)", () => {
  it("answers 304 before building the body", async () => {
    const lab = await startLab();
    for (const as of ["ada", "zhijing"]) {
      for (const route of ROUTES) {
        const etag = await tagOf(lab, route, as);
        expect(etag, `${route} as ${as}`).toMatch(/^W\/"v\./u);
        const spies = bodyBuildSpies(lab);
        const again = await lab.get(route, as, etag);
        expect(again.status, `${route} as ${as}`).toBe(304);
        expect(again.headers.get("etag")).toBe(etag);
        expect(again.headers.get("cache-control")).toBe("no-store");
        for (const spy of spies) {
          expect(spy, `${route} as ${as}`).not.toHaveBeenCalled();
          spy.mockRestore();
        }
      }
    }
  });

  it("never gives two roles, or two members' own views, the same tag", async () => {
    const lab = await startLab();
    for (const route of ROUTES) {
      const tags = new Map<string, string>();
      for (const as of ["ada", "grace", "zhijing"]) {
        tags.set(as, await tagOf(lab, route, as));
      }
      expect(tags.get("ada"), route).not.toBe(tags.get("zhijing"));
      // An admin presenting a member's tag is sent the admin body, not a 304.
      expect((await lab.get(route, "zhijing", tags.get("ada"))).status, route).toBe(200);
      if (route.startsWith("/meetings") || route === "/papers?scope=mine") {
        // Filtered or redacted per member.
        expect(tags.get("ada"), route).not.toBe(tags.get("grace"));
      }
    }
    const serviceTag = await tagOf(lab, "/member-map", "service");
    expect(serviceTag).not.toBe(await tagOf(lab, "/member-map", "zhijing"));
  });

  it("changes the tag on every write the body depends on", async () => {
    const lab = await startLab();
    const changes: Array<[string[], () => void]> = [
      [
        ["/papers", "/papers?limit=50&offset=0", "/papers?scope=mine"],
        () =>
          lab.mock.service.upsertPaper({
            id: "p3",
            title: "Paper p3",
            authors: ["ada"],
            venue: "ICML",
            current_step: "overleaf_writing",
          }),
      ],
      [["/papers", "/papers?scope=mine"], () => lab.mock.store.deletePaper("p3")],
      [["/meetings", "/meetings?limit=10"], () => lab.mock.store.saveMeeting(meeting("3", 90))],
      [["/meetings", "/meetings?limit=10"], () => lab.mock.store.deleteMeeting("3")],
      // The duration floor is a setting, not a meeting row.
      [
        ["/meetings", "/meetings?limit=10"],
        () => lab.mock.service.updateSettings({ meeting_minimum_minutes: 45 }),
      ],
      [
        ["/member-map", "/member-map?unplaced=list"],
        () => {
          const ada = lab.mock.store.getLabMember("ada")!;
          lab.mock.store.saveLabMember({ ...ada, location: "Zurich" });
        },
      ],
    ];
    for (const [routes, write] of changes) {
      const before = new Map<string, string>();
      for (const route of routes) {
        before.set(route, await tagOf(lab, route, "zhijing"));
      }
      write();
      for (const route of routes) {
        const response = await lab.get(route, "zhijing", before.get(route));
        expect(response.status, route).toBe(200);
        expect(response.headers.get("etag"), route).not.toBe(before.get(route));
      }
    }
  });

  it("notices a commit from another connection", async () => {
    const lab = await startLab();
    const etag = await tagOf(lab, "/papers", "zhijing");
    const other = new DatabaseSync(lab.databasePath);
    try {
      const paper = { id: "px", title: "Written elsewhere", current_step: "overleaf_writing" };
      other
        .prepare(
          "INSERT INTO adminbot_papers (id, current_step, updated_at, payload_json) VALUES (?, ?, ?, ?)",
        )
        .run(paper.id, paper.current_step, "2026-10-01T00:00:00.000Z", JSON.stringify(paper));
    } finally {
      other.close();
    }
    const response = await lab.get("/papers", "zhijing", etag);
    expect(response.status).toBe(200);
    expect(((await response.json()) as { papers: { id: string }[] }).papers.map((p) => p.id)).toContain(
      "px",
    );
  });
});
