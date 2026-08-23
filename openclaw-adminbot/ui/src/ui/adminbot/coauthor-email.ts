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
export function firstFullMemberAuthor(
  paper: AdminBotPaperRecord,
  members: AdminBotLabMember[],
): AdminBotLabMember | undefined {
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

export function buildCoauthorEmail(
  paper: AdminBotPaperRecord,
  decision: "accept" | "reject",
  venue: string,
  senderName: string,
): CoauthorEmailDraft {
  const track = paper.presentation_type ? ` (${paper.presentation_type})` : "";
  if (decision === "accept") {
    return {
      subject: `Accepted to ${venue}: ${paper.title}`,
      body: [
        "Dear all,",
        "",
        `Our paper "${paper.title}" has been accepted to ${venue}${track}.`,
        "",
        "[ADD THE CAMERA-READY DEADLINE AND WHAT YOU NEED FROM EACH PERSON]",
        "",
        "[SAY WHO IS PLANNING TO ATTEND, AND ASK THE REST TO CONFIRM]",
        "",
        "Thanks all for the work on this.",
        "",
        "Best,",
        senderName || "[YOUR NAME]",
      ].join("\n"),
    };
  }
  return {
    subject: `${venue} decision: ${paper.title}`,
    body: [
      "Dear all,",
      "",
      `Our paper "${paper.title}" was not accepted at ${venue}.`,
      "",
      "[SUMMARISE WHAT THE REVIEWS ASKED FOR]",
      "",
      "[PROPOSE THE NEXT VENUE AND THE TIMELINE YOU HAVE IN MIND]",
      "",
      "Thanks all for the work on this.",
      "",
      "Best,",
      senderName || "[YOUR NAME]",
    ].join("\n"),
  };
}

/** Whether anything still needs a human. Drives the "you have not finished this" hint. */
export function hasPlaceholders(body: string): boolean {
  return /\[[A-Z][^\]]*\]/u.test(body);
}
