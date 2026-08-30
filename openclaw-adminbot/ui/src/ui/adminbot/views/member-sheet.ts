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
//
// It is drawn the way the Lab Members grid is: one scroller that pans by dragging, a sticky
// heading row, and the identifying columns pinned on the left so a row still says who it is
// thirty columns in. Every column the sheet holds is shown, in the sheet's own order after the
// few worth reading first, and a column with no heading is named by its letter rather than
// hidden -- the roster has such columns, and they hold data.
import { html, nothing } from "lit";
import type { AppViewState } from "../../app-view-state.ts";
import { memberSheetCellKey } from "../controllers/member-sheet.ts";
import { startSheetPan } from "./sheet-pan.ts";

/** Columns worth showing first; the rest follow in sheet order. */
const LEADING_HEADERS = [
  "Name",
  "Member Type",
  "Test Onboard",
  "Member Attributes",
  "Email for correspondence (the more professional the better)",
  "Slack email",
];

/** Google's own lettering: column 0 is A, column 26 is AA. */
export function columnLetter(index: number): string {
  let remaining = index;
  let letters = "";
  do {
    letters = String.fromCharCode(65 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return letters;
}

/**
 * The column that says who a row is.
 *
 * The roster's first heading cell is blank -- the names sit under an unlabeled column A -- so
 * looking for "Name" finds nothing and the grid used to treat the name like any other column.
 * Column A is the name column unless a heading says otherwise.
 */
export function nameColumn(header: readonly string[]): number {
  const named = header.indexOf("Name");
  return named >= 0 ? named : 0;
}

export function columnOrder(header: readonly string[]): number[] {
  const name = nameColumn(header);
  const leading = [
    name,
    ...LEADING_HEADERS.map((label) => header.indexOf(label)).filter(
      (index) => index >= 0 && index !== name,
    ),
  ];
  const rest = header.map((_, index) => index).filter((index) => !leading.includes(index));
  return [...leading, ...rest];
}

/** What a column is called on the page: its heading, or its letter when the heading is blank. */
export function columnLabel(header: readonly string[], column: number): string {
  const heading = header[column]?.trim();
  return heading || `Column ${columnLetter(column)}`;
}

/**
 * A rough width for a column from what it holds, so a "tldr" column is wide and a "Twitter"
 * handle is not. Bounded on both ends: the heading alone should stay readable, and a notes
 * column full of paragraphs must not take the whole viewport.
 */
function columnWidth(
  header: readonly string[],
  rows: readonly { cells: string[] }[],
  column: number,
): number {
  const longest = rows.reduce(
    (max, row) => Math.max(max, (row.cells[column] ?? "").length),
    columnLabel(header, column).length,
  );
  return Math.min(420, Math.max(120, longest * 7 + 24));
}

function cellValue(state: AppViewState, sheetRow: number, column: number, original: string): string {
  return state.memberSheetEdits?.[memberSheetCellKey(sheetRow, column)] ?? original;
}

/**
 * Rows the filter keeps. Matches against every cell, including pending edits, so a row an
 * operator has just retyped does not vanish from under them when it no longer matches its old
 * text.
 */
export function filterRows<Row extends { sheet_row: number; cells: string[] }>(
  rows: readonly Row[],
  filter: string | undefined,
  edits: Record<string, string> | undefined,
): Row[] {
  const needle = (filter ?? "").trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter((row) =>
    row.cells.some((cell, column) =>
      (edits?.[memberSheetCellKey(row.sheet_row, column)] ?? cell).toLowerCase().includes(needle),
    ),
  );
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

/**
 * What pressing "Queue" will do, shown before it is done.
 *
 * Onboarding automates real things -- one composed email per selected member, queued as an
 * approval-gated proposal -- and the only way to trust an automation is to read what it is about
 * to do. The mails here are the very ones confirming queues: same templates, same addresses,
 * same values, composed by the service on the same code path. Rows that would be skipped are
 * listed with their reasons, so "3 selected, 2 queued" is never a surprise.
 */
function renderOnboardPreview(state: AppViewState) {
  const preview = state.memberSheetOnboardPreview;
  if (!preview) {
    return nothing;
  }
  const busy = Boolean(state.memberSheetBusy);
  const planned = preview.planned;
  return html`
    <section class="adminbot-onboard-preview" data-testid="onboard-preview">
      <div class="adminbot-onboard-preview__head">
        <strong>Review before onboarding</strong>
        <span>
          ${planned.length === 0
            ? "Nothing would be queued for this selection."
            : `Confirming queues ${planned.length} email ${
                planned.length === 1 ? "proposal" : "proposals"
              } in Pending Actions. Nothing is sent until an admin approves them there.`}
        </span>
      </div>
      ${planned.map(
        (mail) => html`
          <details class="adminbot-onboard-preview__mail">
            <summary>
              <span class="adminbot-onboard-preview__who">
                Row ${mail.sheet_row} · ${mail.name || mail.email}
              </span>
              <span class="adminbot-onboard-preview__meta">${mail.template_id} → ${mail.email}</span>
            </summary>
            <dl class="adminbot-onboard-preview__fields">
              <dt>To</dt>
              <dd>${mail.email}</dd>
              <dt>Reply-To</dt>
              <dd>${mail.reply_to}</dd>
              <dt>Subject</dt>
              <dd>${mail.subject}</dd>
            </dl>
            <pre class="adminbot-onboard-preview__body">${mail.body}</pre>
          </details>
        `,
      )}
      ${preview.skipped.length > 0
        ? html`
            <div class="callout warning">
              <p>
                ${preview.skipped.length} of the selected
                ${preview.skipped.length === 1 ? "row" : "rows"} would be skipped:
              </p>
              <ul>
                ${preview.skipped.map(
                  (skip) => html`<li>Row ${skip.sheet_row}: ${skip.reason}</li>`,
                )}
              </ul>
            </div>
          `
        : nothing}
      <div class="adminbot-onboard-preview__actions">
        <button
          class="btn primary"
          type="button"
          data-testid="onboard-confirm"
          ?disabled=${busy || planned.length === 0}
          @click=${() => void state.onboardSelectedMemberRows?.()}
        >
          ${planned.length === 0
            ? "Nothing to queue"
            : `Queue ${planned.length} ${planned.length === 1 ? "email" : "emails"} for approval`}
        </button>
        <button
          class="btn"
          type="button"
          data-testid="onboard-preview-cancel"
          ?disabled=${busy}
          @click=${() => {
            state.memberSheetOnboardPreview = null;
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  `;
}

/**
 * Before the sheet has been read. The tab reads it on open, so this is normally a moment of
 * "Reading…"; the button is for the failure case, where the read is worth a second try without
 * reloading the console.
 */
function renderEmpty(state: AppViewState, busy: boolean) {
  return html`
    <section class="adminbot-member-sheet adminbot-member-roster">
      <header class="adminbot-member-sheet__header">
        <h3>Member roster</h3>
        <button type="button" ?disabled=${busy} @click=${() => void state.loadMemberSheet?.()}>
          ${busy ? "Reading the sheet…" : state.memberSheetError ? "Try again" : "Load the sheet"}
        </button>
      </header>
      ${state.memberSheetError
        ? html`<div class="callout danger" role="alert">${state.memberSheetError}</div>`
        : html`<p class="adminbot-form__hint">
            ${busy
              ? "Reading the lab's spreadsheet from Google."
              : "The lab's own spreadsheet, live. Edits here are proposed for approval, not written straight to Google."}
          </p>`}
    </section>
  `;
}

export function renderMemberSheet(state: AppViewState) {
  const sheet = state.memberSheet;
  const busy = Boolean(state.memberSheetBusy);
  const editCount = Object.keys(state.memberSheetEdits ?? {}).length;
  const selection = state.memberSheetSelection ?? [];

  if (!sheet) {
    return renderEmpty(state, busy);
  }

  const order = columnOrder(sheet.header);
  const name = nameColumn(sheet.header);
  const widths = new Map(order.map((column) => [column, columnWidth(sheet.header, sheet.rows, column)]));
  const visible = filterRows(sheet.rows, state.memberSheetFilter, state.memberSheetEdits);
  const filtered = visible.length !== sheet.rows.length;
  const visibleSelected = visible.filter((row) => selection.includes(row.sheet_row)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;

  const setSelection = (rows: Iterable<number>) => {
    state.memberSheetSelection = [...new Set(rows)].toSorted((a, b) => a - b);
  };

  return html`
    <section class="adminbot-member-sheet adminbot-member-roster">
      <header class="adminbot-member-roster__head">
        <div class="adminbot-member-roster__titles">
          <h3>Member roster</h3>
          <a href=${sheet.url} target="_blank" rel="noopener noreferrer">Open in Google Sheets</a>
        </div>
        <div class="adminbot-member-roster__actions">
          <button
            class="btn"
            type="button"
            ?disabled=${busy}
            @click=${() => void state.loadMemberSheet?.()}
          >
            ${busy ? "Working…" : "Reload"}
          </button>
          <button
            class="btn"
            type="button"
            ?disabled=${busy || editCount === 0}
            @click=${() => void state.saveMemberSheetEdits?.()}
          >
            ${editCount === 0
              ? "No changes"
              : `Propose ${editCount} ${editCount === 1 ? "change" : "changes"}`}
          </button>
          <button
            class="btn primary"
            type="button"
            data-testid="onboard-preview-open"
            ?disabled=${busy || selection.length === 0}
            @click=${() => void state.previewOnboardSelectedRows?.()}
          >
            ${selection.length === 0
              ? "Onboard…"
              : `Preview onboarding (${selection.length})`}
          </button>
        </div>
      </header>

      ${state.memberSheetError
        ? html`<div class="callout danger" role="alert">${state.memberSheetError}</div>`
        : nothing}
      ${renderConflicts(state)} ${renderOnboardResult(state)} ${renderOnboardPreview(state)}
      ${state.memberSheetSaveResult?.proposal
        ? html`<div class="callout success">
            Queued as a proposal in Pending Actions${state.memberSheetSaveResult.touches_access
              ? ", including an access column — an admin has to approve it before it reaches the sheet."
              : ". Nothing is written until it is approved."}
          </div>`
        : nothing}

      <form class="adminbot-member-filters" @submit=${(event: Event) => event.preventDefault()}>
        <label
          ><span>Search</span
          ><input
            name="search"
            type="search"
            placeholder="Any column…"
            .value=${state.memberSheetFilter ?? ""}
            @input=${(event: Event) => {
              state.memberSheetFilter = (event.target as HTMLInputElement).value;
            }}
        /></label>
        <span class="adminbot-member-roster__count" aria-live="polite">
          ${filtered
            ? `${visible.length} of ${sheet.rows.length} rows`
            : `${sheet.rows.length} rows`}
          · ${sheet.header.length} columns
        </span>
      </form>

      <div class="adminbot-member-sheet__scroll" @mousedown=${startSheetPan}>
        <table class="adminbot-member-roster__table">
          <colgroup>
            <col class="adminbot-member-roster__col-pick" />
            <col class="adminbot-member-roster__col-row" />
            ${order.map(
              (column) => html`<col style=${`width: ${widths.get(column)}px`} />`,
            )}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" class="adminbot-member-roster__pick">
                <input
                  type="checkbox"
                  aria-label=${filtered ? "Select every row shown" : "Select every row"}
                  .checked=${allVisibleSelected}
                  .indeterminate=${visibleSelected > 0 && !allVisibleSelected}
                  @change=${(event: Event) => {
                    const on = (event.target as HTMLInputElement).checked;
                    const shown = visible.map((row) => row.sheet_row);
                    setSelection(
                      on
                        ? [...selection, ...shown]
                        : selection.filter((row) => !shown.includes(row)),
                    );
                  }}
                />
              </th>
              <th scope="col" class="adminbot-member-roster__row">Row</th>
              ${order.map(
                (column) => html`
                  <th
                    scope="col"
                    class=${column === name ? "adminbot-member-roster__name" : ""}
                    title=${`Column ${columnLetter(column)}`}
                  >
                    ${columnLabel(sheet.header, column)}
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${visible.length === 0
              ? html`<tr>
                  <td colspan=${order.length + 2} class="adminbot-member-roster__none">
                    No rows match “${state.memberSheetFilter}”.
                  </td>
                </tr>`
              : nothing}
            ${visible.map(
              (row) => html`
                <tr class=${selection.includes(row.sheet_row) ? "is-selected" : ""}>
                  <td class="adminbot-member-roster__pick">
                    <input
                      type="checkbox"
                      aria-label=${`Onboard sheet row ${row.sheet_row}`}
                      .checked=${selection.includes(row.sheet_row)}
                      @change=${(event: Event) => {
                        const on = (event.target as HTMLInputElement).checked;
                        setSelection(
                          on
                            ? [...selection, row.sheet_row]
                            : selection.filter((picked) => picked !== row.sheet_row),
                        );
                      }}
                    />
                  </td>
                  <th scope="row" class="adminbot-member-roster__row">${row.sheet_row}</th>
                  ${order.map((column) => {
                    const original = row.cells[column] ?? "";
                    const edited = state.memberSheetEdits?.[
                      memberSheetCellKey(row.sheet_row, column)
                    ];
                    const classes = [
                      column === name ? "adminbot-member-roster__name" : "",
                      edited === undefined ? "" : "is-edited",
                    ]
                      .filter(Boolean)
                      .join(" ");
                    return html`
                      <td class=${classes}>
                        <input
                          type="text"
                          aria-label=${`${columnLabel(sheet.header, column)}, row ${row.sheet_row}`}
                          title=${edited === undefined ? "" : `Was: ${original}`}
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
        Read ${sheet.rows.length} rows and ${sheet.header.length} columns from “${sheet.tab}”. Drag
        the grid to pan. Edits become one approval item; onboarding shows each member's email for
        review first, and nothing is sent without approval in Pending Actions.
      </p>
    </section>
  `;
}
