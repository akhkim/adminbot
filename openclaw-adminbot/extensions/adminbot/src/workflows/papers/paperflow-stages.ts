// Which venue-cycle stage a paper is currently waiting on, who hears about it, and what the
// email says.
//
// Pure, for the same reason paper-slots.ts is: the service owns the store, the roster and the
// outbound mail, and this file only turns records into a decision. That is what makes the whole
// escalation testable without a database, a mailbox or a venue.

import {
  adminBotIsAlumniMember,
  type AdminBotLabMember,
  type AdminBotPaperRecord,
} from "../../contracts/actions.js";
import type { AdminBotNudgeLedgerRecord } from "../../contracts/paper-cycle.js";
import {
  isAdminBotPaperSlotSettled,
  type AdminBotPaperSlotRecord,
} from "../../contracts/paper-slots.js";
import {
  adminBotPaperflowStageRegistry,
  adminBotPaperflowSubjectId,
  type AdminBotPaperflowEvidenceRecord,
  type AdminBotPaperflowStage,
} from "../../contracts/paperflow-stages.js";
import { isPaperDormant } from "./paper-slots.js";

/**
 * A member who counts as "full" for the purposes of being handed a paper's venue cycle.
 *
 * `member` and `admin` only. A trial member has not committed to the lab and an external
 * collaborator is not ours to chase; handing either of them the standing responsibility for a
 * paper's deadlines would be asking somebody who may be gone next month to hold a hard clock.
 */
export function isFullMember(member: AdminBotLabMember): boolean {
  if (member.privilege_level !== "member" && member.privilege_level !== "admin") {
    return false;
  }
  // Alumni and external outrank the privilege level: somebody who has left still has their roster
  // row, and mailing them about a rebuttal window is a message nobody acts on.
  //
  // Asked through adminBotIsAlumniMember rather than off `status` alone, which is what this used
  // to do. The roster records having left in two fields and the imported rows use the other one:
  // 22 of the 24 alumni carry `member_type: alumni` with no status at all, so the status check
  // saw none of them and this handed them papers. The Slack sweeps were reading both the whole
  // time (isActiveRosterMember), so the rule was half-enforced -- silent on Slack, still emailing.
  return !adminBotIsAlumniMember(member) && member.status !== "external";
}

/**
 * Whether a roster name and an author name are the same person.
 *
 * Not string equality, because author lists and roster rows disagree about middle names as a rule
 * rather than as an exception -- the roster says "Rahul Shrestha" and the papers say "Rahul Babu
 * Shrestha", and an exact match silently routes every one of those papers to nobody. A silent
 * non-match is the worst possible failure here: the paper looks unowned, and the only symptom is
 * mail that never arrives.
 *
 * The rule: same first name, same last name, and the shorter name's remaining parts all appear in
 * the longer one in order. That accepts a dropped or added middle name and rejects two different
 * people who merely share a surname. Single-token names are never matched loosely -- "Jin" alone
 * says too little to be worth guessing from.
 */
export function matchesAuthorName(rosterName: string, authorName: string): boolean {
  const left = nameParts(rosterName);
  const right = nameParts(authorName);
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left.join(" ") === right.join(" ")) {
    return true;
  }
  if (left.length < 2 || right.length < 2) {
    return false;
  }
  if (left[0] !== right[0] || left.at(-1) !== right.at(-1)) {
    return false;
  }
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  let cursor = 0;
  for (const part of shorter) {
    const found = longer.indexOf(part, cursor);
    if (found < 0) {
      return false;
    }
    cursor = found + 1;
  }
  return true;
}

/** Lowercased, unaccented, punctuation-free name parts. */
function nameParts(value: string): string[] {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

export type PaperflowRecipient = {
  member: AdminBotLabMember;
  /** Where in the author list they were found, 0-based. Reported so a surprising pick is visible. */
  authorIndex: number;
  /** True when the priority override put them ahead of an earlier author. */
  prioritized: boolean;
};

/**
 * The first full member in the author list, with one override.
 *
 * Author order is the rule because it is the lab's own convention for who owns a paper, and it is
 * already recorded on every paper -- no new field to keep in step. The walk skips authors who are
 * external, on trial, or not on the roster at all: AdminBot has no standing to chase an outside
 * coauthor and no address to chase them at, so the responsibility falls to the first person
 * inside the lab.
 *
 * `priorityMemberId` is a deliberate, configured thumb on the scale (ADMINBOT_PAPERFLOW_PRIORITY_
 * MEMBER_ID). It exists because one person is currently holding the venue cycle for the lab
 * regardless of where they sit in any given author list, and encoding that as configuration keeps
 * it visible and removable rather than buried as a name in a conditional.
 */
export function paperflowRecipient(
  paper: AdminBotPaperRecord,
  roster: readonly AdminBotLabMember[],
  priorityMemberId?: string,
): PaperflowRecipient | undefined {
  // Only full members are candidates for the name match at all. Matching loosely first and
  // filtering afterwards would let a trial member's near-name shadow the full member sitting
  // behind them in the author list.
  const candidates = roster.filter((member) => isFullMember(member));
  const eligible = paper.authors.flatMap((name, authorIndex) => {
    const member = candidates.find((entry) => matchesAuthorName(entry.name, name));
    return member ? [{ member, authorIndex }] : [];
  });
  const first = eligible[0];
  if (!first) {
    return undefined;
  }
  const priority = priorityMemberId
    ? eligible.find((entry) => entry.member.id === priorityMemberId)
    : undefined;
  const chosen = priority ?? first;
  return {
    member: chosen.member,
    authorIndex: chosen.authorIndex,
    prioritized: Boolean(priority) && chosen.authorIndex !== first.authorIndex,
  };
}

export type OpenPaperflowStage = {
  stage: AdminBotPaperflowStage;
  subjectId: string;
  /** Why this stage is the one being asked about, for the audit row and the admin preview. */
  reason: string;
  priority: number;
  deadlineBearing: boolean;
};

/**
 * The one stage a paper is currently waiting to hear about, if any.
 *
 * One rather than a list, on purpose. The stages are sequential -- reviews, then a rebuttal
 * window, then a decision, then the accept path -- so a paper whose reviews have not landed
 * cannot sensibly be asked whether the decision came out, and asking both in one mail is how an
 * author learns that this sender does not know where their paper is.
 *
 * A stage is closed by evidence, never by the clock. `venue_decision` closes the early stages too,
 * because an admin recording an accept has told us the decision came out by a route that is at
 * least as good as a bcc.
 */
export function openPaperflowStage(params: {
  paper: AdminBotPaperRecord;
  slots: readonly AdminBotPaperSlotRecord[];
  evidence: readonly AdminBotPaperflowEvidenceRecord[];
  now: Date;
}): OpenPaperflowStage | undefined {
  const { paper, slots, evidence, now } = params;
  if (isPaperDormant(paper, now)) {
    return undefined;
  }
  const seen = new Set(evidence.map((row) => row.stage));
  const settled = (slot: string) =>
    isAdminBotPaperSlotSettled(slots.find((row) => row.slot === slot)?.status ?? "missing");

  // Nothing before submission is the venue's to answer, so the whole ladder is gated on the
  // paper actually being in front of one. `submission` alone is enough: an author who has the
  // submission page but has not pasted the id back is still waiting on reviews.
  if (!settled("submission")) {
    return undefined;
  }
  const decision = paper.venue_decision ?? "pending";

  const open = (stage: AdminBotPaperflowStage, reason: string): OpenPaperflowStage => {
    const definition = adminBotPaperflowStageRegistry[stage];
    return {
      stage,
      subjectId: adminBotPaperflowSubjectId(paper.id, stage),
      reason,
      priority: definition.priority,
      deadlineBearing: definition.deadlineBearing,
    };
  };

  // A recorded decision means the reviews and the rebuttal window are behind us whether or not
  // anybody ever bcc'd us on them. Chasing a closed past is the fastest way to teach people that
  // these mails are not worth reading.
  const decided = decision !== "pending";

  if (!decided && !seen.has("reviews_out")) {
    return open("reviews_out", "submitted and no review notification has reached us");
  }
  if (!decided && !seen.has("rebuttal")) {
    return open("rebuttal", "reviews are in and the rebuttal window has not been accounted for");
  }
  if (!decided && !seen.has("decision")) {
    return open("decision", "the venue has not been recorded as deciding");
  }
  // A reject ends the cycle. The paper's next move is a new venue, which is a different attempt
  // and re-opens the ladder from the top when somebody records it.
  if (decision !== "accept") {
    return undefined;
  }
  if (!seen.has("camera_ready")) {
    return open("camera_ready", "accepted and the camera ready has not been confirmed");
  }
  if (!seen.has("conference")) {
    return open("conference", "accepted and conference travel has not been confirmed");
  }
  return undefined;
}

/**
 * The email one author gets about one stage.
 *
 * Composed here rather than drafted by the model. Every other automated mail in this codebase
 * that carries a request goes through the model for warmth, but this one repeats on a fixed
 * cadence until it is answered, and a nudge whose wording drifts every fortnight reads as four
 * different people asking the same question. The evidence-handoff instruction in particular has
 * to be byte-identical every time, because it is the thing the author is being trained to do.
 */
export function paperflowStageEmail(params: {
  paper: AdminBotPaperRecord;
  stage: AdminBotPaperflowStage;
  recipient: PaperflowRecipient;
  botEmail: string;
  entry?: AdminBotNudgeLedgerRecord;
}): { subject: string; body: string } {
  const { paper, stage, recipient, botEmail, entry } = params;
  const definition = adminBotPaperflowStageRegistry[stage];
  const firstName = recipient.member.name.trim().split(/\s+/u)[0] || "there";
  const venue = paper.venue?.trim() || paper.accepted_venue?.trim();
  const where = venue ? ` at ${venue}` : "";
  const askedBefore = (entry?.nudge_count ?? 0) > 0;
  const evidenceInstruction = [
    `When it lands, ${definition.handoffAsk} to ${botEmail} from an email address saved on your AdminBot profile.`,
    "Do not only bcc the original venue message — that arrives from the venue and has to wait for manual review.",
    `Once the forward is recorded, AdminBot marks ${definition.label.toLowerCase()} done on the paper and stops asking.`,
  ].join(" ");

  const lines = [
    `Hi ${firstName},`,
    "",
    definition.question,
    "",
    `This is about "${paper.title}"${where}.`,
    "",
    // The instruction matches the trusted-sender gate in the inbox processor. An original venue
    // message keeps the venue as `From` even when the bot is bcc'd, so it is deliberately held for
    // review. Forwarding from a profile address proves which lab member handed us the evidence.
    evidenceInstruction,
  ];
  if (recipient.authorIndex > 0 || recipient.prioritized) {
    lines.push(
      "",
      `You are getting this because you are the first lab member on the author list${recipient.prioritized ? " we route venue mail through" : ""}. If somebody else is handling the venue correspondence on this paper, forward this reminder to them; they should send the venue evidence from an email address saved on their AdminBot profile.`,
    );
  }
  if (askedBefore) {
    lines.push(
      "",
      `Asked ${entry?.nudge_count === 1 ? "once" : `${entry?.nudge_count} times`} before. If there is genuinely nothing to report yet, reply saying so and this pauses.`,
    );
  }
  lines.push("", "— AdminBot, Jinesis AI Lab");

  return {
    subject: `${definition.label}: ${paper.title}`,
    body: lines.join("\n"),
  };
}
