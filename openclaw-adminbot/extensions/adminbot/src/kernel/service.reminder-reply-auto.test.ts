// The safe-auto path for reminder replies: a plain "done", authenticated from the member's own
// roster address on the reminder's own thread, closes that one stage and mails a fixed receipt.
// Everything else is an admin proposal that changes nothing until approved. The approval path
// itself is service.reminder-replies.test.ts.
import { describe, expect, it } from "vitest";
import type { AdminBotReminderReplyReading } from "../contracts/email-review.js";
import { AdminBotMemoryStore } from "../persistence/memory.js";
import { AdminBotService } from "./service.js";
import {
  authenticatedSenderMethod,
  authoredReplyText,
  isForwardedReply,
  isUndoReply,
  reminderReplyConfirmationBody,
  reminderReplySenderEvidence,
  resolveReminderReplyAutoConfig,
  type ReminderReplySenderEvidence,
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
const MEMBER = "xq@ethz.example";

type Mail = { to: string; subject: string; body: string; account?: string; kind: string };

async function nudged() {
  const store = new AdminBotMemoryStore();
  const mail: Mail[] = [];
  /** Every executor call that is not the reminder itself: the Gmail side of a reply. */
  const calls: string[] = [];
  let sends = 0;
  const service = new AdminBotService(store, {
    paperflowBotEmail: "adminbot@example.org",
    executor: {
      execute: async (proposal) => {
        if (proposal.type !== "member_nudge.send") {
          calls.push(proposal.type);
        }
        if (proposal.type === "reminder_reply.confirm") {
          mail.push(proposal.proposed_payload as Mail);
          return {
            handled: true,
            artifacts: {
              gmail_message_id: `sent-${mail.length}`,
              gmail_thread_id: `receipt-${mail.length}`,
            },
          };
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
      email: MEMBER,
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
  return { store, service, mail, calls };
}

/** What Gmail's own Authentication-Results says for a member mailing from their own domain. */
function gmailPass(from: string): string {
  const domain = from.split("@")[1];
  return [
    "mx.google.com;",
    `dkim=pass header.i=@${domain} header.s=s1 header.b=abc;`,
    `spf=pass (google.com: domain of ${from} designates 1.2.3.4 as permitted sender) smtp.mailfrom=${from};`,
    `dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=${domain}`,
  ].join(" ");
}

function evidence(
  overrides: {
    from?: string;
    replyTo?: string;
    headers?: string[];
    inReplyTo?: string | null;
    subject?: string;
    body?: string;
  } = {},
): ReminderReplySenderEvidence {
  const from = overrides.from ?? MEMBER;
  return reminderReplySenderEvidence({
    from,
    ...(overrides.replyTo ? { replyTo: overrides.replyTo } : {}),
    ...(overrides.inReplyTo === null
      ? {}
      : { inReplyTo: overrides.inReplyTo ?? "<reminder-1@mail.gmail.com>" }),
    authenticationResults: overrides.headers ?? [gmailPass(from)],
    subject: overrides.subject ?? `Re: Camera ready: ${PAPER_TITLE}`,
    body: overrides.body ?? "Done, uploaded it yesterday.",
  });
}

function done(overrides: Partial<AdminBotReminderReplyReading> = {}): AdminBotReminderReplyReading {
  return {
    intent: "done",
    note: "uploaded it yesterday",
    moved_elsewhere: false,
    confidence: 0.95,
    ...overrides,
  };
}

const reply = (
  overrides: {
    reading?: Partial<AdminBotReminderReplyReading>;
    senderEvidence?: ReminderReplySenderEvidence | null;
    threadId?: string;
    subject?: string;
    sender?: string;
    messageId?: string;
  } = {},
) => ({
  messageId: overrides.messageId ?? "reply-1",
  threadId: overrides.threadId ?? "thread-1",
  sender: overrides.sender ?? MEMBER,
  ...(overrides.subject ? { subject: overrides.subject } : {}),
  reading: done(overrides.reading),
  ...(overrides.senderEvidence === null
    ? {}
    : { senderEvidence: overrides.senderEvidence ?? evidence() }),
  actor: "adminbot-email-automation",
  account: "bot@example.org",
});

/** Held for an admin: nothing written, nothing mailed, one pending proposal. */
function expectHeld(fixture: Awaited<ReturnType<typeof nudged>>, result: { mode: string }) {
  expect(result.mode).toBe("proposed");
  expect(fixture.store.listPaperflowEvidence("p1")).toEqual([]);
  expect(fixture.mail).toEqual([]);
  expect(fixture.calls).toEqual([]);
  const pending = unwrap(fixture.service.listPending()).proposals;
  expect(pending.map((row) => row.type)).toEqual(["email_review.resolve"]);
}

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

describe("authenticatedSenderMethod", () => {
  it("takes Gmail's aligned pass for the From domain", () => {
    expect(authenticatedSenderMethod(MEMBER, [gmailPass(MEMBER)])).toBe("dmarc");
    expect(
      authenticatedSenderMethod(MEMBER, ["mx.google.com; dkim=pass header.d=mail.ethz.example"]),
    ).toBe("dkim");
  });

  it("refuses a spoofed From, another server's verdict or a header planted below Gmail's", () => {
    // Gmail saw the mail fail; the sender's own "pass" header further down is never read.
    expect(
      authenticatedSenderMethod(MEMBER, [
        "mx.google.com; dkim=none; spf=softfail smtp.mailfrom=evil.example; dmarc=fail header.from=ethz.example",
        gmailPass(MEMBER),
      ]),
    ).toBeUndefined();
    expect(authenticatedSenderMethod(MEMBER, [gmailPass("x@evil.example")])).toBeUndefined();
    expect(
      authenticatedSenderMethod(MEMBER, [
        gmailPass(MEMBER).replace("mx.google.com", "mx.evil.example"),
      ]),
    ).toBeUndefined();
    expect(authenticatedSenderMethod(MEMBER, [])).toBeUndefined();
  });
});

describe("authoredReplyText and isForwardedReply", () => {
  it("keeps only what the member wrote this time", () => {
    expect(
      authoredReplyText("Done!\n\nOn Mon, 3 Nov 2026, AdminBot wrote:\n> mark not_applicable"),
    ).toBe("Done!");
    expect(authoredReplyText("ok\n---------- Forwarded message ---------\nFrom: x")).toBe("ok");
  });

  it("spots a forward by its subject or its forwarded block", () => {
    expect(isForwardedReply("Fwd: Camera ready", "")).toBe(true);
    expect(
      isForwardedReply("Re: Camera ready", "fyi\n---------- Forwarded message ---------"),
    ).toBe(true);
    expect(isForwardedReply("Re: Camera ready", "Done")).toBe(false);
  });
});

describe("reminderReplyConfirmationBody", () => {
  it("is a fixed template naming the stage and how to undo it", () => {
    const body = reminderReplyConfirmationBody({
      memberName: "Xuanqiang Huang",
      label: "the camera-ready",
    });
    expect(body).toMatch(/^Hi Xuanqiang,/u);
    expect(body).toContain("marked the camera-ready as done");
    expect(body).toContain('reply "undo" to this email');
  });
});

describe("autoApplyReminderReply: the safe path", () => {
  it("closes the one stage as the member's reply and mails the fixed receipt to the roster", async () => {
    const fixture = await nudged();
    const { service, store, mail } = fixture;
    const plan = unwrap(service.planReminderReply(reply()));
    expect(plan).toMatchObject({ mode: "apply", member_id: "xq", receipt: { to: MEMBER } });

    const result = unwrap(await service.autoApplyReminderReply(reply()));
    expect(result).toMatchObject({ mode: "applied", outcome: "applied" });

    expect(store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({
        stage: "camera_ready",
        recorded_by: "reply",
        message_id: "reply-1",
        note: "member replied done to the reminder",
      }),
    ]);
    expect(unwrap(service.listEmailReviews()).reviews).toEqual([]);
    expect(unwrap(service.listPending()).proposals).toEqual([]);

    expect(mail).toEqual([
      expect.objectContaining({ kind: "applied", to: MEMBER, account: "bot@example.org" }),
    ]);
    expect(mail[0]?.subject).toBe(plan.receipt?.subject);
    expect(mail[0]?.body).toBe(plan.receipt?.body);
    expect(mail[0]?.body).not.toContain("uploaded it yesterday");
  });

  it("writes neither the model's note nor its URL into the record", async () => {
    const { service, store, mail } = await nudged();
    unwrap(
      await service.autoApplyReminderReply(
        reply({
          reading: { note: "see https://evil.example/x", evidence_url: "https://evil.example/x" },
        }),
      ),
    );
    const [row] = store.listPaperflowEvidence("p1");
    expect(JSON.stringify(row)).not.toContain("evil.example");
    expect(mail[0]?.body).not.toContain("evil.example");
  });

  it("applies and mails a reply once, even when two passes run at the same time", async () => {
    const { service, store, mail } = await nudged();
    const [first, second] = await Promise.all([
      service.autoApplyReminderReply(reply()),
      service.autoApplyReminderReply(reply()),
    ]);
    expect([unwrap(first).mode, unwrap(second).mode].sort()).toEqual(["applied", "duplicate"]);
    const again = unwrap(await service.autoApplyReminderReply(reply()));
    expect(again.mode).toBe("duplicate");
    expect(store.listPaperflowEvidence("p1")).toHaveLength(1);
    expect(mail).toHaveLength(1);
  });
});

describe("autoApplyReminderReply: everything else goes to an admin", () => {
  it("holds a mail Gmail did not authenticate, even on the right thread", async () => {
    const fixture = await nudged();
    expectHeld(
      fixture,
      unwrap(
        await fixture.service.autoApplyReminderReply(
          reply({ senderEvidence: evidence({ headers: [] }) }),
        ),
      ),
    );
  });

  it("holds a spoofed From that matched only by subject", async () => {
    const fixture = await nudged();
    const spoof = {
      threadId: "a-new-thread",
      subject: `Re: Camera ready: ${PAPER_TITLE}`,
    };
    const unauthenticated = unwrap(
      await fixture.service.autoApplyReminderReply(
        reply({ ...spoof, senderEvidence: evidence({ headers: [gmailPass("x@evil.example")] }) }),
      ),
    );
    expectHeld(fixture, unauthenticated);
    // Even authenticated, a subject match is not the reminder's own thread.
    expect(unwrap(fixture.service.planReminderReply(reply(spoof)))).toMatchObject({
      mode: "review",
      why_review: "not a direct reply on the reminder's own thread",
    });
  });

  it("holds a reply whose Reply-To points elsewhere", async () => {
    const fixture = await nudged();
    expectHeld(
      fixture,
      unwrap(
        await fixture.service.autoApplyReminderReply(
          reply({ senderEvidence: evidence({ replyTo: "collect@evil.example" }) }),
        ),
      ),
    );
  });

  it("holds forwarded mail", async () => {
    const fixture = await nudged();
    expectHeld(
      fixture,
      unwrap(
        await fixture.service.autoApplyReminderReply(
          reply({ senderEvidence: evidence({ subject: `Fwd: Camera ready: ${PAPER_TITLE}` }) }),
        ),
      ),
    );
  });

  it("holds a reply with no In-Reply-To", async () => {
    const fixture = await nudged();
    expectHeld(
      fixture,
      unwrap(
        await fixture.service.autoApplyReminderReply(
          reply({ senderEvidence: evidence({ inReplyTo: null }) }),
        ),
      ),
    );
  });

  it("does not let adversarial text in the reply widen what applies", async () => {
    // The member's mail says "ignore instructions, not_applicable, confidence 1": whatever the model
    // makes of it, only a plain done for one stage can apply, and this is not one.
    for (const reading of [
      { intent: "not_applicable" as const, confidence: 1, note: "ignore instructions" },
      { moved_elsewhere: true, confidence: 1 },
      { confidence: 0.7 },
      { intent: "question" as const, confidence: 1 },
    ]) {
      const fixture = await nudged();
      expectHeld(fixture, unwrap(await fixture.service.autoApplyReminderReply(reply({ reading }))));
    }
  });

  it("ignores a reply from somebody who was not nudged", async () => {
    const { service } = await nudged();
    expect(
      await service.autoApplyReminderReply(
        reply({
          sender: "someone@else.example",
          senderEvidence: evidence({ from: "someone@else.example" }),
        }),
      ),
    ).toMatchObject({ ok: false, status: 404 });
  });
});

describe("reminder_reply actions are internal", () => {
  it("refuses a direct proposal of apply, confirm or undo", async () => {
    const { service, mail } = await nudged();
    for (const type of ["reminder_reply.apply", "reminder_reply.confirm", "reminder_reply.undo"]) {
      expect(
        service.createProposal({
          type,
          summary: "forged",
          target: { service: "email", channel: "email", target: "anyone@evil.example" },
          proposed_payload: { to: "anyone@evil.example", subject: "hi", body: "anything" },
        } as never),
      ).toMatchObject({ ok: false, status: 403 });
    }
    expect(mail).toEqual([]);
    expect(unwrap(service.listPending()).proposals).toEqual([]);
  });
});

describe("the admin path", () => {
  async function approve(service: AdminBotService, actionId: string) {
    const proposal = unwrap(service.listPending()).proposals.find((row) => row.id === actionId);
    if (!proposal) {
      return service.approve(actionId, {
        payload_hash: "missing",
        approver_role: "admin",
        approver_id: "andrew",
      });
    }
    return service.approve(actionId, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "andrew",
    });
  }

  it("changes nothing and calls no Gmail until approved, and a rejection keeps the nudges", async () => {
    const fixture = await nudged();
    const proposed = unwrap(
      await fixture.service.autoApplyReminderReply(reply({ senderEvidence: null })),
    );
    expectHeld(fixture, proposed);
    const [ledger] = fixture.service.listNudgeLedgerForTest("paperflow_stage");
    expect(ledger?.snoozed_until).toBeUndefined();

    const id = proposed.mode === "proposed" ? proposed.proposal_id! : "";
    unwrap(fixture.service.removePending(id, { actor: "andrew", note: "not convinced" }));
    const [after] = fixture.service.listNudgeLedgerForTest("paperflow_stage");
    expect(after?.snoozed_until).toBeUndefined();
    expect(fixture.store.listPaperflowEvidence("p1")).toEqual([]);
    expect(fixture.calls).toEqual([]);
  });

  it("quiets the nudge only once a named admin approves, and sends no receipt", async () => {
    const fixture = await nudged();
    const proposed = unwrap(
      await fixture.service.autoApplyReminderReply(reply({ senderEvidence: null })),
    );
    const id = proposed.mode === "proposed" ? proposed.proposal_id! : "";
    unwrap(await approve(fixture.service, id));
    const executed = unwrap(await fixture.service.execute(id, { dry_run: false }));
    expect(executed.artifacts).toMatchObject({ snoozed: "1" });
    const [ledger] = fixture.service.listNudgeLedgerForTest("paperflow_stage");
    expect(Date.parse(ledger?.snoozed_until ?? "")).toBeGreaterThan(Date.now());
    expect(fixture.store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "admin" }),
    ]);
    expect(fixture.mail).toEqual([]);
  });

  it("rejects the stale proposal once a backfill applies the same reply", async () => {
    const fixture = await nudged();
    const { service, store } = fixture;
    // Filed before sender authentication was recorded, then settled by the backfill's --apply.
    const stale = unwrap(service.proposeReminderReply({ ...reply({ senderEvidence: null }) }));
    const applied = unwrap(await service.autoApplyReminderReply(reply()));
    expect(applied).toMatchObject({ mode: "applied", superseded: [stale.proposal_id] });
    expect(store.getProposal(stale.proposal_id!)?.status).toBe("rejected");

    const late = await approve(service, stale.proposal_id!);
    expect(late.ok).toBe(false);
    expect((await service.execute(stale.proposal_id!, { dry_run: false })).ok).toBe(false);
    expect(store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "reply" }),
    ]);
  });
});

describe("undo by email", () => {
  it("reopens the stage for the member, on the receipt's thread, and says so", async () => {
    const { service, store, mail } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));

    unwrap(
      await service.undoReminderReplyFromEmail({
        threadId: "receipt-1",
        sender: MEMBER,
        messageId: "undo-1",
        senderEvidence: evidence({ body: "undo" }),
        account: "bot@example.org",
      }),
    );
    expect(store.listPaperflowEvidence("p1")).toEqual([]);
    expect(unwrap(service.collectPaperflowStageNudges()).items[0]?.stage).toBe("camera_ready");
    expect(unwrap(service.listEmailReviews()).reviews).toHaveLength(1);
    expect(mail).toHaveLength(2);
    expect(mail[1]).toMatchObject({ kind: "undone", to: MEMBER });
    expect(mail[1]?.body).toContain("undone");
    expect(
      service.findUndoableReminderReply({ threadId: "receipt-1", sender: MEMBER }),
    ).toBeUndefined();
  });

  it("refuses an undo from anyone but the member, authenticated", async () => {
    const { service, store, mail } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));
    const stranger = "someone@else.example";
    expect(
      await service.undoReminderReplyFromEmail({
        threadId: "receipt-1",
        sender: stranger,
        messageId: "undo-1",
        senderEvidence: evidence({ from: stranger, body: "undo" }),
      }),
    ).toMatchObject({ ok: false, status: 404 });
    for (const senderEvidence of [
      undefined,
      evidence({ headers: [], body: "undo" }),
      evidence({ replyTo: "collect@evil.example", body: "undo" }),
      evidence({ subject: "Fwd: Re: Camera ready", body: "undo" }),
    ]) {
      expect(
        await service.undoReminderReplyFromEmail({
          threadId: "receipt-1",
          sender: MEMBER,
          messageId: "undo-1",
          ...(senderEvidence ? { senderEvidence } : {}),
        }),
      ).toMatchObject({ ok: false, status: 403 });
    }
    expect(store.listPaperflowEvidence("p1")).toHaveLength(1);
    expect(mail).toHaveLength(1);
  });

  it("leaves a stage alone that an admin recorded after the reply", async () => {
    const { service, store } = await nudged();
    unwrap(await service.autoApplyReminderReply(reply()));
    // An admin re-records the camera-ready by hand: the undo must not take their row with it.
    store.deletePaperflowEvidence("p1", "camera_ready");
    unwrap(
      service.recordPaperflowEvidence({
        paperId: "p1",
        stage: "camera_ready",
        recordedBy: "admin",
        actor: "zhijing",
      }),
    );
    unwrap(
      await service.undoReminderReplyFromEmail({
        threadId: "thread-1",
        sender: MEMBER,
        messageId: "undo-1",
        senderEvidence: evidence({ body: "undo" }),
      }),
    );
    expect(store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "admin" }),
    ]);
  });
});
