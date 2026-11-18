// Scheduled Member Type changes: an admin records "a week, then acquaintance", and the daily sweep
// makes the change on the day with the same save the Edit member form makes -- in the scheduler's
// name, silently unless they asked otherwise, and exactly once.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotLabMemberInput, AdminBotStoredProposal } from "../contracts/actions.js";
import { resolveGroupMeetingEventId } from "../contracts/group-meeting.js";
import { withCompleteProfile } from "../contracts/profile-completion.test-helpers.js";
import type { AdminBotScheduledMemberChange } from "../contracts/scheduled-member-changes.js";
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
    const saved = mock.service.upsertLabMember(withCompleteProfile(seed));
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

type Sweep = Record<
  "done" | "failed" | "held",
  Array<{ id: string; member_id: string; member_type: string; detail: string }>
>;

const json = { "Content-Type": "application/json" };

const schedule = (baseUrl: string, token: string, body: Record<string, unknown>) =>
  fetch(`${baseUrl}/lab/scheduled-member-changes`, {
    method: "POST",
    headers: { ...json, Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });

const sweep = async (baseUrl: string): Promise<Sweep> => {
  const response = await fetch(`${baseUrl}/lab/scheduled-member-changes/run`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_TOKEN}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Sweep;
};

const list = async (baseUrl: string, token: string, status?: string) =>
  (
    (await (
      await fetch(`${baseUrl}/lab/scheduled-member-changes${status ? `?status=${status}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).json()) as { changes: AdminBotScheduledMemberChange[] }
  ).changes;

const memberType = async (baseUrl: string, token: string, id: string) => {
  const body = (await (
    await fetch(`${baseUrl}/lab/members`, { headers: { Authorization: `Bearer ${token}` } })
  ).json()) as { members?: Array<{ id: string; member_type?: string }> };
  return body.members?.find((member) => member.id === id)?.member_type;
};

describe("scheduled member changes", () => {
  it("makes a due change on the sweep, silently, in the scheduler's name, once", async () => {
    const { baseUrl, mock, executed, mailed } = await startService({
      sheetRows: [["Cora Coauthor", "coauthor-major", "cora@lab.test", ""]],
      meeting: ["admin@cs.toronto.edu", "cora@lab.test"],
    });
    const token = await adminToken(mock, baseUrl);

    const created = await schedule(baseUrl, token, {
      member_id: "cora",
      member_type: "alumni",
      after_days: 0,
      reason: "agreed in the engagement thread",
    });
    expect(created.status).toBe(201);
    const change = (await created.json()) as AdminBotScheduledMemberChange;
    expect(change).toMatchObject({
      member_id: "cora",
      member_type: "alumni",
      status: "pending",
      silent: true,
      created_by: "admin",
    });
    // Scheduling is only writing the decision down.
    expect(await memberType(baseUrl, token, "cora")).toBe("coauthor-major");
    expect(executed).toEqual([]);

    const first = await sweep(baseUrl);
    expect(first.failed).toEqual([]);
    expect(first.held).toEqual([]);
    expect(first.done.map((entry) => entry.id)).toEqual([change.id]);
    expect(await memberType(baseUrl, token, "cora")).toBe("alumni");
    // The external steps were approved by the admin who scheduled, not by the service token.
    expect(executed.length).toBeGreaterThan(0);
    for (const proposal of executed) {
      expect(proposal.approvals.map((approval) => approval.approver_id)).toEqual(["admin"]);
    }
    // Moving into alumni is the one change that mails a guide; scheduled changes do not unless asked.
    expect(mailed).toEqual([]);

    const settled = (await list(baseUrl, token, "done"))[0];
    expect(settled).toMatchObject({ id: change.id, status: "done" });
    expect(settled?.outcome).toBeTruthy();
    expect(settled?.settled_at).toBeTruthy();

    // A second sweep finds nothing left to do.
    const ran = executed.length;
    expect(await sweep(baseUrl)).toEqual({ done: [], failed: [], held: [] });
    expect(executed.length).toBe(ran);
  });

  it("sends the guide when the admin turned silent off", async () => {
    const { baseUrl, mock, mailed } = await startService();
    const token = await adminToken(mock, baseUrl);
    await schedule(baseUrl, token, {
      member_id: "cora",
      member_type: "alumni",
      after_days: 0,
      silent: false,
    });
    expect((await sweep(baseUrl)).done).toHaveLength(1);
    expect(mailed.map((mail) => mail.email)).toEqual(["cora@lab.test"]);
  });

  it("leaves a change alone until its day, and not at all once cancelled", async () => {
    const { baseUrl, mock, executed } = await startService();
    const token = await adminToken(mock, baseUrl);
    const change = (await (
      await schedule(baseUrl, token, {
        member_id: "cora",
        member_type: "acquaintance",
        after_days: 7,
      })
    ).json()) as AdminBotScheduledMemberChange;
    const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(change.due_on).toBe(due);

    expect(await sweep(baseUrl)).toEqual({ done: [], failed: [], held: [] });
    expect(await memberType(baseUrl, token, "cora")).toBe("coauthor-major");

    // One waiting change per person.
    const again = await schedule(baseUrl, token, {
      member_id: "cora",
      member_type: "alumni",
      after_days: 1,
    });
    expect(again.status).toBe(409);

    const cancelled = await fetch(`${baseUrl}/lab/scheduled-member-changes/${change.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as AdminBotScheduledMemberChange).status).toBe("cancelled");
    // The row stays, as the record of a decision that was reversed.
    expect((await list(baseUrl, token)).map((entry) => entry.status)).toEqual(["cancelled"]);
    const twice = await fetch(`${baseUrl}/lab/scheduled-member-changes/${change.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(twice.status).toBe(409);
    expect(executed).toEqual([]);
  });

  it("refuses the service token for scheduling, and bad requests from an admin", async () => {
    const { baseUrl, mock } = await startService();
    const token = await adminToken(mock, baseUrl);

    // The sweep's token may run what admins decided; it may not decide.
    const asService = await schedule(baseUrl, SERVICE_TOKEN, {
      member_id: "cora",
      member_type: "acquaintance",
      after_days: 7,
    });
    expect(asService.status).toBeGreaterThanOrEqual(401);
    expect(asService.status).toBeLessThan(500);

    const cases: Array<[Record<string, unknown>, number]> = [
      [{ member_type: "acquaintance", after_days: 7 }, 400],
      [{ member_id: "nobody", member_type: "acquaintance", after_days: 7 }, 404],
      [{ member_id: "cora", member_type: "wizard", after_days: 7 }, 400],
      [{ member_id: "cora", member_type: "coauthor-major", after_days: 7 }, 409],
      [{ member_id: "cora", member_type: "acquaintance" }, 400],
      [
        { member_id: "cora", member_type: "acquaintance", after_days: 7, due_on: "2099-01-01" },
        400,
      ],
      [{ member_id: "cora", member_type: "acquaintance", after_days: 1.5 }, 400],
      [{ member_id: "cora", member_type: "acquaintance", after_days: 366 }, 400],
      [{ member_id: "cora", member_type: "acquaintance", due_on: "2020-01-01" }, 400],
      [{ member_id: "cora", member_type: "acquaintance", due_on: "2027-02-31" }, 400],
    ];
    for (const [body, status] of cases) {
      const response = await schedule(baseUrl, token, body);
      expect([JSON.stringify(body), response.status]).toEqual([JSON.stringify(body), status]);
    }
    expect(await list(baseUrl, token)).toEqual([]);
  });

  it("holds a change whose scheduler is no longer an admin", async () => {
    const { baseUrl, mock, executed } = await startService();
    const token = await adminToken(mock, baseUrl);
    const change = (await (
      await schedule(baseUrl, token, {
        member_id: "cora",
        member_type: "acquaintance",
        after_days: 0,
      })
    ).json()) as AdminBotScheduledMemberChange;

    const demoted = mock.service.upsertLabMember(
      withCompleteProfile({
        id: "admin",
        name: "Admin",
        email: "admin@cs.toronto.edu",
        privilege_level: "member",
        member_type: "full",
      } as AdminBotLabMemberInput),
    );
    expect(demoted.ok).toBe(true);

    const result = await sweep(baseUrl);
    expect(result.done).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.held.map((entry) => entry.id)).toEqual([change.id]);
    expect(executed).toEqual([]);
    expect(
      mock.service
        .scheduledMemberChanges()
        .due()
        .map((entry) => entry.id),
    ).toEqual([change.id]);
  });
});
