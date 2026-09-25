// PUT /lab/members/:id with a new Member Type, from the Lab Members tab: the access level moves with
// the type, and the sheet, Slack rooms, Monday meeting and lab calendar follow -- approved by the
// admin who saved, executed on the spot, and silent except for somebody moving into alumni.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMemberInput, AdminBotStoredProposal } from "../contracts/actions.js";
import { resolveGroupMeetingEventId } from "../contracts/group-meeting.js";
import type { AdminBotCalendarEvent } from "../workflows/calendar/events.js";
import type { AdminBotOnboardingSender } from "../workflows/onboarding/guide-sender.js";
import { createAdminBotMockService } from "./server.js";

const SERVICE_TOKEN = "test-service-token";
const SERIES = resolveGroupMeetingEventId();
const HEADER = [
  "Name",
  "Member Type",
  "Email for correspondence (the more professional the better)",
  "Slack email",
];

const running: Array<ReturnType<typeof createAdminBotMockService>> = [];

afterEach(async () => {
  while (running.length > 0) {
    const mock = running.pop();
    if (!mock) {
      continue;
    }
    await new Promise<void>((resolve, reject) => {
      mock.server.close((error) => (error ? reject(error) : resolve()));
    });
    mock.close();
  }
});

async function startService(options: { sheetRows?: string[][]; meeting?: string[] } = {}) {
  const executed: AdminBotStoredProposal[] = [];
  const mailed: Array<{ email: string; template?: string }> = [];
  const calendarShares: string[] = [];
  const onboardingSender = (async (request: { email: string; template_id?: string }) => {
    mailed.push({ email: request.email, template: request.template_id });
    return { ok: true, payload: { template_id: "alumni", subject: "Hi", body: "Hi" } };
  }) as unknown as AdminBotOnboardingSender;
  const reader = vi.fn(
    async (): Promise<AdminBotCalendarEvent[]> =>
      options.meeting
        ? [
            {
              id: `${SERIES}_20261005T133000Z`,
              summary: "Group meeting",
              start: "2026-10-05T13:30:00Z",
              end: "2026-10-05T14:30:00Z",
              attendees: options.meeting,
            } as AdminBotCalendarEvent,
          ]
        : [],
  );
  const mock = createAdminBotMockService({
    serviceToken: SERVICE_TOKEN,
    calendarInviteRunner: async (email: string) => {
      calendarShares.push(email);
    },
    accountApprovedEmailRunner: async () => {},
    calendarEventsReader: reader,
    executor: {
      execute: async (proposal) => {
        executed.push(proposal);
        return { handled: true };
      },
    },
    onboardingSender,
    memberSheet: {
      spreadsheetId: "sheet-1",
      tab: "Roster",
      read: vi.fn(async () => [HEADER, ...(options.sheetRows ?? [])]),
    },
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
  running.push(mock);
  for (const seed of [
    {
      id: "admin",
      name: "Admin",
      email: "admin@cs.toronto.edu",
      privilege_level: "admin",
      member_type: "full",
    },
    {
      id: "cora",
      name: "Cora Coauthor",
      email: "cora@lab.test",
      slack_user_id: "UCORA",
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
      member_type: "coauthor-major",
    },
  ] as AdminBotLabMemberInput[]) {
    const saved = mock.service.upsertLabMember(seed);
    if (!saved.ok) {
      throw new Error(saved.error.message);
    }
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    mock,
    executed,
    mailed,
    calendarShares,
  };
}

async function adminToken(
  mock: ReturnType<typeof createAdminBotMockService>,
  baseUrl: string,
): Promise<string> {
  const headers = { "Content-Type": "application/json" };
  await fetch(`${baseUrl}/auth/claim`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      member_id: "admin",
      email: "admin@cs.toronto.edu",
      password: "correcthorse",
    }),
  });
  const pending = await fetch(`${baseUrl}/auth/registrations?status=pending`, {
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  const registration = (
    (await pending.json()) as { registrations: Array<{ id: string; member_id?: string }> }
  ).registrations.find((entry) => entry.member_id === "admin");
  if (!registration) {
    throw new Error("no pending registration for admin");
  }
  const approved = await mock.auth.approveRegistration(registration.id, "seed-admin");
  if (!approved.ok) {
    throw new Error(approved.error.message);
  }
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: "admin@cs.toronto.edu", password: "correcthorse" }),
  });
  return ((await res.json()) as { session_token: string }).session_token;
}

type ChangeBody = {
  privilege_level: string;
  collaborator_subgroup?: string;
  member_type?: string;
  member_type_change?: {
    privilege_level: { from: string; to: string };
    steps: Array<{ step: string; status: string; target?: string; detail?: string }>;
  };
};

const save = (baseUrl: string, token: string, id: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/lab/members/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

describe("PUT /lab/members/:id changing Member Type", () => {
  it("moves a coauthor to alumni: access level, sheet, rooms, meeting and the alumni mail", async () => {
    const { baseUrl, mock, executed, mailed } = await startService({
      sheetRows: [["Cora Coauthor", "coauthor-major", "cora@lab.test", ""]],
      meeting: ["admin@cs.toronto.edu", "cora@lab.test"],
    });
    const token = await adminToken(mock, baseUrl);

    const response = await save(baseUrl, token, "cora", {
      member_type: "alumni",
      // The form always resends the current Privilege; unchanged, it must not block the move.
      privilege_level: "external_collaborator",
      collaborator_subgroup: "coauthor_major",
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as ChangeBody;

    expect(body.member_type).toBe("alumni");
    expect(body.collaborator_subgroup).toBe("alumni");
    const steps = body.member_type_change?.steps ?? [];
    expect(steps.every((step) => step.status === "done")).toBe(true);

    // Every external step ran through the gate, approved by the admin who saved.
    const types = executed.map((proposal) => proposal.type);
    expect(types).toContain("sheet.update_cells");
    expect(types).toContain("slack.remove_from_channel");
    expect(types).toContain("calendar.remove_attendees");
    for (const proposal of executed) {
      expect(proposal.approvals.map((approval) => approval.approver_id)).toEqual(["admin"]);
    }
    const sheet = executed.find((proposal) => proposal.type === "sheet.update_cells");
    expect(JSON.stringify(sheet?.proposed_payload)).toContain("alumni");
    const removal = executed.find((proposal) => proposal.type === "calendar.remove_attendees");
    expect(removal?.proposed_payload.removed_attendees).toEqual(["cora@lab.test"]);
    // The one mail this change sends, through the onboarding sender rather than the executor.
    expect(steps.find((step) => step.step === "alumni_mail")?.status).toBe("done");
    expect(mailed.map((entry) => entry.email)).toEqual(["cora@lab.test"]);
    expect(mock.service.listPending().ok && mock.service.listPending().payload).toMatchObject({
      proposals: [],
    });
  });

  it("promotes a coauthor to full without mail and without leaving the lab's rooms", async () => {
    const { baseUrl, mock, executed, mailed, calendarShares } = await startService({
      sheetRows: [["Cora Coauthor", "coauthor-major", "cora@lab.test", ""]],
      meeting: ["admin@cs.toronto.edu", "cora@lab.test"],
    });
    const token = await adminToken(mock, baseUrl);

    const response = await save(baseUrl, token, "cora", {
      member_type: "full",
      privilege_level: "external_collaborator",
    });
    const body = (await response.json()) as ChangeBody;

    expect(body.privilege_level).toBe("member");
    expect(body.collaborator_subgroup).toBeUndefined();
    expect(executed.map((proposal) => proposal.type)).not.toContain("slack.remove_from_channel");
    // Already on the Monday meeting as a major coauthor, so nothing to do there.
    expect(executed.map((proposal) => proposal.type)).not.toContain("calendar.add_attendees");
    // The admin's own sign-up shared the calendar with them too; only Cora's share is this change's.
    expect(calendarShares.filter((email) => email !== "admin@cs.toronto.edu")).toEqual([
      "cora@lab.test",
    ]);
    expect(mailed).toEqual([]);
  });

  it("lets an explicit Privilege in the same save win", async () => {
    const { baseUrl, mock } = await startService();
    const token = await adminToken(mock, baseUrl);

    const explicit = (await (
      await save(baseUrl, token, "cora", { member_type: "full", privilege_level: "trial" })
    ).json()) as ChangeBody;
    expect(explicit.privilege_level).toBe("trial");
  });

  it("grants admin from the admin tag, and refuses an admin removing their own", async () => {
    const { baseUrl, mock, mailed } = await startService();
    const token = await adminToken(mock, baseUrl);

    const promoted = (await (
      await save(baseUrl, token, "cora", { member_type: "full, adminbot-admin" })
    ).json()) as ChangeBody;
    expect(promoted.privilege_level).toBe("admin");

    const self = await save(baseUrl, token, "admin", { member_type: "alumni" });
    expect(self.status).toBe(409);
    expect(mock.service.getLabMemberView("admin").ok).toBe(true);
    const stillAdmin = mock.service.listLabMembers();
    expect(
      stillAdmin.ok && stillAdmin.payload.members.find((row) => row.id === "admin"),
    ).toMatchObject({ privilege_level: "admin", member_type: "full" });
    expect(mailed).toEqual([]);

    // Another admin can take it away.
    const demoted = (await (
      await save(baseUrl, token, "cora", { member_type: "full" })
    ).json()) as ChangeBody;
    expect(demoted.privilege_level).toBe("member");
  });

  it("gives a new member the access level their type implies", async () => {
    const { baseUrl, mock } = await startService();
    const token = await adminToken(mock, baseUrl);

    const created = (await (
      await save(baseUrl, token, "newbie", {
        name: "New Person",
        email: "newbie@cs.toronto.edu",
        member_type: "full",
      })
    ).json()) as ChangeBody;

    expect(created.privilege_level).toBe("member");
    // A new record is onboarded through Add member, not re-onboarded here.
    expect(created.member_type_change).toBeUndefined();
  });

  it("does nothing outside the database when the type did not change", async () => {
    const { baseUrl, mock, executed, mailed } = await startService({
      sheetRows: [["Cora Coauthor", "coauthor-major", "cora@lab.test", ""]],
    });
    const token = await adminToken(mock, baseUrl);

    const body = (await (
      await save(baseUrl, token, "cora", { member_type: "Coauthor-Major ", notes: "hi" })
    ).json()) as ChangeBody;

    expect(body.member_type_change).toBeUndefined();
    expect(executed).toEqual([]);
    expect(mailed).toEqual([]);
  });

  it("refuses a member type change from the service token", async () => {
    const { baseUrl, executed } = await startService();

    const response = await fetch(`${baseUrl}/lab/members/cora`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({ member_type: "alumni" }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(executed).toEqual([]);
  });

  it("lists the standing meetings for an admin only", async () => {
    const { baseUrl, mock } = await startService({ meeting: ["cora@lab.test"] });
    const token = await adminToken(mock, baseUrl);

    const listed = await fetch(`${baseUrl}/lab/meetings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { meetings: Array<{ id: string; kind: string }> };
    expect(body.meetings).toMatchObject([{ id: SERIES, kind: "group" }]);

    const service = await fetch(`${baseUrl}/lab/meetings`, {
      headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
    });
    expect(service.status).toBe(403);
  });

  it("applies the Meetings checkboxes, and a changed Monday box outranks the type", async () => {
    const { baseUrl, mock, executed } = await startService({
      sheetRows: [["Cora Coauthor", "coauthor-major", "cora@lab.test", ""]],
      meeting: ["admin@cs.toronto.edu"],
    });
    const token = await adminToken(mock, baseUrl);

    // Cora is not on the Monday meeting; the admin ticks it while also making her alumni, which on
    // its own would keep her off it.
    const response = await save(baseUrl, token, "cora", {
      member_type: "alumni",
      meetings: [SERIES],
    });
    const body = (await response.json()) as ChangeBody & {
      meeting_changes?: Array<{ step: string; status: string }>;
      meetings?: unknown;
    };

    expect(body.meetings).toBeUndefined();
    expect(body.meeting_changes).toEqual([
      expect.objectContaining({ step: "meeting", status: "done" }),
    ]);
    const types = executed.map((proposal) => proposal.type);
    expect(types).toContain("calendar.add_attendees");
    expect(types).not.toContain("calendar.remove_attendees");
    const stored = mock.service.listLabMembers();
    expect(stored.ok && stored.payload.members.find((row) => row.id === "cora")).not.toHaveProperty(
      "meetings",
    );
  });
});
