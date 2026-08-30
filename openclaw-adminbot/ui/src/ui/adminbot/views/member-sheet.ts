// The member roster, as an editable grid, at the top of the Onboarding tab.
//
// The lab already works in this spreadsheet, so this shows the live sheet rather than a copy of
// it: every open reads it again. Editing writes nothing directly. A save collects the changed
// cells into one `sheet.update_cells` proposal, which lands in Pending Actions with the old value
// beside the new one -- the roster is what the onboarding and nudge sweeps read, and the Member
// Type and address columns decide who can reach what, so a second pair of eyes is the point.
//
// Two people edit this sheet at once, so a conflict is an ordinary event rather than an error: a
// cell that changed in Google since the grid was drawn comes back with both values, and the tab
// keeps the operator's text so they can decide rather than losing what they typed.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { memberSheetCellKey } from "../controllers/member-sheet.ts";

/** Columns worth showing first; the rest follow in sheet order. */
const LEADING_HEADERS = [
  "Name",
  "Member Type",
  "Test Onboard",
  "Member Attributes",
  "Email for correspondence (the more professional the better)",
  "Slack email",
];

function columnOrder(header: readonly string[]): number[] {
  const leading = LEADING_HEADERS.map((name) => header.indexOf(name)).filter((index) => index >= 0);
  const rest = header.map((_, index) => index).filter((index) => !leading.includes(index));
  return [...leading, ...rest];
}

function cellValue(state: AppViewState, sheetRow: number, column: number, original: string): string {
  return state.memberSheetEdits?.[memberSheetCellKey(sheetRow, column)] ?? original;
}

function renderConflicts(state: AppViewState) {
  const conflicts = state.memberSheetSaveResult?.conflicts ?? [];
  if (conflicts.length === 0) {
    return nothing;
  }
  return html`
    <div class="callout warning" role="alert">
      <p>
        ${conflicts.length === 1 ? "One cell" : `${conflicts.length} cells`} changed in the sheet
        while this was open, so ${conflicts.length === 1 ? "it was" : "they were"} not written. Your
        text is still in the grid — reload to take theirs, or save again to keep yours.
      </p>
      <ul>
        ${conflicts.map(
          (conflict) => html`
            <li>
              Row ${conflict.sheet_row}, ${conflict.header || `column ${conflict.column}`}: you were
              editing “${conflict.expected}”, it now holds “${conflict.actual}”.
            </li>
          `,
        )}
      </ul>
    </div>
  `;
}

function renderOnboardResult(state: AppViewState) {
  const result = state.memberSheetOnboardResult;
  if (!result) {
    return nothing;
  }
  return html`
    <div class="callout ${result.created.length > 0 ? "success" : "warning"}">
      ${result.created.length > 0
        ? html`<p>
            Queued ${result.created.length}
            ${result.created.length === 1 ? "email" : "emails"} in Pending Actions. Nothing has been
            sent yet — approve them there.
          </p>`
        : nothing}
      ${result.skipped.length > 0
        ? html`
            <p>${result.skipped.length} not queued:</p>
            <ul>
              ${result.skipped.map(
                (skip) => html`<li>Row ${skip.sheet_row}: ${skip.reason}</li>`,
              )}
            </ul>
          `
        : nothing}
    </div>
  `;
}

export function renderMemberSheet(state: AppViewState) {
  const sheet = state.memberSheet;
  const busy = Boolean(state.memberSheetBusy);
  const editCount = Object.keys(state.memberSheetEdits ?? {}).length;
  const selection = state.memberSheetSelection ?? [];

  if (!sheet) {
    return html`
      <section class="adminbot-member-sheet">
        <header class="adminbot-member-sheet__header">
          <h3>Member roster</h3>
          <button type="button" ?disabled=${busy} @click=${() => void state.loadMemberSheet?.()}>
            ${busy ? "Loading…" : "Load the sheet"}
          </button>
        </header>
        ${state.memberSheetError
          ? html`<div class="callout danger" role="alert">${state.memberSheetError}</div>`
          : html`<p class="adminbot-form__hint">
              The lab's own spreadsheet, live. Edits here are proposed for approval, not written
              straight to Google.
            </p>`}
      </section>
    `;
  }

  const order = columnOrder(sheet.header);
  return html`
    <section class="adminbot-member-sheet">
      <header class="adminbot-member-sheet__header">
        <h3>Member roster</h3>
        <a href=${sheet.url} target="_blank" rel="noopener noreferrer">Open in Google Sheets</a>
        <button type="button" ?disabled=${busy} @click=${() => void state.loadMemberSheet?.()}>
          ${busy ? "Working…" : "Reload"}
        </button>
        <button
          type="button"
          ?disabled=${busy || editCount === 0}
          @click=${() => void state.saveMemberSheetEdits?.()}
        >
          ${editCount === 0
            ? "No changes"
            : `Propose ${editCount} ${editCount === 1 ? "change" : "changes"}`}
        </button>
        <button
          type="button"
          ?disabled=${busy || selection.length === 0}
          @click=${() => void state.onboardSelectedMemberRows?.()}
        >
          ${selection.length === 0
            ? "Select rows to onboard"
            : `Onboard ${selection.length} selected`}
        </button>
      </header>

      ${state.memberSheetError
        ? html`<div class="callout danger" role="alert">${state.memberSheetError}</div>`
        : nothing}
      ${renderConflicts(state)} ${renderOnboardResult(state)}
      ${state.memberSheetSaveResult?.proposal
        ? html`<div class="callout success">
            Queued as a proposal in Pending Actions${state.memberSheetSaveResult.touches_access
              ? ", including an access column — an admin has to approve it before it reaches the sheet."
              : ". Nothing is written until it is approved."}
          </div>`
        : nothing}

      <div class="adminbot-member-sheet__scroll">
        <table class="adminbot-member-sheet__table">
          <thead>
            <tr>
              <th scope="col"><span class="visually-hidden">Onboard</span></th>
              <th scope="col">Row</th>
              ${order.map((column) => html`<th scope="col">${sheet.header[column]}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${sheet.rows.map(
              (row) => html`
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      aria-label=${`Onboard sheet row ${row.sheet_row}`}
                      .checked=${selection.includes(row.sheet_row)}
                      @change=${(event: Event) => {
                        const on = (event.target as HTMLInputElement).checked;
                        const next = new Set(state.memberSheetSelection ?? []);
                        if (on) {
                          next.add(row.sheet_row);
                        } else {
                          next.delete(row.sheet_row);
                        }
                        state.memberSheetSelection = [...next].toSorted((a, b) => a - b);
                      }}
                    />
                  </td>
                  <th scope="row">${row.sheet_row}</th>
                  ${order.map((column) => {
                    const original = row.cells[column] ?? "";
                    const edited = state.memberSheetEdits?.[
                      memberSheetCellKey(row.sheet_row, column)
                    ];
                    return html`
                      <td class=${edited === undefined ? "" : "is-edited"}>
                        <input
                          type="text"
                          aria-label=${`${sheet.header[column]}, row ${row.sheet_row}`}
                          .value=${cellValue(state, row.sheet_row, column, original)}
                          @change=${(event: Event) =>
                            state.editMemberSheetCell?.(
                              row.sheet_row,
                              column,
                              (event.target as HTMLInputElement).value,
                            )}
                        />
                      </td>
                    `;
                  })}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      <p class="adminbot-form__hint">
        Read ${sheet.rows.length} rows from “${sheet.tab}”. Edits become one approval item; onboarding
        a selection queues one email each, and neither sends anything on its own.
      </p>
    </section>
  `;
}
