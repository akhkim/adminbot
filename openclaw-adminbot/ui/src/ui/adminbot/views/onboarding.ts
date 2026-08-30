// The Onboarding section of the Membership tab: the lab's member spreadsheet, and onboarding run
// from the rows in it.
//
// This used to carry a second, manual form -- template picker, name, email, one field per
// placeholder -- next to the roster. Every one of those fields is a column in the sheet, so the
// form asked an operator to retype what the row beside it already held, and the two could disagree
// about who was being onboarded. A person the sheet does not know about is added as a row, which is
// where the rest of AdminBot looks for them anyway.
//
// What went with it: the manual form was the only path that previewed the exact words before
// sending, and the only one that provisioned a Drive folder, minted a Slack Connect invite and
// filed the DCS account request as part of the send. Onboarding from the roster composes the same
// templates but queues each mail as an `email.send` proposal for approval instead, and a template
// whose copy references a link nobody has provisioned is skipped by name rather than half-sent.
import { html } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { renderMemberSheet } from "./member-sheet.ts";

export function renderAdminBotOnboarding(state: AppViewState) {
  return html`<section class="adminbot-onboarding">${renderMemberSheet(state)}</section>`;
}
