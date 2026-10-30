// The lab's talks-this-year leaderboard, counted from members' scanned CVs.
//
// The guidebook's travel perk goes to the top of this list, and until now it was kept by hand in
// the meeting doc. It is counted from each member's current CV snapshot rather than from the change
// ledger: the ledger only holds what a scan saw *appear*, so a talk already on a CV when it was
// first linked would never be counted, and the leaderboard is about what the year holds, not what
// AdminBot happened to notice.

import type { AdminBotCvEntry, AdminBotLabMember } from "../../contracts/actions.js";
import { adminBotIsAlumniMember } from "../../contracts/actions.js";

export type AdminBotTalkLeaderboardRow = {
  // 1-based, shared by members level on both counts (1, 1, 3), so the doc and the page read ties
  // the same way.
  rank: number;
  member_id: string;
  member_name: string;
  // Of `total`, the talks the CV presents as invited: an invited talk, keynote, seminar, colloquium,
  // panel or guest lecture the member was asked to give.
  invited: number;
  // Of `total`, oral and spotlight presentations of the member's own papers.
  orals: number;
  // Every talk and oral dated this year: invited, contributed, oral, spotlight, and talks the model
  // could not classify. This is what the board ranks on.
  total: number;
};

export type AdminBotTalkLeaderboard = {
  year: number;
  rows: AdminBotTalkLeaderboardRow[];
  // Current members with a CV link whose CV has never been read, so the reader knows the board
  // is missing them rather than assuming they gave no talks.
  unscanned: string[];
  // The same members, each with why their CV is unread, so the fix lands with the right person.
  unread: AdminBotTalkLeaderboardUnread[];
};

/**
 * Why a linked CV has not been read:
 * - not_pdf: the link opens a web page or a sign-in screen, not a PDF anyone can download
 * - refused: the site answered the download with an error (LinkedIn and the like)
 * - failed: the download or the reading broke; the next daily read tries again
 * - pending: no daily read has tried it yet
 */
export type AdminBotCvUnreadReason = "not_pdf" | "refused" | "failed" | "pending";

export type AdminBotTalkLeaderboardUnread = {
  member_name: string;
  reason: AdminBotCvUnreadReason;
};

/** Sorts a failed read's reason into what the member has to do about it. */
export function classifyCvReadFailure(reason: string | undefined): AdminBotCvUnreadReason {
  if (!reason) {
    return "failed";
  }
  if (/did not return a PDF/u.test(reason)) {
    return "not_pdf";
  }
  if (/^cv download failed with [0-9]+/u.test(reason) || /must use https/u.test(reason)) {
    return "refused";
  }
  return "failed";
}

const YEAR = /\b((?:19|20)\d{2})\b/u;
// Counting is deliberately generous: the lab would rather credit a talk the model filed oddly than
// leave someone off the board. A paper the CV marks as an oral or spotlight was presented on stage,
// so it counts as a talk even though the model filed it as a publication.
const ORAL = /\b(?:oral|spotlight|plenary)\b/iu;
const INVITED =
  /\b(?:invited|keynote|seminar|colloquium|panel(?:ist)?|guest lecture|distinguished lecture)\b/iu;
const TALK_LIKE =
  /\b(?:talk|keynote|seminar|colloquium|panel(?:ist)?|lecture|oral|spotlight|presentation|presented|tutorial)\b/iu;

/** The year a talk was given: the normalized date, else the printed one, else a year in the venue. */
function talkYear(entry: AdminBotCvEntry): number | undefined {
  for (const raw of [entry.start_iso, entry.start, entry.organization]) {
    const match = YEAR.exec(raw ?? "");
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

type Counted = { invited: boolean; oral: boolean };

/** How an entry counts toward the board, or undefined when it is not a talk at all. */
function countTalk(entry: AdminBotCvEntry): Counted | undefined {
  const text = `${entry.title} ${entry.organization}`;
  switch (entry.kind) {
    case "talk":
      // The model's reading wins when it gave one; when it did not, the CV's own words decide.
      return {
        invited: entry.invited ?? INVITED.test(text),
        oral: entry.invited !== true && ORAL.test(text),
      };
    case "publication":
    case "award":
      return ORAL.test(text) ? { invited: false, oral: true } : undefined;
    case "other":
      return TALK_LIKE.test(text)
        ? { invited: INVITED.test(text), oral: !INVITED.test(text) && ORAL.test(text) }
        : undefined;
    default:
      return undefined;
  }
}

// Keyed on the title alone, so a paper listed as an oral under Publications and again under Talks
// (often with a different venue string) counts once.
function talkKey(entry: AdminBotCvEntry): string {
  return entry.title
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function buildTalkLeaderboard(
  members: AdminBotLabMember[],
  year: number,
  // Member id -> why the last daily read failed for them, from that sweep's audit record.
  lastFailures: Record<string, AdminBotCvUnreadReason> = {},
): AdminBotTalkLeaderboard {
  const rows: AdminBotTalkLeaderboardRow[] = [];
  const unread: AdminBotTalkLeaderboardUnread[] = [];
  for (const member of members) {
    // Alumni and external collaborators are not in the running for the lab's perk.
    if (adminBotIsAlumniMember(member) || member.status === "external") {
      continue;
    }
    if (!member.cv_snapshot) {
      if (member.cv_url?.trim()) {
        unread.push({ member_name: member.name, reason: lastFailures[member.id] ?? "pending" });
      }
      continue;
    }
    // The same talk listed twice counts once, with the more generous reading of each flag.
    const talks = new Map<string, Counted>();
    for (const entry of member.cv_snapshot.entries) {
      if (talkYear(entry) !== year) {
        continue;
      }
      const counted = countTalk(entry);
      const key = talkKey(entry);
      if (!counted || !key) {
        continue;
      }
      const seen = talks.get(key);
      talks.set(key, {
        invited: counted.invited || seen?.invited === true,
        oral: counted.oral || seen?.oral === true,
      });
    }
    if (!talks.size) {
      continue;
    }
    const values = [...talks.values()];
    rows.push({
      rank: 0,
      member_id: member.id,
      member_name: member.name,
      invited: values.filter((talk) => talk.invited).length,
      // A talk both invited and oral is shown once, as invited.
      orals: values.filter((talk) => talk.oral && !talk.invited).length,
      total: talks.size,
    });
  }
  rows.sort(
    (a, b) =>
      b.total - a.total || b.invited - a.invited || a.member_name.localeCompare(b.member_name),
  );
  // Ranked after sorting: a member level with the one above takes their rank, else their position.
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    row.rank =
      previous && previous.total === row.total && previous.invited === row.invited
        ? previous.rank
        : index + 1;
  });
  const sorted = unread.toSorted((a, b) => a.member_name.localeCompare(b.member_name));
  return { year, rows, unscanned: sorted.map((entry) => entry.member_name), unread: sorted };
}

/** The board as a markdown section for the CV Updates doc. */
export function renderTalkLeaderboardMarkdown(board: AdminBotTalkLeaderboard): string[] {
  const lines = [`## Talks and orals ${board.year}`, ""];
  if (!board.rows.length) {
    lines.push(`No talks dated ${board.year} on any scanned CV yet.`, "");
  } else {
    lines.push(
      "Counted from each member's linked CV once a day: invited and contributed talks, orals and spotlights. Ranked by all talks, then invited ones.",
      "",
    );
    for (const row of board.rows) {
      // Bullets with the rank in the text, because a markdown ordered list renumbers 1, 1 as 1, 2.
      const parts = [
        row.invited ? `${row.invited} invited` : "",
        row.orals ? `${row.orals} oral${row.orals === 1 ? "" : "s"}` : "",
        row.total - row.invited - row.orals ? `${row.total - row.invited - row.orals} other` : "",
      ].filter(Boolean);
      lines.push(
        `- #${row.rank} **${row.member_name}** — ${row.total} talk${row.total === 1 ? "" : "s"} (${parts.join(", ")})`,
      );
    }
    lines.push("");
  }
  for (const [reason, label] of UNREAD_LABELS) {
    const names = board.unread
      .filter((entry) => entry.reason === reason)
      .map((entry) => entry.member_name);
    if (names.length) {
      lines.push(`_Not counted yet, ${label}: ${names.join(", ")}._`, "");
    }
  }
  return lines;
}

const UNREAD_LABELS: Array<[AdminBotCvUnreadReason, string]> = [
  ["not_pdf", "CV link does not open a PDF anyone with the link can download"],
  ["refused", "CV site refuses downloads, so link a PDF instead"],
  ["failed", "CV could not be read, will retry at the next daily read"],
  ["pending", "CV not read yet"],
];
