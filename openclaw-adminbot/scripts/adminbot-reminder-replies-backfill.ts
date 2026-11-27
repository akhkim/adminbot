// Settle the reminder replies already waiting in Needs Review, the way the hourly pass now would.
//
//   node --import tsx scripts/adminbot-reminder-replies-backfill.ts --database <path> [--apply]
//
// Dry run by default: nothing is written and nothing is sent. It prints, for every reminder reply
// still held for an admin, whether it would be applied (and the receipt that would go to whom) or
// stay in review (and why), followed by the accepted papers whose conference stage and attendance
// roll-call are no longer asked about because the conference has been held or the venue moved on.
// That second list needs no --apply: it is computed on read, and is printed so the change is seen.
//
// "Apply" is the same safe-auto rule as the live pass: Gmail authenticated the member's roster
// address, it is a direct reply on the reminder's thread, not forwarded, and a plain "done" for one
// PaperFlow stage. A proposal filed before sender authentication was recorded has none on record,
// so it stays in review for an admin, and so does one not filed by the service itself under its
// internal key: its evidence is whatever its author wrote, and is not read.
//
// With --apply, each "apply" row goes through the same `reminder_reply.apply` action as a live
// reply -- audited, undoable by the member replying "undo" -- and the fixed receipt is sent from the
// bot mailbox (ADMINBOT_BOT_EMAIL) through gog to the member's roster address. The pending review
// proposal for that message is then rejected, so a later approval cannot write it a second time.
// Rows that would stay in review are left untouched.
import { createGogAdminBotExecutor } from "../extensions/adminbot/src/connectors/gog.js";
import type { AdminBotReminderReplyReading } from "../extensions/adminbot/src/contracts/email-review.js";
import type { AdminBotServiceStore } from "../extensions/adminbot/src/kernel/service.js";
import {
  parseSenderEvidence,
  type ReminderReplySenderEvidence,
} from "../extensions/adminbot/src/kernel/service.reminder-reply-auto.js";
import { createAdminBotSqliteService } from "../extensions/adminbot/src/persistence/sqlite.js";
import { adminbotServiceDatabasePath } from "./adminbot-service-database.js";
import { isMainModule } from "./lib/is-main-module.mjs";

type Args = { databasePath: string; apply: boolean; account?: string };

function parseArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    databasePath: value("--database") ?? adminbotServiceDatabasePath(),
    apply: argv.includes("--apply"),
    account: value("--account") ?? process.env.ADMINBOT_BOT_EMAIL?.trim() ?? undefined,
  };
}

export type HeldReply = {
  proposal_id: string;
  message_id: string;
  thread_id: string;
  sender: string;
  subject?: string;
  reading: AdminBotReminderReplyReading;
  sender_evidence?: ReminderReplySenderEvidence;
};

type HeldReplyStore = Pick<
  AdminBotServiceStore,
  "listProposalsByType" | "getEmailReview" | "getDeadlineProposalSubmission"
>;

/**
 * The reminder replies still waiting for an admin.
 *
 * Sender evidence is kept only from a proposal the service filed itself: the one stored under the
 * internal key `email_review.resolve:<message id>`. Anyone with the propose tool can file an
 * `email_review.resolve` whose payload claims an authenticated sender; such a row keeps its place in
 * review but loses the evidence, so the backfill can never apply it.
 */
export function heldReminderReplies(store: HeldReplyStore): HeldReply[] {
  const held: HeldReply[] = [];
  for (const proposal of store.listProposalsByType("email_review.resolve")) {
    const payload = proposal.proposed_payload as Partial<HeldReply> | undefined;
    if (
      proposal.status !== "pending" ||
      !payload?.reading ||
      typeof payload.message_id !== "string" ||
      typeof payload.thread_id !== "string" ||
      typeof payload.sender !== "string" ||
      !store.getEmailReview(payload.message_id)
    ) {
      continue;
    }
    const internal =
      store.getDeadlineProposalSubmission?.(
        "email_review",
        `email_review.resolve:${payload.message_id}`,
      )?.id === proposal.id;
    const senderEvidence = internal ? parseSenderEvidence(payload.sender_evidence) : undefined;
    held.push({
      proposal_id: proposal.id,
      message_id: payload.message_id,
      thread_id: payload.thread_id,
      sender: payload.sender,
      ...(typeof payload.subject === "string" ? { subject: payload.subject } : {}),
      reading: payload.reading,
      ...(senderEvidence ? { sender_evidence: senderEvidence } : {}),
    });
  }
  return held;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.apply && !args.account) {
    throw new Error(
      "--apply sends receipts from the bot mailbox: set ADMINBOT_BOT_EMAIL or --account",
    );
  }
  const { service, store, close } = createAdminBotSqliteService({
    databasePath: args.databasePath,
    ...(args.apply ? { executor: createGogAdminBotExecutor() } : {}),
  });
  try {
    const held = heldReminderReplies(store);

    console.log(`${args.apply ? "APPLY" : "DRY RUN"}: ${held.length} reminder repl(ies) in review`);
    let applied = 0;
    for (const reply of held) {
      const senderEvidence = reply.sender_evidence;
      const plan = service.planReminderReply({
        sender: reply.sender,
        threadId: reply.thread_id,
        ...(reply.subject ? { subject: reply.subject } : {}),
        reading: reply.reading,
        ...(senderEvidence ? { senderEvidence } : {}),
      });
      if (!plan.ok) {
        console.log(
          `- ${reply.message_id} (${reply.sender}): stays in review: ${plan.error.message}`,
        );
        continue;
      }
      const { mode, member_name, resolution, label, why_review, receipt } = plan.payload;
      if (mode === "review" || !receipt) {
        console.log(`- ${reply.message_id} ${member_name}: stays in review (${why_review})`);
        continue;
      }
      console.log(`- ${reply.message_id} ${member_name}: would ${resolution.kind} on ${label}`);
      console.log(`  receipt to ${receipt.to}, subject "${receipt.subject}":`);
      for (const line of receipt.body.split("\n")) {
        console.log(`    | ${line}`);
      }
      if (!args.apply) {
        continue;
      }
      const result = await service.autoApplyReminderReply({
        messageId: reply.message_id,
        threadId: reply.thread_id,
        sender: reply.sender,
        ...(reply.subject ? { subject: reply.subject } : {}),
        reading: reply.reading,
        ...(senderEvidence ? { senderEvidence } : {}),
        actor: "adminbot-reminder-replies-backfill",
        ...(args.account ? { account: args.account } : {}),
      });
      if (result.ok && result.payload.mode === "applied") {
        applied += 1;
        console.log(
          `  applied ${result.payload.apply_action_id}${result.payload.confirm_error ? `; receipt NOT sent: ${result.payload.confirm_error}` : ""}`,
        );
        if (result.payload.superseded.length > 0) {
          console.log(
            `  rejected stale review proposal(s): ${result.payload.superseded.join(", ")}`,
          );
        }
      } else if (result.ok && result.payload.mode === "duplicate") {
        console.log(
          `  already applied as ${result.payload.apply_action_id ?? "an earlier action"}`,
        );
      } else {
        console.log(
          `  not applied: ${result.ok ? ((result.payload.mode === "proposed" ? result.payload.apply_error : undefined) ?? "held") : result.error.message}`,
        );
      }
    }

    const closed = service.conferencesClosedByVenue();
    console.log(`\n${closed.length} accepted paper(s) no longer asked about the conference:`);
    for (const paper of closed) {
      console.log(
        `- ${paper.paper_id} (${paper.venue ?? "no venue"}): ${paper.unanswered_attendance} unanswered attendance row(s) dropped`,
      );
    }
    if (args.apply) {
      console.log(`\napplied ${applied} of ${held.length}`);
    }
  } finally {
    close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
