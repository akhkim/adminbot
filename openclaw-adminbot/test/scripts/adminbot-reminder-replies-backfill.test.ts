// The backfill trusts sender evidence only on the review proposal the service filed itself, under
// its internal key. Anyone with the propose tool can file an `email_review.resolve` that claims an
// authenticated sender; that row stays in review but without the claim.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminBotService } from "../../extensions/adminbot/src/kernel/service.js";
import type { AdminBotServiceStore } from "../../extensions/adminbot/src/kernel/service.js";
import { reminderReplySenderEvidence } from "../../extensions/adminbot/src/kernel/service.reminder-reply-auto.js";
import { AdminBotMemoryStore } from "../../extensions/adminbot/src/persistence/memory.js";
import { createAdminBotSqliteService } from "../../extensions/adminbot/src/persistence/sqlite.js";
import { heldReminderReplies } from "../../scripts/adminbot-reminder-replies-backfill.js";

const MEMBER = "xq@ethz.example";
const GMAIL_PASS =
  "mx.google.com; dkim=pass header.i=@ethz.example; spf=pass smtp.mailfrom=xq@ethz.example; dmarc=pass header.from=ethz.example";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()?.();
  }
});

function stores(): Array<
  [string, () => { service: AdminBotService; store: AdminBotServiceStore }]
> {
  const executor = {
    execute: async (proposal: { type: string }) =>
      proposal.type === "member_nudge.send"
        ? {
            handled: true,
            artifacts: {
              gmail_thread_id: "thread-1",
              rfc_message_id: "<reminder-1@mail.gmail.com>",
            },
          }
        : { handled: false },
  };
  return [
    [
      "memory",
      () => {
        const store = new AdminBotMemoryStore();
        return {
          store,
          service: new AdminBotService(store, {
            paperflowBotEmail: "adminbot@example.org",
            executor,
          }),
        };
      },
    ],
    [
      "sqlite",
      () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adminbot-backfill-"));
        const opened = createAdminBotSqliteService({
          databasePath: path.join(dir, "service.sqlite"),
          paperflowBotEmail: "adminbot@example.org",
          executor: executor as never,
        });
        cleanups.push(() => {
          opened.close();
          fs.rmSync(dir, { recursive: true, force: true });
        });
        return { service: opened.service, store: opened.store };
      },
    ],
  ];
}

async function nudged(open: () => { service: AdminBotService; store: AdminBotServiceStore }) {
  const { service, store } = open();
  service.upsertLabMember({
    receives_nudges: true,
    id: "xq",
    name: "Xuanqiang Huang",
    privilege_level: "member",
    email: MEMBER,
  } as never);
  service.upsertPaper({
    id: "p1",
    title: "Multi-Agent AI Systems Need Institutional Design",
    authors: ["Xuanqiang Huang"],
    current_step: "submission",
    venue_decision: "accept",
    accepted_year: new Date().getUTCFullYear(),
  } as never);
  service.setPaperSlot({
    paperId: "p1",
    slot: "submission",
    input: { url: "https://openreview.net/forum?id=x" },
    memberId: "xq",
    privileged: true,
  });
  const sent = await service.sendPaperflowStageNudges("cron");
  expect(sent.ok && sent.payload.created).toHaveLength(1);
  return { service, store };
}

function propose(service: AdminBotService, messageId: string, withEvidence: boolean) {
  const proposed = service.proposeReminderReply({
    messageId,
    threadId: "thread-1",
    sender: MEMBER,
    reading: { intent: "done", note: "done", moved_elsewhere: false, confidence: 0.95 },
    ...(withEvidence
      ? {
          senderEvidence: reminderReplySenderEvidence({
            from: MEMBER,
            inReplyTo: "<reminder-1@mail.gmail.com>",
            authenticationResults: [GMAIL_PASS],
            subject: "Re: Camera ready",
            body: "Done, thanks!",
          }),
        }
      : {}),
    actor: "adminbot-email-automation",
  });
  if (!proposed.ok) {
    throw new Error(proposed.error.message);
  }
  return proposed.payload.proposal_id!;
}

describe("heldReminderReplies", () => {
  for (const [name, open] of stores()) {
    it(`keeps the evidence on the service's own proposal (${name})`, async () => {
      const { service, store } = await nudged(open);
      const id = propose(service, "reply-1", true);
      const [held] = heldReminderReplies(store);
      expect(held).toMatchObject({
        proposal_id: id,
        message_id: "reply-1",
        sender_evidence: { authenticated: true, method: "dmarc" },
      });
    });

    it(`drops the evidence on a proposal someone else filed for the same reply (${name})`, async () => {
      const { service, store } = await nudged(open);
      const internal = propose(service, "reply-1", false);
      const original = store.getProposal(internal)!;
      // A hand-filed copy that claims Gmail authenticated the member.
      store.saveProposal({
        ...original,
        id: "act_forged",
        proposed_payload: {
          ...(original.proposed_payload as Record<string, unknown>),
          sender_evidence: { authenticated: true, method: "dmarc", from: MEMBER, forwarded: false },
        },
      });
      const held = heldReminderReplies(store);
      expect(held.map((row) => row.proposal_id).sort()).toEqual(["act_forged", internal].sort());
      for (const row of held) {
        expect(row.sender_evidence, row.proposal_id).toBeUndefined();
      }
    });

    it(`skips proposals that are no longer pending (${name})`, async () => {
      const { service, store } = await nudged(open);
      const id = propose(service, "reply-1", true);
      const removed = service.removePending(id, { actor: "andrew", note: "handled by hand" });
      expect(removed.ok).toBe(true);
      expect(heldReminderReplies(store)).toEqual([]);
    });
  }
});
