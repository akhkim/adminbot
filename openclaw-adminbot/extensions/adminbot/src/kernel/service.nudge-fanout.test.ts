// Every nudge goes three ways, and the important ones that nobody answers reach the head professor.
import { describe, expect, it } from "vitest";
import { AdminBotService, buildNudgeEscalationMessage } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

type Sent = { type: string; payload: Record<string, unknown> };

function serviceWith(
  options: {
    headProfessor?: boolean;
    slackForMei?: boolean;
    /** `null` leaves the professor without a linked Slack account. */
    headProfessorSlack?: null;
  } = {},
) {
  const sent: Sent[] = [];
  const service = new AdminBotService(undefined, {
    executor: {
      execute: async (proposal) => {
        sent.push({
          type: proposal.type,
          payload: (proposal.proposed_payload ?? {}) as Record<string, unknown>,
        });
        return {
          handled:
            proposal.type === "member_nudge.send" || proposal.type === "member_nudge.escalate",
        };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      ...(options.headProfessorSlack === null ? {} : { slack_user_id: "U-ZJ" }),
    } as never),
  );
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "mei",
      name: "Mei Chen",
      privilege_level: "member",
      ...(options.slackForMei === false ? {} : { slack_user_id: "U-MEI" }),
    } as never),
  );
  if (options.headProfessor !== false) {
    unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
  }
  return { service, sent };
}

const DAY = 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("every nudge also lands in the portal", () => {
  it("files a notification alongside the Slack message", async () => {
    const { service, sent } = serviceWith();
    unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ["mei"],
          message: "Your camera-ready is due Friday.",
          title: "Camera-ready due Friday",
          tab: "myWork",
          important: true,
        },
        "test",
      ),
    );
    expect(sent.map((entry) => entry.type)).toEqual(["member_nudge.send"]);
    const notifications = unwrap(service.listMemberNotifications("mei")).notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      title: "Camera-ready due Friday",
      body: "Your camera-ready is due Friday.",
      tab: "myWork",
      important: true,
      kind: "nudge",
    });
    expect(notifications[0]?.read_at).toBeUndefined();
  });

  it("still tells a member with no Slack account, who would otherwise hear nothing", async () => {
    const { service, sent } = serviceWith({ slackForMei: false });
    const result = unwrap(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["mei"], message: "Please fill your profile." },
        "test",
      ),
    );
    // The send is skipped and the notification is not: Slack is where the lab talks, but a missing
    // account must not be what decides whether somebody is ever told.
    expect(result.skipped).toEqual([{ member_id: "mei", reason: "member has no slack_user_id" }]);
    expect(sent).toEqual([]);
    expect(unwrap(service.listMemberNotifications("mei")).notifications).toHaveLength(1);
  });

  it("files nothing for an id that names no member", async () => {
    const { service } = serviceWith();
    const result = unwrap(
      await service.sendMemberNudge(
        { channel: "slack", recipient_member_ids: ["ghost"], message: "hi" },
        "test",
      ),
    );
    expect(result.skipped).toEqual([{ member_id: "ghost", reason: "member not found" }]);
  });
});

describe("escalating to the head professor", () => {
  async function nudge(
    service: AdminBotService,
    fields: { important?: boolean; title?: string } = {},
  ) {
    unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: ["mei"],
          message: "The submission ID is still missing.",
          title: fields.title ?? "Submission ID missing",
          important: fields.important ?? true,
        },
        "test",
      ),
    );
  }

  function ageNotifications(service: AdminBotService, days: number) {
    for (const notification of unwrap(service.listMemberNotifications("mei")).notifications) {
      // The store is the only place the age lives, so the test moves it rather than the clock.
      (
        service as never as { store: { saveMemberNotification: (n: unknown) => void } }
      ).store.saveMemberNotification({ ...notification, created_at: iso(days * DAY) });
    }
  }

  it("tells the member once something important has waited five days, and nobody else", async () => {
    const { service, sent } = serviceWith();
    await nudge(service);
    ageNotifications(service, 6);

    const result = unwrap(await service.escalateStaleNudges("test"));
    expect(result.escalated).toEqual([
      expect.objectContaining({ member_id: "mei", title: "Submission ID missing" }),
    ]);
    const dm = sent.find((entry) => entry.type === "member_nudge.escalate");
    // The member, and only the member. The head professor is not a recipient of anything AdminBot
    // sends: their copy is the escalation queue on their own page. The member is still told in as
    // many words that it has gone there, so this is not a private complaint about them.
    expect(dm?.payload.user_ids).toEqual(["U-MEI"]);
    expect(String(dm?.payload.message)).toContain("Submission ID missing");
    expect(String(dm?.payload.message)).toContain("list");
  });

  it("sends the head professor nothing at all", async () => {
    const { service, sent } = serviceWith();
    await nudge(service);
    ageNotifications(service, 6);
    unwrap(await service.escalateStaleNudges("test"));

    // No Slack payload names them...
    for (const entry of sent) {
      const ids = (entry.payload as { user_ids?: unknown }).user_ids;
      if (Array.isArray(ids)) {
        expect(ids).not.toContain("U-ZJ");
      }
      expect(JSON.stringify(entry.payload)).not.toContain("U-ZJ");
    }
    // ...and no portal notification is filed against them either. `sendMemberNudge` refuses the
    // head professor ahead of the notification write, so this holds for every sweep, not just this
    // one -- see the guard there.
    expect(unwrap(service.listMemberNotifications("zhijing")).notifications).toEqual([]);
  });

  it("still escalates when the head professor has no Slack account", async () => {
    // Nothing is sent to them any more, so a missing Slack link must not stop every other member's
    // escalation. It used to 409 the whole pass.
    const { service } = serviceWith({ headProfessorSlack: null });
    await nudge(service);
    ageNotifications(service, 6);
    const result = unwrap(await service.escalateStaleNudges("test"));
    expect(result.escalated).toHaveLength(1);
  });

  it("escalates once, however often the sweep runs", async () => {
    const { service, sent } = serviceWith();
    await nudge(service);
    ageNotifications(service, 6);
    unwrap(await service.escalateStaleNudges("test"));
    const after = unwrap(await service.escalateStaleNudges("test"));
    expect(after.escalated).toEqual([]);
    expect(sent.filter((entry) => entry.type === "member_nudge.escalate")).toHaveLength(1);
  });

  it("leaves alone what is recent, unimportant, or already read", async () => {
    const { service, sent } = serviceWith();
    await nudge(service, { title: "Recent" });
    unwrap(await service.escalateStaleNudges("test"));
    expect(sent.filter((entry) => entry.type === "member_nudge.escalate")).toHaveLength(0);

    const { service: unimportant } = serviceWith();
    await unimportant.sendMemberNudge(
      {
        channel: "slack",
        recipient_member_ids: ["mei"],
        message: "FYI",
        title: "FYI",
        important: false,
      },
      "test",
    );
    ageNotifications(unimportant, 9);
    expect(unwrap(await unimportant.escalateStaleNudges("test")).escalated).toEqual([]);

    const { service: read } = serviceWith();
    await nudge(read);
    ageNotifications(read, 9);
    unwrap(read.markMemberNotificationsRead("mei"));
    expect(unwrap(await read.escalateStaleNudges("test")).escalated).toEqual([]);
  });

  it("sends one DM per member, not one per overdue thing", async () => {
    const { service, sent } = serviceWith();
    await nudge(service, { title: "First" });
    await nudge(service, { title: "Second" });
    ageNotifications(service, 7);
    const result = unwrap(await service.escalateStaleNudges("test"));
    expect(result.escalated).toHaveLength(2);
    expect(sent.filter((entry) => entry.type === "member_nudge.escalate")).toHaveLength(1);
  });

  it("refuses rather than guessing when no head professor is configured", async () => {
    const { service } = serviceWith({ headProfessor: false });
    await nudge(service);
    const result = await service.escalateStaleNudges("test");
    expect(result.ok).toBe(false);
  });

  it("stamps a member with no Slack account so the sweep does not retry them forever", async () => {
    const { service } = serviceWith({ slackForMei: false });
    await nudge(service);
    ageNotifications(service, 6);
    const result = unwrap(await service.escalateStaleNudges("test"));
    expect(result.skipped).toEqual([{ member_id: "mei", reason: "member has no slack_user_id" }]);
    expect(unwrap(await service.escalateStaleNudges("test")).skipped).toEqual([]);
  });
});

describe("buildNudgeEscalationMessage", () => {
  it("addresses the member in front of the professor, and says how to close it", () => {
    const message = buildNudgeEscalationMessage({
      memberName: "Mei Chen",
      professorName: "Zhijing Jin",
      outstanding: ["Submission ID missing", "Slides not uploaded"],
      days: 5,
    });
    expect(message).toContain("Hi Mei");
    expect(message).toContain("5 days");
    expect(message).toContain("Zhijing Jin");
    expect(message).toContain("• Submission ID missing");
    expect(message).toContain("• Slides not uploaded");
    expect(message).toContain("say so here");
  });
});

describe("which nudges are important enough to escalate", () => {
  // The lab's answer, not a default: paper evidence, profile/timeline gaps and pre-registration
  // are the three where nobody finding out costs something that cannot be recovered later.
  const IMPORTANT = ["paper_slot", "profile"] as const;

  it("marks the three that escalate, and only those", async () => {
    const service = new AdminBotService(undefined, {
      executor: { execute: async () => ({ handled: true }) },
    });
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "mei",
        name: "Mei Chen",
        privilege_level: "member",
        slack_user_id: "U-MEI",
      } as never),
    );

    // Stand-ins for each sender, calling the funnel exactly as the service does.
    const cases: Array<{ title: string; kind: string; important?: boolean }> = [
      { title: "Evidence still missing on your paper", kind: "paper_slot", important: true },
      { title: "Your profile is missing required fields", kind: "profile", important: true },
      { title: "Register your paper's target venue", kind: "paper_slot", important: true },
      { title: "This week's paper update", kind: "nudge" },
      { title: "Please join the next Monday meeting", kind: "meeting_attendance" },
      { title: "Your profile photo needs replacing", kind: "profile" },
      { title: "Workshops that may fit your papers", kind: "workshop" },
    ];
    for (const entry of cases) {
      unwrap(
        await service.sendMemberNudge(
          {
            channel: "slack",
            recipient_member_ids: ["mei"],
            message: entry.title,
            title: entry.title,
            kind: entry.kind as never,
            ...(entry.important ? { important: true } : {}),
          },
          "test",
        ),
      );
    }

    const filed = unwrap(service.listMemberNotifications("mei")).notifications;
    const important = filed.filter((entry) => entry.important).map((entry) => entry.title);
    expect(important.toSorted()).toEqual(
      [
        "Evidence still missing on your paper",
        "Register your paper's target venue",
        "Your profile is missing required fields",
      ].toSorted(),
    );
    // The photo reminder is a profile-kind notification that is deliberately not important: the
    // kind says where it came from, the flag says whether it escalates, and they are not the same
    // question.
    expect(filed.find((entry) => entry.title.includes("photo"))?.important).toBeUndefined();
    expect(IMPORTANT).toContain(
      filed.find((entry) => entry.title.includes("Evidence"))?.kind as never,
    );
  });
});

// The queue the escalation pass was always computing and never handing anybody. Until this
// existed, `escalated_at` was written every weekday and read by nothing, so the professor's only
// copy of the list was one Slack message she had to catch as it went past.
describe("the escalation queue", () => {
  async function nudgeMember(
    service: AdminBotService,
    memberId: string,
    title: string,
  ): Promise<void> {
    unwrap(
      await service.sendMemberNudge(
        {
          channel: "slack",
          recipient_member_ids: [memberId],
          message: "Please take a look.",
          title,
          important: true,
        },
        "test",
      ),
    );
  }

  function age(service: AdminBotService, memberId: string, days: number): void {
    for (const notification of unwrap(service.listMemberNotifications(memberId)).notifications) {
      (
        service as never as { store: { saveMemberNotification: (n: unknown) => void } }
      ).store.saveMemberNotification({ ...notification, created_at: iso(days * DAY) });
    }
  }

  it("is empty until something has actually been escalated", async () => {
    const { service } = serviceWith();
    await nudgeMember(service, "mei", "Submission ID missing");
    // Filed, but neither old enough nor escalated yet.
    expect(unwrap(service.listEscalatedNudges()).members).toEqual([]);

    age(service, "mei", 6);
    unwrap(await service.escalateStaleNudges("test"));

    const queue = unwrap(service.listEscalatedNudges()).members;
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ member_id: "mei", name: "Mei Chen", slack_user_id: "U-MEI" });
    expect(queue[0]?.notifications.map((entry) => entry.title)).toEqual(["Submission ID missing"]);
  });

  // One row per person, because the professor's next move is a message to a person about
  // everything they are sitting on -- the same reason the escalation sends one DM per member.
  it("groups a member's outstanding nudges into one row", async () => {
    const { service } = serviceWith();
    await nudgeMember(service, "mei", "First");
    await nudgeMember(service, "mei", "Second");
    age(service, "mei", 7);
    unwrap(await service.escalateStaleNudges("test"));

    const queue = unwrap(service.listEscalatedNudges()).members;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.notifications.map((entry) => entry.title).toSorted()).toEqual([
      "First",
      "Second",
    ]);
  });

  // No second "handled" flag to forget: acknowledging the nudge is what clears it, through the
  // path the member already uses.
  it("drains when the member reads the nudge", async () => {
    const { service } = serviceWith();
    await nudgeMember(service, "mei", "Submission ID missing");
    age(service, "mei", 6);
    unwrap(await service.escalateStaleNudges("test"));
    expect(unwrap(service.listEscalatedNudges()).members).toHaveLength(1);

    unwrap(service.markMemberNotificationsRead("mei"));
    expect(unwrap(service.listEscalatedNudges()).members).toEqual([]);
  });

  it("leaves out somebody who has since become alumni", async () => {
    const { service } = serviceWith();
    await nudgeMember(service, "mei", "Submission ID missing");
    age(service, "mei", 6);
    unwrap(await service.escalateStaleNudges("test"));
    expect(unwrap(service.listEscalatedNudges()).members).toHaveLength(1);

    unwrap(service.upsertLabMember({ receives_nudges: true, id: "mei", name: "Mei Chen", status: "alumni" } as never));
    expect(unwrap(service.listEscalatedNudges()).members).toEqual([]);
  });

  // Oldest first: the queue is worked from the top, and the top should be whoever has been waiting
  // longest rather than whoever was escalated most recently.
  it("orders members by their oldest escalation", async () => {
    const { service } = serviceWith();
    unwrap(
      service.upsertLabMember({
        receives_nudges: true,
        id: "ada",
        name: "Ada Ng",
        privilege_level: "member",
        slack_user_id: "U-ADA",
      } as never),
    );
    await nudgeMember(service, "mei", "Older");
    age(service, "mei", 9);
    unwrap(await service.escalateStaleNudges("test", { nowIso: iso(2 * DAY) }));

    await nudgeMember(service, "ada", "Newer");
    age(service, "ada", 9);
    unwrap(await service.escalateStaleNudges("test"));

    expect(unwrap(service.listEscalatedNudges()).members.map((row) => row.member_id)).toEqual([
      "mei",
      "ada",
    ]);
  });
});
