// A member answering one of AdminBot's own reminders: matched to the send, put to an admin as one
// approval, and applied only once they approve it.
//
// Its own file rather than more of service.paperflow-stages.test.ts: the stage sweep asks, this
// file is about what happens to the answer -- and the answer can be to a stage nudge, a slot nudge
// or a rec-letter reminder, which share nothing else.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminBotReminderReplyReading } from "../contracts/email-review.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";
import {
  normalizeReminderSubject,
  parseEmailReviewResolution,
  reminderReplyResolution,
} from "./service.reminder-replies.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const PAPER_TITLE = "Multi-Agent AI Systems Need Institutional Design";

/** Gmail hands back the thread of every send; the tests use it the way gog's JSON output does. */
function lab() {
  const store = new AdminBotMemoryStore();
  let sends = 0;
  const service = new AdminBotService(store, {
    paperflowBotEmail: "adminbot@example.org",
    executor: {
      execute: async (proposal) => {
        if (
          proposal.type !== "member_nudge.send" &&
          proposal.type !== "logistics.rec_letter_reminder"
        ) {
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
      correspondence_email: "xq.personal@example.org",
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
  return { store, service };
}

/** The camera-ready nudge, sent the way the hourly sweep sends it. */
async function nudged() {
  const fixture = lab();
  const result = unwrap(await fixture.service.sendPaperflowStageNudges("cron"));
  expect(result.created).toHaveLength(1);
  const [ledger] = fixture.service.listNudgeLedgerForTest("paperflow_stage");
  expect(ledger?.subject_id).toBe("p1:camera_ready");
  return fixture;
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

async function approveAndExecute(service: AdminBotService, actionId: string) {
  const proposal = unwrap(service.listPending()).proposals.find((row) => row.id === actionId);
  if (!proposal) {
    throw new Error("proposal is not pending");
  }
  unwrap(
    await service.approve(actionId, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "andrew",
    }),
  );
  return service.execute(actionId, { dry_run: false });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("matchReminderReply", () => {
  it("ties a reply to its reminder by the Gmail thread", async () => {
    const { service } = await nudged();
    const match = service.matchReminderReply({ sender: "xq@ethz.example", threadId: "thread-1" });
    expect(match).toMatchObject({ member_id: "xq", matched_by: "thread" });
    expect(match?.targets).toEqual([
      expect.objectContaining({
        domain: "paperflow_stage",
        subject_id: "p1:camera_ready",
        stage: "camera_ready",
        open: true,
      }),
    ]);
  });

  it("falls back to the subject, from any address the member is known by", async () => {
    const { service } = await nudged();
    const match = service.matchReminderReply({
      sender: "XQ.Personal@example.org",
      subject: `Re: RE: Camera ready: ${PAPER_TITLE}`,
      threadId: "some-thread-sent-before-ids-were-kept",
    });
    expect(match?.matched_by).toBe("subject");
  });

  it("ignores somebody else replying on the thread", async () => {
    const { service } = await nudged();
    // A co-author or a forward: not the person who was asked, so not theirs to close.
    expect(
      service.matchReminderReply({ sender: "stranger@example.org", threadId: "thread-1" }),
    ).toBeUndefined();
    expect(
      service.matchReminderReply({
        sender: "stranger@example.org",
        subject: `Re: Camera ready: ${PAPER_TITLE}`,
      }),
    ).toBeUndefined();
  });
});

describe("proposeReminderReply", () => {
  it("files the reply and asks an admin, without closing or snoozing anything", async () => {
    const { service } = await nudged();
    const proposed = unwrap(
      service.proposeReminderReply({
        messageId: "reply-1",
        threadId: "thread-1",
        sender: "xq@ethz.example",
        subject: `Re: Camera ready: ${PAPER_TITLE}`,
        reading: reading(),
        actor: "adminbot-email-automation",
      }),
    );
    expect(proposed).toMatchObject({
      already_proposed: false,
      resolution: "paperflow_skipped",
      snooze_on_approval: ["paperflow_stage|p1:camera_ready|xq"],
    });

    const [proposal] = unwrap(service.listPending()).proposals;
    expect(proposal).toMatchObject({ type: "email_review.resolve", status: "pending" });
    expect(proposal?.summary).toContain("Close camera_ready as skipped with every later stage");
    expect(proposal?.summary).toContain("moved to a Springer journal");

    // The nudge keeps going until an admin approves; a rejection must leave it as it was.
    const [ledger] = service.listNudgeLedgerForTest("paperflow_stage");
    expect(ledger?.snoozed_until).toBeUndefined();
    // Still open: the stage has not been touched until somebody approves.
    const { items } = unwrap(service.collectPaperflowStageNudges());
    expect(items[0]?.stage).toBe("camera_ready");
    expect(unwrap(service.listEmailReviews()).reviews[0]).toMatchObject({
      message_id: "reply-1",
      category: "reminder_reply",
    });
  });

  it("does not propose the same reply twice, nor does the hourly review pass", async () => {
    const { service } = await nudged();
    const params = {
      messageId: "reply-1",
      threadId: "thread-1",
      sender: "xq@ethz.example",
      reading: reading(),
      actor: "adminbot-email-automation",
    };
    unwrap(service.proposeReminderReply(params));
    expect(unwrap(service.proposeReminderReply(params)).already_proposed).toBe(true);
    expect(unwrap(service.proposeEmailReviewResolutions("sweep")).proposed).toEqual([]);
    expect(unwrap(service.listPending()).proposals).toHaveLength(1);
  });

  it("404s on mail that answers no reminder", async () => {
    const { service } = await nudged();
    expect(
      service.proposeReminderReply({
        messageId: "reply-1",
        threadId: "unrelated",
        sender: "xq@ethz.example",
        subject: "Lunch?",
        reading: reading(),
        actor: "adminbot-email-automation",
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("approving a reminder reply", () => {
  it("closes camera_ready and the conference as admin-recorded, and stops the chase", async () => {
    const { service, store } = await nudged();
    const { proposal_id } = unwrap(
      service.proposeReminderReply({
        messageId: "reply-1",
        threadId: "thread-1",
        sender: "xq@ethz.example",
        reading: reading(),
        actor: "adminbot-email-automation",
      }),
    );
    const executed = await approveAndExecute(service, proposal_id!);
    expect(unwrap(executed).status).toBe("executed");

    const evidence = store.listPaperflowEvidence("p1");
    expect(evidence.map((row) => row.stage).sort()).toEqual(["camera_ready", "conference"]);
    for (const row of evidence) {
      expect(row).toMatchObject({ recorded_by: "admin", message_id: "reply-1" });
      expect(row.note).toContain("skipped: moved to a Springer journal");
    }
    // Nothing left to ask about this paper -- including the conference the workshop already held.
    expect(unwrap(service.collectPaperflowStageNudges()).items).toEqual([]);
    expect(unwrap(service.listEmailReviews()).reviews).toEqual([]);
  });

  it("records done with the member's link as the note", async () => {
    const { service, store } = await nudged();
    const { proposal_id } = unwrap(
      service.proposeReminderReply({
        messageId: "reply-1",
        threadId: "thread-1",
        sender: "xq@ethz.example",
        reading: reading({
          intent: "done",
          note: "camera ready uploaded",
          evidence_url: "https://openreview.net/pdf?id=x",
          moved_elsewhere: false,
        }),
        actor: "adminbot-email-automation",
      }),
    );
    unwrap(await approveAndExecute(service, proposal_id!));
    const [row] = store.listPaperflowEvidence("p1");
    expect(row).toMatchObject({ stage: "camera_ready", recorded_by: "admin" });
    expect(row?.note).toContain("https://openreview.net/pdf?id=x");
    // Only the one stage: the conference is still a real question for a paper that stayed put.
    expect(unwrap(service.collectPaperflowStageNudges()).items[0]?.stage).toBe("conference");
  });

  it("fails closed when the stage was closed some other way first", async () => {
    const { service } = await nudged();
    const { proposal_id } = unwrap(
      service.proposeReminderReply({
        messageId: "reply-1",
        threadId: "thread-1",
        sender: "xq@ethz.example",
        reading: reading(),
        actor: "adminbot-email-automation",
      }),
    );
    unwrap(
      service.recordPaperflowEvidence({
        paperId: "p1",
        stage: "camera_ready",
        recordedBy: "admin",
        actor: "zhijing",
      }),
    );
    const executed = await approveAndExecute(service, proposal_id!);
    expect(executed.ok).toBe(false);
  });
});

describe("conference stage", () => {
  it("does not open for a paper accepted in a year that is already over", async () => {
    const { service, store } = lab();
    unwrap(
      service.upsertPaper({
        id: "p1",
        title: PAPER_TITLE,
        authors: ["Xuanqiang Huang"],
        current_step: "submission",
        venue_decision: "accept",
        accepted_year: new Date().getUTCFullYear() - 1,
      } as never),
    );
    unwrap(
      service.recordPaperflowEvidence({
        paperId: "p1",
        stage: "camera_ready",
        recordedBy: "admin",
        actor: "zhijing",
      }),
    );
    expect(store.listPaperflowEvidence("p1")).toHaveLength(1);
    expect(unwrap(service.collectPaperflowStageNudges()).items).toEqual([]);
  });
});

describe("rec-letter reminder replies", () => {
  it("marks the schools submitted when the head professor says the letter is in", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-28T13:00:00Z"));
    const { service, store } = lab();
    unwrap(
      service.upsertLabMember({
        id: "zhijing",
        name: "Zhijing Jin",
        privilege_level: "admin",
        email: "pi@example.org",
      }),
    );
    unwrap(service.updateSettings({ head_professor_member_id: "zhijing" } as never));
    const request = unwrap(
      service.submitLogisticsRequest("xq", {
        kind: "recommendation_letters",
        schools: [{ school: "MIT", letter_deadline: "2026-12-01" }],
        facts: [{ project: "AdminBot", contribution: "wrote the approval gate" }],
      }),
    );
    unwrap(await service.sweepRecLetterReminders("cron"));

    const match = service.matchReminderReply({
      sender: "pi@example.org",
      subject: "Re: Recommendation letter for Xuanqiang Huang is due in 3 days",
    });
    expect(match?.targets).toEqual([
      expect.objectContaining({
        domain: "rec_letter_reminder",
        request_id: request.id,
        schools: ["MIT"],
        open: true,
      }),
    ]);

    const { proposal_id, resolution } = unwrap(
      service.proposeReminderReply({
        messageId: "reply-pi",
        threadId: "thread-1",
        sender: "pi@example.org",
        reading: reading({ intent: "done", note: "sent it", moved_elsewhere: false }),
        actor: "adminbot-email-automation",
      }),
    );
    expect(resolution).toBe("rec_letter_submitted");
    unwrap(await approveAndExecute(service, proposal_id!));
    const stored = store.getLogisticsRequest(request.id);
    expect(stored?.schools?.[0]?.letter_status).toBe("submitted");
  });
});

describe("reminderReplyResolution", () => {
  const now = new Date("2026-11-21T12:00:00Z");
  const match = (targets: unknown[]) =>
    ({
      reminder_action_id: "act-1",
      reminder_type: "member_nudge.send",
      reminder_subject: "s",
      reminder_body: "b",
      reminder_sent_at: now.toISOString(),
      member_id: "xq",
      member_name: "Xuanqiang Huang",
      matched_by: "thread",
      targets,
    }) as never;
  const stage = {
    domain: "paperflow_stage",
    subject_id: "p1:camera_ready",
    member_id: "xq",
    label: "Camera ready",
    open: true,
    paper_id: "p1",
    stage: "camera_ready",
  };
  const slot = {
    domain: "paper_slot",
    subject_id: "p1:poster",
    member_id: "xq",
    label: "Poster",
    open: true,
    paper_id: "p1",
    slot: "poster",
  };

  it("leaves a question, a shaky read or an ambiguous reminder for a person", () => {
    expect(
      reminderReplyResolution(match([stage]), reading({ intent: "question" }), now).resolution,
    ).toEqual({ kind: "dismissed" });
    expect(
      reminderReplyResolution(match([stage]), reading({ confidence: 0.4 }), now).resolution,
    ).toEqual({ kind: "dismissed" });
    expect(
      reminderReplyResolution(
        match([stage, { ...stage, subject_id: "p2:decision" }]),
        reading(),
        now,
      ).resolution,
    ).toEqual({ kind: "dismissed" });
    expect(
      reminderReplyResolution(match([{ ...stage, open: false }]), reading(), now).resolution,
    ).toEqual({ kind: "dismissed" });
  });

  it("snoozes needs_time no further than the cap", () => {
    const { resolution } = reminderReplyResolution(
      match([stage]),
      reading({ intent: "needs_time", until: "2027-06-01", moved_elsewhere: false }),
      now,
    );
    expect(resolution).toMatchObject({ kind: "reminder_snoozed", domain: "paperflow_stage" });
    const until = (resolution as { until: string }).until;
    expect(Date.parse(until) - now.getTime()).toBeLessThanOrEqual(14 * 24 * 60 * 60 * 1000);
  });

  it("waives a paper slot the member says does not apply", () => {
    expect(
      reminderReplyResolution(match([slot]), reading({ moved_elsewhere: false }), now).resolution,
    ).toMatchObject({ kind: "paper_slot_waived", paper_id: "p1", slot: "poster" });
  });
});

describe("parseEmailReviewResolution", () => {
  it("reads back every kind it writes and refuses anything else", () => {
    for (const resolution of [
      { kind: "dismissed" },
      { kind: "paperflow_evidence", paper_id: "p1", stage: "decision" },
      {
        kind: "paperflow_skipped",
        paper_id: "p1",
        stage: "camera_ready",
        note: "n",
        later_stages: true,
      },
      { kind: "paper_slot_waived", paper_id: "p1", slot: "poster", note: "n" },
      { kind: "rec_letter_submitted", request_id: "r1", schools: ["MIT"] },
      {
        kind: "reminder_snoozed",
        domain: "paperflow_stage",
        subject_id: "p1:decision",
        member_id: "xq",
        until: "2026-12-01T00:00:00.000Z",
      },
    ]) {
      expect(parseEmailReviewResolution(resolution)).toMatchObject(resolution);
    }
    expect(parseEmailReviewResolution({ kind: "attach-everything" })).toBeUndefined();
    expect(
      parseEmailReviewResolution({ kind: "paperflow_skipped", paper_id: "p1" }),
    ).toBeUndefined();
  });
});

describe("normalizeReminderSubject", () => {
  it("strips reply and forward prefixes in the languages members write in", () => {
    expect(normalizeReminderSubject("AW: Re: WG: Camera ready: X")).toBe("camera ready: x");
  });
});
