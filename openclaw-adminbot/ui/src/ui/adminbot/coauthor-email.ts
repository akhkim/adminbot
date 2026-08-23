// Telling the coauthors a decision landed.
//
// One person per paper is asked, and it is the first full member on the author list. Not the
// first author -- papers routinely have a student or an external collaborator first, and the mail
// carries the lab's name. Not everyone -- a paper with four lab members would otherwise produce
// four copies of the same news, which is how coauthors learn to skim.
//
// "Full member" is `privilege_level` of `member` or `admin`. `trial` is somebody still on
// probation and `external_collaborator` is not in the lab at all, so neither speaks for it.
//
// The draft is pre-written because the shape of the mail never changes, and the parts that do
// change are marked with [SQUARE BRACKETS] so it is obvious at a glance what still needs a human.
// Everything the record already knows -- title, venue, track -- is filled in rather than bracketed.

import type { AdminBotLabMember, AdminBotPaperRecord } from "./controllers/admin.ts";
import { isSamePerson } from "../../../../extensions/adminbot/src/contracts/person-names.js";

/** Every email the lab sends about a paper is copied here, so the record is not one person's inbox. */
export const ADMINBOT_BCC = "jinesis.adminbot@gmail.com";

function isFullMember(member: AdminBotLabMember): boolean {
  return member.privilege_level === "member" || member.privilege_level === "admin";
}

/**
 * The one person asked to send the mail.
 *
 * Author order decides it, so the answer is stable and everybody can predict it from the paper
 * itself rather than from who happened to open AdminBot first.
 */
/**
 * Who sends the mail for the EMNLP 2026 cycle, decided by hand.
 *
 * The rule below -- first full member on the author list -- is the one the lab wants, and it is
 * kept. It is only as good as the roster it reads, and the deployed roster disagrees with the
 * lab's own list of 49 full members: Francesco Ortu is not on that list but is labelled a member
 * up there, so the rule handed him a paper he should never have been offered. Rather than let a
 * data error decide who writes to eight coauthors, these nine are pinned.
 *
 * Keyed on a distinctive phrase from the title, because the OpenReview submission numbers are not
 * stored on the record and the ids differ between the local database and Aurora.
 *
 * Delete this table once the roster is corrected -- it is a statement about one cycle, not a rule.
 */
const EMNLP_2026_SENDERS: Array<{ titleContains: string; sender: string }> = [
  { titleContains: "preserving historical truth", sender: "Joeun Yook" },
  { titleContains: "pruneground", sender: "Terry Zhang" },
  { titleContains: "linear probes emerge", sender: "Vedant Palit" },
  { titleContains: "tracing multilingual", sender: "Zhijing Jin" },
  { titleContains: "computation graph recovery", sender: "Terry Zhang" },
  { titleContains: "simulating democratic deliberation", sender: "Ryan Faulkner" },
  { titleContains: "fluid reasoning representations", sender: "Terry Zhang" },
  { titleContains: "second-order bias", sender: "Terry Zhang" },
  { titleContains: "alignment tuning", sender: "Terry Zhang" },
];

function pinnedSender(
  paper: AdminBotPaperRecord,
  members: AdminBotLabMember[],
): AdminBotLabMember | undefined {
  const title = (paper.title ?? "").toLowerCase();
  const pinned = EMNLP_2026_SENDERS.find((entry) => title.includes(entry.titleContains));
  if (!pinned) {
    return undefined;
  }
  // Resolved through the roster rather than invented, so the mail still gets a real id and a real
  // address. If the named person is missing from the roster the rule below takes over.
  return members.find((member) => isSamePerson(pinned.sender, member.name));
}

export function firstFullMemberAuthor(
  paper: AdminBotPaperRecord,
  members: AdminBotLabMember[],
): AdminBotLabMember | undefined {
  const pinned = pinnedSender(paper, members);
  if (pinned) {
    return pinned;
  }
  for (const author of paper.authors ?? []) {
    const match = members.find((member) => isFullMember(member) && isSamePerson(author, member.name));
    if (match) {
      return match;
    }
  }
  return undefined;
}

/** Addresses for everyone on the author list the roster knows, senior authors included. */
export function coauthorEmails(
  paper: AdminBotPaperRecord,
  members: AdminBotLabMember[],
): string[] {
  const found: string[] = [];
  for (const author of paper.authors ?? []) {
    const match = members.find((member) => isSamePerson(author, member.name));
    // `correspondence_email` first: it is the address the lab writes to, and it is frequently
    // neither the login identity nor the calendar account.
    const address = match?.correspondence_email?.trim() || match?.email?.trim();
    if (address && !found.includes(address)) {
      found.push(address);
    }
  }
  return found;
}

/** Authors with no address on file. Shown rather than skipped, or somebody is quietly left out. */
export function unreachableAuthors(
  paper: AdminBotPaperRecord,
  members: AdminBotLabMember[],
): string[] {
  return (paper.authors ?? []).filter((author) => {
    const match = members.find((member) => isSamePerson(author, member.name));
    return !(match?.correspondence_email?.trim() || match?.email?.trim());
  });
}

export type CoauthorEmailDraft = { subject: string; body: string };

/**
 * The lab's own wording, kept verbatim.
 *
 * What the record already knows -- the title, the venue -- is substituted. Everything else stays
 * in [BRACKETS], because those are the parts a human has to decide: the short title, the
 * camera-ready date, who is presenting, the revision plan. Filling them in with a guess would be
 * worse than leaving the bracket, since a wrong date in a mail to seven coauthors is not a
 * formatting problem.
 */
export function buildCoauthorEmail(
  paper: AdminBotPaperRecord,
  decision: "accept" | "reject",
  venue: string,
  senderName: string,
): CoauthorEmailDraft {
  const signature = senderName || "[YOUR NAME]";
  if (decision === "accept") {
    return {
      subject: `Accepted 🎉 [PAPER_SHORT_TITLE] at ${venue}`,
      body: [
        "Dear All,",
        "",
        `Wonderful news: ${paper.title} has been accepted at ${venue}! Congratulations, and thank you for being part of this.`,
        "",
        "Next steps on our side:",
        "",
        "Camera-ready is due [DATE]; we will circulate the final version, and we will double-check your name and affiliation once more before it is frozen.",
        "",
        "We will prepare social media announcements (on LinkedIn, Twitter/X, etc.) and, as always, send you the drafts for a look before anything is posted.",
        "",
        `[IF_APPLICABLE: "On conference attendance: [WHO_ATTENDS] will present. If you plan to be at [VENUE_LOCATION], it would be lovely to plan a dinner."]`,
        "",
        "Best regards,",
        signature,
      ].join("\n"),
    };
  }
  return {
    subject: `[PAPER_SHORT_TITLE]: ${venue} outcome and next steps`,
    body: [
      "Dear All,",
      "",
      `The ${venue} decision for ${paper.title} unfortunately came back negative. We plan to revise the paper and resubmit to [NEXT_VENUE] (deadline [DATE]).`,
      "",
      `Our main action items will be [PLAN, e.g., "add more experiments across XX_model, ...", "address the evaluation concern with the additional experiments Reviewer 2 suggested, ..."].`,
      "",
      "The reviews are here: [REVIEWS_LINK]. We will share with you the updated draft once we are finished. In the meantime, please do not hesitate to let us know if you have any additional feedback.",
      "",
      "Thank you for your support all along the way!",
      "",
      "Best regards,",
      signature,
    ].join("\n"),
  };
}

/** Whether anything still needs a human. Drives the "you have not finished this" hint. */
export function hasPlaceholders(body: string): boolean {
  return /\[[A-Z][^\]]*\]/u.test(body);
}
