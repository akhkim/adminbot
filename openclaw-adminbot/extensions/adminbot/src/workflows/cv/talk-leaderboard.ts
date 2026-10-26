// The lab's "number of invited talks this year" leaderboard, counted from members' scanned CVs.
//
// The guidebook's travel perk goes to the top of this list, and until now it was kept by hand in
// the meeting doc. It is counted from each member's current CV snapshot rather than from the change
// ledger: the ledger only holds what a scan saw *appear*, so a talk already on a CV when it was
// first linked would never be counted, and the leaderboard is about what the year holds, not what
// AdminBot happened to notice.

import type { AdminBotCvEntry, AdminBotLabMember } from "../../contracts/actions.js";
import { adminBotIsAlumniMember, cvEntryKey } from "../../contracts/actions.js";

export type AdminBotTalkLeaderboardRow = {
  member_id: string;
  member_name: string;
  // Talks the CV marks as invited (invited talk, keynote, seminar or panel the member was asked to
  // give). This is the number the guidebook ranks on.
  invited: number;
  // Every talk dated this year, invited or not -- contributed talks, oral presentations of the
  // member's own paper, and talks the model could not classify.
  total: number;
};

export type AdminBotTalkLeaderboard = {
  year: number;
  rows: AdminBotTalkLeaderboardRow[];
  // Current members with a CV link whose CV has never been read, so the reader knows the board
  // is missing them rather than assuming they gave no talks.
  unscanned: string[];
};

const YEAR = /\b((?:19|20)\d{2})\b/u;

/** The year a talk was given, from the normalized date when there is one, else as printed. */
function talkYear(entry: AdminBotCvEntry): number | undefined {
  const raw = entry.start_iso ?? entry.start ?? "";
  const match = YEAR.exec(raw);
  return match ? Number(match[1]) : undefined;
}

export function buildTalkLeaderboard(
  members: AdminBotLabMember[],
  year: number,
): AdminBotTalkLeaderboard {
  const rows: AdminBotTalkLeaderboardRow[] = [];
  const unscanned: string[] = [];
  for (const member of members) {
    // Alumni and external collaborators are not in the running for the lab's perk.
    if (adminBotIsAlumniMember(member) || member.status === "external") {
      continue;
    }
    if (!member.cv_snapshot) {
      if (member.cv_url?.trim()) {
        unscanned.push(member.name);
      }
      continue;
    }
    // A CV that lists the same talk twice (under "Talks" and again under "Invited talks") counts
    // it once, and the invited reading wins.
    const talks = new Map<string, boolean>();
    for (const entry of member.cv_snapshot.entries) {
      if (entry.kind !== "talk" || talkYear(entry) !== year) {
        continue;
      }
      const key = cvEntryKey(entry);
      talks.set(key, talks.get(key) === true || entry.invited === true);
    }
    if (!talks.size) {
      continue;
    }
    rows.push({
      member_id: member.id,
      member_name: member.name,
      invited: [...talks.values()].filter(Boolean).length,
      total: talks.size,
    });
  }
  rows.sort(
    (a, b) =>
      b.invited - a.invited || b.total - a.total || a.member_name.localeCompare(b.member_name),
  );
  return { year, rows, unscanned: unscanned.toSorted((a, b) => a.localeCompare(b)) };
}

/** The board as a markdown section for the CV Updates doc. */
export function renderTalkLeaderboardMarkdown(board: AdminBotTalkLeaderboard): string[] {
  const lines = [`## Invited talks ${board.year}`, ""];
  if (!board.rows.length) {
    lines.push(`No talks dated ${board.year} on any scanned CV yet.`, "");
  } else {
    lines.push(
      "Counted from each member's linked CV once a day. Ranked by invited talks, then all talks.",
      "",
    );
    let rank = 0;
    let previous: AdminBotTalkLeaderboardRow | undefined;
    board.rows.forEach((row, index) => {
      // Ties share a rank, so two people level on the count read as level on the page. Written as
      // bullets with the rank in the text because a markdown ordered list renumbers 1, 1 as 1, 2.
      if (!previous || previous.invited !== row.invited || previous.total !== row.total) {
        rank = index + 1;
      }
      previous = row;
      const other = row.total - row.invited;
      lines.push(
        `- #${rank} **${row.member_name}** — ${row.invited} invited${other ? ` (+${other} other)` : ""}`,
      );
    });
    lines.push("");
  }
  if (board.unscanned.length) {
    lines.push(`_Not counted yet (CV not read): ${board.unscanned.join(", ")}._`, "");
  }
  return lines;
}
