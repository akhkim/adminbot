// A clear reminder reply applied without an admin: closed as the member, a receipt mailed back,
// and "undo" on that receipt putting it all back. The approval path is service.reminder-replies.test.ts.
import { describe, expect, it } from "vitest";
import type { AdminBotReminderReplyReading } from "../contracts/email-review.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";
import {
  canAutoApplyReminderReply,
  isUndoReply,
  reminderReplyConfirmationBody,
  resolveReminderReplyAutoConfig,
} from "./service.reminder-reply-auto.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const PAPER_TITLE = "Multi-Agent AI Systems Need Institutional Design";

type Mail = { message_id: string; to: string; body: string; account?: string };

async function nudged() {
  const store = new AdminBotMemoryStore();
  const mail: Mail[] = [];
  let sends = 0;
  const service = new AdminBotService(store, {
    paperflowBotEmail: "adminbot@example.org",
    executor: {
      execute: async (proposal) => {
        if (proposal.type === "reminder_reply.confirm") {
          mail.push(proposal.proposed_payload as Mail);
          return { handled: true, artifacts: { gmail_message_id: `sent-${mail.length}` } };
        }
        if (proposal.type !== "member_nudge.send") {
          return { handled: false };
        }
        sends += 1;
        return { handled: true, artifacts: { gmail_thread_id: `thread-${sends}` } };
      },
    },
  });
  unwrap(
    service.upsertLabMember({
      receives_nudges: true,
      id: "xq",
      name: "Xuanqiang Huang",
      privilege_level: "member",
      email: "xq@ethz.example",
    } as never),
  );
  unwrap(
    service.upsertPaper({
      id: "p1",
      title: PAPER_TITLE,
      authors: ["Xuanqiang Huang"],
      current_step: "submission",
      venue_decision: "accept",
      accepted_year: new Date().getUTCFullYear(),
    } as never),
  );
  unwrap(
    service.setPaperSlot({
      paperId: "p1",
      slot: "submission",
      input: { url: "https://openreview.net/forum?id=x" },
      memberId: "xq",
      privileged: true,
    }),
  );
  expect(unwrap(await service.sendPaperflowStageNudges("cron")).created).toHaveLength(1);
  return { store, service, mail };
}

function reading(
  overrides: Partial<AdminBotReminderReplyReading> = {},
): AdminBotReminderReplyReading {
  return {
    intent: "not_applicable",
    note: "moved to a Springer journal",
    moved_elsewhere: true,
    confidence: 0.92,
    ...overrides,
  };
}

const reply = (overrides: Partial<AdminBotReminderReplyReading> = {}) => ({
  messageId: "reply-1",
  threadId: "thread-1",
  sender: "xq@ethz.example",
  reading: reading(overrides),
  actor: "adminbot-email-automation",
  account: "bot@example.org",
});

describe("resolveReminderReplyAutoConfig", () => {
  it("is on only for exactly 1", () => {
    expect(resolveReminderReplyAutoConfig({}).enabled).toBe(false);
    expect(
      resolveReminderReplyAutoConfig({ ADMINBOT_REMINDER_REPLY_AUTO_ENABLED: "true" }).enabled,
    ).toBe(false);
    expect(
      resolveReminderReplyAutoConfig({ ADMINBOT_REMINDER_REPLY_AUTO_ENABLED: "1" }).enabled,
    ).toBe(true);
  });
});

describe("isUndoReply", () => {
  it("reads only the member's own first line", () => {
    expect(isUndoReply("Undo please\n\nOn Mon, AdminBot wrote:\n> Thanks")).toBe(true);
    expect(isUndoReply("\n  undo - wrong paper")).toBe(true);
    expect(isUndoReply("Please don't undo the camera-ready")).toBe(false);
    expect(isUndoReply('> Reply "undo" if that\'s wrong')).toBe(false);
    expect(isUndoReply("On Mon, AdminBot wrote:\n> undo")).toBe(false);
    expect(isUndoReply(`undo ${"x".repeat(100)}`)).toBe(false);
  });
});

describe("canAutoApplyReminderReply", () => {
  const skipped = { kind: "paperflow_skipped" } as never;
  it("holds a question, a shaky read or a dismissal for a person", () => {
    expect(canAutoApplyReminderReply(reading(), skipped)).toBe(true);
    expect(canAutoApplyReminderReply(reading({ confidence: 0.6 }), skipped)).toBe(false);
    expect(canAutoApplyReminderReply(reading({ intent: "question" }), skipped)).toBe(false);
    expect(canAutoApplyReminderReply(reading(), { kind: "dismissed" } as never)).toBe(false);
  });
});

describe("reminderReplyConfirmationBody", () => {
  it("says what changed, in the member's reason, and how to undo it", () => {
    const body = reminderReplyConfirmationBody({
      memberName: "Xuanqiang Huang",
      label: "the camera-ready",
      resolution: { kind: "paperflow_skipped", note: "moved to a Springer journal" } as never,
    });
    expect(body).toMatch(/^Hi Xuanqiang,/u);
    expect(body).toContain("marked the camera-ready as skipped");
    expect(body).toContain("moved to a Springer journal");
    expect(body).toContain('Reply "undo" if that\'s wrong');
  });
});

describe("autoApplyReminderReply", () => {
  it("closes the stage as the member's reply and mails one receipt from the bot", async () => {
    const { service, store, mail } = await nudged();
    const plan = unwrap(service.planReminderReply(reply()));
    expect(plan).toMatchObject({ mode: "apply", member_id: "xq" });

    const result = unwrap(await service.autoApplyReminderReply(reply()));
    expect(result).toMatchObject({ mode: "applied", outcome: "applied" });

    const evidence = store.listPaperflowEvidence("p1");
    expect(evidence.map((row) => row.stage).sort()).toEqual(["camera_ready", "conference"]);
    for (const row of evidence) {
      expect(row).toMatchObject({ recorded_by: "reply", message_id: "reply-1" });
    }
    expect(unwrap(service.collectPaperflowStageNudges()).items).toEqual([]);
    expect(unwrap(service.listEmailReviews()).reviews).toEqual([]);
    expect(unwrap(service.listPending()).proposals).toEqual([]);

    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({
      message_id: "reply-1",
      to: "xq@ethz.example",
      account: "bot@example.org",
    });
    expect(mail[0]?.body).toContain('Reply "undo"');
  });

  it("does not apply or mail the same reply twice", async () => {
    const { service, mail } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));
    const again = unwrap(await service.autoApplyReminderReply(reply()));
    expect(again.mode).not.toBe("applied");
    expect(mail).toHaveLength(1);
  });

  it("puts a question or a low-confidence read to an admin with no receipt", async () => {
    for (const overrides of [{ intent: "question" as const }, { confidence: 0.55 }]) {
      const { service, store, mail } = await nudged();
      const result = unwrap(await service.autoApplyReminderReply(reply(overrides)));
      expect(result.mode).toBe("proposed");
      expect(store.listPaperflowEvidence("p1")).toEqual([]);
      expect(mail).toEqual([]);
      expect(unwrap(service.listEmailReviews()).reviews).toHaveLength(1);
    }
  });

  it("ignores a reply from somebody who was not nudged", async () => {
    const { service } = await nudged();
    expect(
      await service.autoApplyReminderReply({ ...reply(), sender: "someone@else.example" }),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("undo by email", () => {
  it("reopens what the reply closed, back to review, and says so", async () => {
    const { service, store, mail } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));

    expect(
      service.findUndoableReminderReply({ threadId: "thread-1", sender: "x@y.example" }),
    ).toBeUndefined();
    expect(
      service.findUndoableReminderReply({ threadId: "thread-1", sender: "XQ@ethz.example" }),
    ).toBeDefined();

    unwrap(
      await service.undoReminderReplyFromEmail({
        threadId: "thread-1",
        sender: "xq@ethz.example",
        messageId: "undo-1",
        account: "bot@example.org",
      }),
    );
    expect(store.listPaperflowEvidence("p1")).toEqual([]);
    expect(unwrap(service.collectPaperflowStageNudges()).items[0]?.stage).toBe("camera_ready");
    expect(unwrap(service.listEmailReviews()).reviews).toHaveLength(1);
    expect(mail).toHaveLength(2);
    expect(mail[1]).toMatchObject({ message_id: "undo-1", to: "xq@ethz.example" });
    expect(mail[1]?.body).toContain("undone");

    // Nothing left of theirs to undo on that thread.
    expect(
      service.findUndoableReminderReply({ threadId: "thread-1", sender: "xq@ethz.example" }),
    ).toBeUndefined();
  });

  it("leaves a stage alone that an admin recorded after the reply", async () => {
    const { service, store } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));
    // An admin re-records the conference by hand: the undo must not take their row with it.
    store.deletePaperflowEvidence("p1", "conference");
    unwrap(
      service.recordPaperflowEvidence({
        paperId: "p1",
        stage: "conference",
        recordedBy: "admin",
        actor: "zhijing",
      }),
    );
    unwrap(
      await service.undoReminderReplyFromEmail({
        threadId: "thread-1",
        sender: "xq@ethz.example",
        messageId: "undo-1",
      }),
    );
    expect(store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "conference", recorded_by: "admin" }),
    ]);
  });
});
