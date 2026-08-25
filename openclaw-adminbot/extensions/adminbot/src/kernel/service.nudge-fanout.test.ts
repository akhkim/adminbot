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

function serviceWith(options: { headProfessor?: boolean; slackForMei?: boolean } = {}) {
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
      id: "zhijing",
      name: "Zhijing Jin",
      privilege_level: "admin",
      slack_user_id: "U-ZJ",
    } as never),
  );
  unwrap(
    service.upsertLabMember({
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

  it("opens a three-way DM once something important has waited five days", async () => {
    const { service, sent } = serviceWith();
    await nudge(service);
    ageNotifications(service, 6);

    const result = unwrap(await service.escalateStaleNudges("test"));
    expect(result.escalated).toEqual([
      expect.objectContaining({ member_id: "mei", title: "Submission ID missing" }),
    ]);
    const dm = sent.find((entry) => entry.type === "member_nudge.escalate");
    // The member is in the room. An escalation that became a private message about them is the
    // failure this shape exists to avoid.
    expect(dm?.payload.user_ids).toEqual(["U-MEI", "U-ZJ"]);
    expect(String(dm?.payload.message)).toContain("Submission ID missing");
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
