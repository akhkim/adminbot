// The venue-cycle stage sweep at the service boundary: who gets mailed, how often, and what a
// bcc actually closes.
//
// Its own file rather than more of service.paper-slots.test.ts: the slot sweep and this one share
// a ledger and nothing else -- different channel, different cadence, different way of being
// answered.
import { describe, expect, it } from "vitest";
import { AdminBotService } from "./service.js";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

/** A nudge only counts as sent when a connector handled it, so the send tests need one. */
function service(overrides: { botEmail?: string; priority?: string } = {}): AdminBotService {
  return new AdminBotService(undefined, {
    paperflowBotEmail: overrides.botEmail ?? "adminbot@example.org",
    ...(overrides.priority ? { paperflowPriorityMemberId: overrides.priority } : {}),
    executor: {
      execute: async (proposal) => ({ handled: proposal.type === "member_nudge.send" }),
    },
  });
}

function seed(target: AdminBotService): void {
  unwrap(
    target.upsertLabMember({
      id: "max",
      name: "Maximilian Mordig",
      privilege_level: "external_collaborator",
      email: "max@example.org",
    } as never),
  );
  unwrap(
    target.upsertLabMember({
      id: "rahul",
      name: "Rahul Babu Shrestha",
      privilege_level: "member",
      email: "rahul@cs.toronto.edu",
    } as never),
  );
  unwrap(
    target.upsertPaper({
      id: "p1",
      title: "Causal Data Agent",
      authors: ["Maximilian Mordig", "Rahul Babu Shrestha"],
      current_step: "submission",
    }),
  );
  // The whole ladder is gated on the paper being in front of a venue.
  unwrap(
    target.setPaperSlot({
      paperId: "p1",
      slot: "submission",
      input: { url: "https://openreview.net/forum?id=x" },
      memberId: "rahul",
      privileged: true,
    }),
  );
}

describe("collectPaperflowStageNudges", () => {
  it("routes past the external first author to the first full member", () => {
    const target = service();
    seed(target);
    const { items } = unwrap(target.collectPaperflowStageNudges());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      paper_id: "p1",
      stage: "reviews_out",
      recipient_member_id: "rahul",
      recipient_author_index: 1,
      due: true,
      nudge_count: 0,
    });
  });

  it("reports a paper nobody in the lab is on rather than dropping it", () => {
    const target = service();
    seed(target);
    unwrap(
      target.upsertPaper({
        id: "p2",
        title: "Outside Collaboration",
        authors: ["Maximilian Mordig"],
        current_step: "submission",
      }),
    );
    unwrap(
      target.setPaperSlot({
        paperId: "p2",
        slot: "submission",
        input: { url: "https://openreview.net/forum?id=y" },
        memberId: "rahul",
        privileged: true,
      }),
    );
    const { items } = unwrap(target.collectPaperflowStageNudges());
    const orphan = items.find((item) => item.paper_id === "p2");
    // Dropping it would make it indistinguishable from a paper with nothing outstanding, which is
    // exactly the paper somebody needs to look at.
    expect(orphan?.recipient_member_id).toBeUndefined();
    expect(orphan?.unroutable_reason).toBe("no full member on the author list");
  });
});

describe("sendPaperflowStageNudges", () => {
  it("emails the holder and stamps the ledger", async () => {
    const target = service();
    seed(target);
    const result = unwrap(await target.sendPaperflowStageNudges("cron"));
    expect(result.created).toHaveLength(1);
    expect(result.unroutable).toEqual([]);
    const ledger = target.listNudgeLedgerForTest("paperflow_stage");
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      subject_id: "p1:reviews_out",
      member_id: "rahul",
      nudge_count: 1,
    });
  });

  it("does not ask again on the next run: the cadence is a property of the product", async () => {
    const target = service();
    seed(target);
    unwrap(await target.sendPaperflowStageNudges("cron"));
    const second = unwrap(await target.sendPaperflowStageNudges("cron"));
    // A misconfigured crontab, a manual run, or two hosts running the same job must not turn a
    // weekly question into a daily nag.
    expect(second.created).toHaveLength(0);
  });

  it("refuses to send at all without a bot mailbox to name", async () => {
    const target = service({ botEmail: "" });
    seed(target);
    const result = await target.sendPaperflowStageNudges("cron");
    // A nudge whose whole payload is "bcc us at" is worse than silence without an address.
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("honours the configured priority member over author order", async () => {
    const target = service({ priority: "rahul" });
    seed(target);
    unwrap(
      target.upsertLabMember({
        id: "ada",
        name: "Ada Lovelace",
        privilege_level: "member",
        email: "ada@cs.toronto.edu",
      } as never),
    );
    unwrap(
      target.upsertPaper({
        id: "p3",
        title: "Second Paper",
        authors: ["Ada Lovelace", "Rahul Babu Shrestha"],
        current_step: "submission",
      }),
    );
    unwrap(
      target.setPaperSlot({
        paperId: "p3",
        slot: "submission",
        input: { url: "https://openreview.net/forum?id=z" },
        memberId: "rahul",
        privileged: true,
      }),
    );
    const { items } = unwrap(target.collectPaperflowStageNudges());
    const second = items.find((item) => item.paper_id === "p3");
    expect(second).toMatchObject({ recipient_member_id: "rahul", prioritized: true });
  });
});

describe("recordPaperflowEvidence", () => {
  it("closes the stage and moves the paper on to the next question", () => {
    const target = service();
    seed(target);
    unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        messageId: "m1",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    const { items } = unwrap(target.collectPaperflowStageNudges());
    expect(items[0]?.stage).toBe("rebuttal");
  });

  it("stops the chase: an evidenced stage is never nudged again", async () => {
    const target = service();
    seed(target);
    unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    unwrap(await target.sendPaperflowStageNudges("cron"));
    // Nothing at all this week -- not even about the rebuttal window the paper has just moved on
    // to. The author answered today; the cadence is the paper's, not the rung's.
    expect(target.listNudgeLedgerForTest("paperflow_stage")).toEqual([]);
  });

  // The complaint this came from: an author bcc'd the reviews, the stage closed, and the next
  // morning's sweep mailed them about the rebuttal window on the same paper. Answering has to buy
  // the same quiet that being asked does, or the reward for replying is another email.
  it("does not ask the next question in the same week the answer arrived", () => {
    const target = service();
    seed(target);
    unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    const { items } = unwrap(target.collectPaperflowStageNudges());
    expect(items[0]?.stage).toBe("rebuttal");
    expect(items[0]?.due).toBe(false);
  });

  it("asks it once the paper has been quiet for the usual interval", () => {
    const target = service();
    seed(target);
    unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    const inEightDays = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString();
    const { items } = unwrap(target.collectPaperflowStageNudges(inEightDays));
    expect(items[0]?.stage).toBe("rebuttal");
    expect(items[0]?.due).toBe(true);
  });

  it("refuses a low-confidence match rather than closing a stage nobody has seen", () => {
    const target = service();
    seed(target);
    const result = target.recordPaperflowEvidence({
      paperId: "p1",
      stage: "decision",
      confidence: 0.5,
      actor: "email_automation",
    });
    // A false close is silent by construction: the failure is a message that never gets sent.
    expect(result).toMatchObject({ ok: false, status: 422 });
  });

  it("lets an admin close a stage by hand without meeting the classifier's floor", () => {
    const target = service();
    seed(target);
    const payload = unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        recordedBy: "admin",
        actor: "zhijing",
      }),
    );
    expect(payload.recorded).toBe(true);
  });

  it("is idempotent: a forwarded thread is not a second decision", () => {
    const target = service();
    seed(target);
    unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        messageId: "first",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    const again = unwrap(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews_out",
        messageId: "second",
        confidence: 0.95,
        actor: "email_automation",
      }),
    );
    expect(again.recorded).toBe(false);
    expect(again.record.message_id).toBe("first");
  });

  it("404s on a paper that does not exist", () => {
    expect(
      service().recordPaperflowEvidence({
        paperId: "nope",
        stage: "decision",
        confidence: 1,
        actor: "email_automation",
      }),
    ).toMatchObject({ ok: false, status: 404 });
  });

  it("rejects a stage name that is not one of the five", () => {
    const target = service();
    seed(target);
    expect(
      target.recordPaperflowEvidence({
        paperId: "p1",
        stage: "reviews",
        confidence: 1,
        actor: "email_automation",
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});
