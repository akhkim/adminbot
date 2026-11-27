// The safe-auto apply against SQLite, where the race is real: the stage write and the withdrawal of
// stale review proposals are one transaction, so a crash between them leaves neither, and a second
// process executing an approved stale proposal either waits for the commit and is refused, or runs
// first and the apply is refused. The memory-store behaviour is in
// service.reminder-reply-auto.test.ts.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdminBotReminderReplyReading } from "../contracts/email-review.js";
import { createAdminBotSqliteService } from "../persistence/sqlite.js";
import type { AdminBotService } from "./service.js";
import { reminderReplySenderEvidence } from "./service.reminder-reply-auto.js";

const MEMBER = "xq@ethz.example";
const PAPER_TITLE = "Multi-Agent AI Systems Need Institutional Design";
const GMAIL_PASS =
  "mx.google.com; dkim=pass header.i=@ethz.example; spf=pass smtp.mailfrom=xq@ethz.example; dmarc=pass header.from=ethz.example";

function unwrap<T>(
  result: { ok: true; payload: T } | { ok: false; error: { message: string } },
): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.payload;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

/** One connection to the database at `databasePath`, with the Gmail side recorded in `mail`. */
function connect(databasePath: string, mail: unknown[]) {
  let sends = 0;
  const opened = createAdminBotSqliteService({
    databasePath,
    paperflowBotEmail: "adminbot@example.org",
    executor: {
      execute: async (proposal: { type: string; proposed_payload?: unknown }) => {
        if (proposal.type === "reminder_reply.confirm") {
          mail.push(proposal.proposed_payload);
          return { handled: true, artifacts: { gmail_message_id: `sent-${mail.length}` } };
        }
        if (proposal.type !== "member_nudge.send") {
          return { handled: false };
        }
        sends += 1;
        return {
          handled: true,
          artifacts: {
            gmail_thread_id: `thread-${sends}`,
            rfc_message_id: `<reminder-${sends}@mail.gmail.com>`,
          },
        };
      },
    } as never,
  });
  cleanups.push(() => opened.close());
  return opened;
}

/** Two connections to one database file, as two processes would have; the reminder already sent. */
async function twoConnections() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-reply-sqlite-"));
  const databasePath = path.join(dir, "service.sqlite");
  const mail: unknown[] = [];
  const a = connect(databasePath, mail);
  const b = connect(databasePath, mail);
  cleanups.unshift(() => fs.rmSync(dir, { recursive: true, force: true }));
  const service = a.service;
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
  return { a, b, mail };
}

const reading: AdminBotReminderReplyReading = {
  intent: "done",
  note: "uploaded it",
  moved_elsewhere: false,
  confidence: 0.95,
};

function reply(withEvidence = true) {
  return {
    messageId: "reply-1",
    threadId: "thread-1",
    sender: MEMBER,
    reading,
    ...(withEvidence
      ? {
          senderEvidence: reminderReplySenderEvidence({
            from: MEMBER,
            inReplyTo: "<reminder-1@mail.gmail.com>",
            authenticationResults: [GMAIL_PASS],
            subject: `Re: Camera ready: ${PAPER_TITLE}`,
            body: "Done, thanks!\n\nXuanqiang",
          }),
        }
      : {}),
    actor: "adminbot-email-automation",
    account: "bot@example.org",
  };
}

/** A stale review proposal for the reply, already approved by an admin. */
async function approvedStale(service: AdminBotService): Promise<string> {
  const id = unwrap(service.proposeReminderReply(reply(false))).proposal_id!;
  const proposal = unwrap(service.listPending()).proposals.find((row) => row.id === id)!;
  unwrap(
    await service.approve(id, {
      payload_hash: proposal.payload_hash,
      approver_role: "admin",
      approver_id: "andrew",
    }),
  );
  return id;
}

describe("reminder reply apply on SQLite", () => {
  it("leaves neither the stage nor the withdrawal behind when it fails between them", async () => {
    const { a, b, mail } = await twoConnections();
    const stale = await approvedStale(a.service);
    a.service.afterReminderReplyStageWrite = () => {
      throw new Error("killed");
    };
    const crashed = await a.service.autoApplyReminderReply(reply()).catch((error: Error) => error);
    expect(crashed instanceof Error ? crashed.message : JSON.stringify(crashed)).toMatch(/killed/);

    // Rolled back as a whole, as the other connection sees it: no stage, the proposal still live.
    expect(b.store.listPaperflowEvidence("p1")).toEqual([]);
    expect(b.store.getProposal(stale)?.status).toBe("approved");
    expect(mail).toEqual([]);

    // The next pass applies the reply and withdraws the stale proposal, together.
    a.service.afterReminderReplyStageWrite = undefined;
    expect(unwrap(await a.service.autoApplyReminderReply(reply())).mode).toBe("applied");
    expect(b.store.getProposal(stale)?.status).toBe("rejected");
    expect((await b.service.execute(stale, { dry_run: false })).ok).toBe(false);
    expect(b.store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "reply" }),
    ]);
  });

  it("refuses the approved stale proposal another connection starts mid-apply", async () => {
    const { a, b, mail } = await twoConnections();
    const stale = await approvedStale(a.service);
    let racing: ReturnType<AdminBotService["execute"]> | undefined;
    a.service.afterReminderReplyStageWrite = () => {
      // Inside the apply's transaction: the stage is written and the proposal withdrawn, but
      // neither is committed. The other process's execute must not get in between.
      racing ??= b.service.execute(stale, { dry_run: false });
    };
    expect(unwrap(await a.service.autoApplyReminderReply(reply())).mode).toBe("applied");
    const raced = await racing!.catch((error: Error) => error);
    expect(raced instanceof Error || !raced.ok).toBe(true);
    expect(b.store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "reply" }),
    ]);
    expect(mail).toHaveLength(1);
  }, 20_000);

  it("does not apply a reply another connection's approved proposal already resolved", async () => {
    const { a, b, mail } = await twoConnections();
    const stale = await approvedStale(a.service);
    expect(unwrap(await b.service.execute(stale, { dry_run: false })).status).toBe("executed");
    const auto = unwrap(await a.service.autoApplyReminderReply(reply()));
    expect(auto.mode).not.toBe("applied");
    expect(a.store.listPaperflowEvidence("p1")).toEqual([
      expect.objectContaining({ stage: "camera_ready", recorded_by: "admin" }),
    ]);
    expect(mail).toEqual([]);
  });
});
