// Does the hand-written access matrix still say what the spreadsheet says?
//
// `collaborator-subgroups.ts` is a transcription of the "External Collab Access Design" sheet,
// and a transcription is a copy that is free to fall out of step with its original. The lab has
// been bitten by exactly this before: the mandatory-profile-field list existed twice, the two
// copies disagreed from the day they were written, and members were chased for fields the page
// called optional. The fix there was one shared list; that is not available here, because the
// original is an .xlsx on somebody's laptop. So the next best thing is a test that fails the
// moment the copy drifts.
//
// The fixture side is generated -- see scripts/adminbot-contact-roster-collect.py. Regenerate it
// when the sheet changes, and this test says whether the code needs to move too.

import { describe, expect, it } from "vitest";
import { adminBotExternalCollaboratorSubgroups } from "../../contracts/actions.js";
import {
  adminBotCollaboratorAccessCells,
  adminBotCollaboratorAccessItems,
  collaboratorSubgroupAccess,
  type AdminBotCollaboratorAccessItemId,
} from "./collaborator-subgroups.js";
import { CONTACT_ACCESS_MATRIX, CONTACT_SHEET_SUBGROUPS } from "./generated/contact-roster.js";

/**
 * Sheet row -> the access item that implements it.
 *
 * Matched by hand rather than by string similarity, because the sheet's wording is a sentence of
 * lab prose ("Issue a check condition: If they do not have main slack space, Link to Jinesis free
 * slack space...") and the code's label is a name ("Slack guest space check"). A fuzzy matcher
 * would pair those two correctly and then silently mispair the next one; a table is wrong loudly
 * or not at all.
 *
 * `null` means the lab has written down an access item that nothing implements yet. It is not a
 * failure -- the sheet is allowed to be ahead of the service -- but it has to be declared here, so
 * a row nobody noticed cannot pass as a row somebody decided to skip.
 */
const SHEET_ROW_TO_ITEM: ReadonlyArray<[string, AdminBotCollaboratorAccessItemId | null]> = [
  // The sheet asks for an onboarding email for seven of the ten subgroups. The service sends
  // onboarding mail through the membership sweeps rather than through the access matrix, so there
  // is no matrix row to compare against -- see chaseOpenOnboarding.
  ["onboarding email", null],
  [
    "If their profile should be in our Back-end spreadsheet in full details",
    "spreadsheet_full_details",
  ],
  [
    "In our back-end spreadsheet: we store their email, roughly tldr background (PhD, Prof, … intersecting with us for XX)",
    "spreadsheet_basic",
  ],
  ["welcome linkedin and twitter followings", "welcome_linkedin_twitter"],
  ["Welcome newsletter subscriptions + all other types of followings", "welcome_newsletter"],
  [
    "Send emails to confirm their time plan (i.e., let them use Luke’s function and share with Zhijing on slack or email)",
    "time_plan_confirmation_emails",
  ],
  ["Have AdminBot portal access", "adminbot_portal_access"],
  ["Trusted for lab private info", "trusted_lab_private_info"],
  [
    "Issue a check condition: If they do not have main slack space, Link to Jinesis free slack space for slack-guest-chat group in DCS with the interviewer and project collaborators they can chat with",
    "slack_guest_space_check",
  ],
  [
    "Join Jinesis #friends-and-collaborators… through Slack Connect",
    "slack_connect_friends_channel",
  ],
  ["Add them to #jinesis-active and #random-active both channels", "active_channels"],
  ["Slack-guest-chat with Zhijing & interviewer", "slack_guest_chat_zhijing"],
  ["Add to #discussion-xxx for joining the discussions on this broad topic", "discussion_channel"],
  [
    "Add to #proj-xxx channel so we can chat with this person on this specific project",
    "project_channel",
  ],
  [
    "Has access to our project-related google drive folder (Or create it if not exist)",
    "project_drive_folder",
  ],
  // New in the (2)/(3) revision of the sheet, and deliberately unmapped. This row is the two
  // standing invites -- the lab calendar and the Monday group meeting -- which are reconciled by
  // workflows/members/surface-membership.ts against `privilege_level` and the `coauthor_major`
  // subgroup, not by the collaborator access matrix. Adding a matrix row for it would give the
  // same decision two owners; `belongsOnSurface` is the one that already sends the invites.
  ["View access to lab calendar + invite to Monday Group Meeting", null],
  [
    "Add to slack channel #meeting-xxx for the weekly themed meeting, and also Wed themed meeting’s calendar invite. (Slack + calendar)\n\nWhoever that is on our calendar invite will be repeatedly reminded to use the Google Calendar app interface with alert, and ignore calendar related emails, due to all the complex time zones and spontaneous move of meetings.",
    "weekly_meeting",
  ],
  [
    "In our back-end spreadsheet, we need their Whatsapp + personal email (invariant to graduation) stored in our database (e.g., for paper resubmission)",
    "spreadsheet_whatsapp_personal_email",
  ],
  [
    "If newly joined (history less than 3 months), introduce More detailed google drive practice",
    "newcomer_drive_practice",
  ],
  [
    "compose stories for “What to Expect”. Handbook about the communication protocols",
    "what_to_expect_stories",
  ],
  [
    "Allow email triggers in the backend for “paper submission / resubmission”, “social media draft sharing”, etc.\n\nData structure: user_id + set of proj_id",
    "backend_email_triggers",
  ],
  [
    "auto share with Daniel the list of our “coauthor-major” and “full members” as a constantly updating spreadsheet with only each person’s name and UToronto email (or professional email address).\n\nIn this way, we suggest Daniel to look up the users in our spreadsheet whenever he needs to decide whether to extend or to remove our user.",
    "vector_roster_share",
  ],
  ["city-based dinner or team building invite", "city_dinner_invite"],
  [
    "Rec letter button on their profile (allowed only for those with a major-coauthor status or own-pace-advisee for over 3 months at any historical point)",
    "rec_letter_button",
  ],
];

/**
 * Cells where the code and the sheet disagree, and nobody has decided which is right yet.
 *
 * Empty, and worth keeping empty. It is not a suppression list: the test asserts this set is
 * *exactly* the current disagreement, so a cell that drifts fails immediately, and a drift that
 * gets resolved without its line being removed fails just as loudly. An entry here is a live
 * question for the lab, written down in the repo rather than living only in whoever last read the
 * spreadsheet.
 *
 * The three entries this started with were fixed by moving the code to the sheet: the
 * `active_channels` and `project_drive_folder` over-grants were removed, and the
 * `vector_roster_share` cell was transcribed. That last one leaves a question the matrix cannot
 * express -- see the comment on that item in collaborator-subgroups.ts, where the sheet's own row
 * text and its cell disagree with each other.
 */
const UNRESOLVED_DRIFT: ReadonlyArray<{
  item: AdminBotCollaboratorAccessItemId;
  subgroup: string;
  sheet: string;
  code: string;
  note: string;
}> = [];

/** The code matrix as a flat lookup, including rows that grant nothing. */
function codeMatrix(): Map<string, Map<string, string>> {
  const byItem = new Map<string, Map<string, string>>();
  for (const item of adminBotCollaboratorAccessItems) {
    byItem.set(item.id, new Map());
  }
  for (const subgroup of adminBotExternalCollaboratorSubgroups) {
    for (const grant of collaboratorSubgroupAccess(subgroup)) {
      byItem.get(grant.item)?.set(subgroup, grant.cell);
    }
  }
  return byItem;
}

describe("collaborator access matrix vs the lab's spreadsheet", () => {
  it("reads the same subgroup vocabulary as the contract", () => {
    // The sheet's ten columns and the contract's ten subgroups are the same ten, or every cell
    // comparison below is comparing the wrong pairs.
    expect([...CONTACT_SHEET_SUBGROUPS].toSorted()).toEqual(
      [...adminBotExternalCollaboratorSubgroups].toSorted(),
    );
  });

  it("maps every sheet row, and every mapped row exists in the code", () => {
    const sheetLabels = CONTACT_ACCESS_MATRIX.map((item) => item.label);
    const mappedLabels = SHEET_ROW_TO_ITEM.map(([label]) => label);
    // Order matters as much as membership: the mapping is positional in spirit, and a row
    // inserted into the sheet must not silently shift onto its neighbour's meaning.
    expect(mappedLabels).toEqual(sheetLabels);

    const known = new Set(adminBotCollaboratorAccessItems.map((item) => item.id));
    for (const [label, id] of SHEET_ROW_TO_ITEM) {
      if (id !== null) {
        expect(known, `sheet row ${label.slice(0, 40)}… maps to unknown item ${id}`).toContain(id);
      }
    }
  });

  it("names every code item that no sheet row maps to", () => {
    const mapped = new Set(SHEET_ROW_TO_ITEM.flatMap(([, id]) => (id ? [id] : [])));
    const unmapped = adminBotCollaboratorAccessItems
      .map((item) => item.id)
      .filter((id) => !mapped.has(id));
    // `google_file_practice_guide` is in the service and not on the current sheet. It is kept
    // because a row that vanishes from a spreadsheet is far more often an edit accident than a
    // decision to withdraw an access item -- but it is named here so it cannot quietly become
    // policy nobody wrote down.
    expect(unmapped).toEqual(["google_file_practice_guide"]);
  });

  it("only ever uses cell values the service models", () => {
    const vocabulary = new Set<string>(adminBotCollaboratorAccessCells);
    for (const item of CONTACT_ACCESS_MATRIX) {
      for (const [subgroup, cell] of Object.entries(item.cells)) {
        expect(vocabulary, `${item.label.slice(0, 30)}… / ${subgroup}`).toContain(cell);
      }
    }
  });

  it("matches the sheet cell for cell, apart from the drift that is written down", () => {
    const code = codeMatrix();
    const drift: Array<{ item: string; subgroup: string; sheet: string; code: string }> = [];
    for (const [index, [, id]] of SHEET_ROW_TO_ITEM.entries()) {
      if (id === null) {
        continue;
      }
      const sheetItem = CONTACT_ACCESS_MATRIX[index]!;
      const codeCells = code.get(id)!;
      for (const subgroup of adminBotExternalCollaboratorSubgroups) {
        const sheetCell = sheetItem.cells[subgroup] ?? "no";
        const codeCell = codeCells.get(subgroup) ?? "no";
        if (sheetCell !== codeCell) {
          drift.push({ item: id, subgroup, sheet: sheetCell, code: codeCell });
        }
      }
    }
    expect(drift.toSorted((a, b) => a.item.localeCompare(b.item))).toEqual(
      UNRESOLVED_DRIFT.map(({ item, subgroup, sheet, code: codeCell }) => ({
        item,
        subgroup,
        sheet,
        code: codeCell,
      })).toSorted((a, b) => a.item.localeCompare(b.item)),
    );
  });
});
