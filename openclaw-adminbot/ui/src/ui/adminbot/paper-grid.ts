// Bulk link entry for people who own a lot of papers.
//
// Ten cards is ten expand-type-save cycles for what is, in the end, a table of URLs. Past that
// the per-paper card stops being the better surface, so this replaces it with a grid: one row
// per paper, one column per link slot, one Save.
//
// It is deliberately NOT a Google Sheet embed. The Control UI's CSP is `default-src 'self'`
// with no frame-src (src/gateway/control/control-ui-csp.ts), so a docs.google.com iframe is
// blocked outright -- and even unblocked it would be a silo, since nothing typed into Google's
// frame can reach adminbot_papers. What people actually want from "a spreadsheet" is the
// paste: keep your real sheet, select a block, Ctrl+V here. That is the feature below.
//
// Validation is per cell and advisory: a bad URL in row 7 marks row 7 and still lets the other
// fourteen rows save. Refusing the whole batch over one typo is how people learn to avoid the
// bulk tool.

import { html, nothing, type TemplateResult } from "lit";
import type { AdminBotPaperRecord, AdminBotPaperSaveInput } from "./controllers/admin.ts";
import type { AdminBotPaperStep } from "../../../../extensions/adminbot/src/contracts/actions.js";

/** Above this many papers the grid is offered. Below it, the cards are the better surface. */
export const PAPER_GRID_THRESHOLD = 10;

type ArtifactKey = NonNullable<AdminBotPaperRecord["artifacts"]>;

type Column = {
  /** Key on the stored `artifacts` object. */
  key: keyof ArtifactKey | "arxiv_paper_password";
  /** Key on the save input. Absent means the backend cannot persist it yet. */
  save?: keyof AdminBotPaperSaveInput;
  label: string;
  short: string;
  hosts?: string[];
  path?: RegExp;
  /** Not a URL — validated by pattern instead. */
  pattern?: RegExp;
  hint?: string;
};

// Columns follow the slot registry in fields_update.md. `arxiv_paper_password` is listed
// because the layout is part of the design being reviewed, but it has no field on the record
// yet, so it is rendered disabled rather than accepting text this UI would then drop.
const COLUMNS: Column[] = [
  {
    key: "brainstorming_doc_url",
    save: "brainstormingDocUrl",
    label: "Project doc / folder",
    short: "Project",
    hosts: ["docs.google.com", "drive.google.com"],
    hint: "A doc or a Drive folder",
  },
  {
    key: "overleaf_view_url",
    save: "overleafViewUrl",
    label: "Overleaf (view)",
    short: "Overleaf view",
    hosts: ["overleaf.com", "www.overleaf.com"],
  },
  {
    key: "overleaf_edit_url",
    save: "overleafEditUrl",
    label: "Overleaf (edit)",
    short: "Overleaf edit",
    hosts: ["overleaf.com", "www.overleaf.com"],
  },
  { key: "submission_url", save: "submissionUrl", label: "Submission", short: "Submission" },
  {
    key: "google_drive_pdf_url",
    save: "googleDrivePdfUrl",
    label: "Drive PDF (arXiv version)",
    short: "Drive PDF",
    hosts: ["drive.google.com", "docs.google.com"],
  },
  {
    key: "arxiv_url",
    save: "arxivUrl",
    label: "arXiv",
    short: "arXiv",
    hosts: ["arxiv.org", "www.arxiv.org"],
    path: /^\/abs\//u,
    hint: "The /abs/ page, not the PDF",
  },
  {
    key: "arxiv_paper_password",
    label: "arXiv paper password",
    short: "arXiv pw",
    pattern: /^[A-Za-z0-9]{6}$/u,
    hint: "Six characters, letters and digits — waiting on the backend field",
  },
  {
    key: "google_slides_url",
    save: "googleSlidesUrl",
    label: "Slides",
    short: "Slides",
    hosts: ["docs.google.com"],
    path: /^\/presentation\//u,
  },
  { key: "poster_url", save: "posterUrl", label: "Poster", short: "Poster" },
];

export type PaperGridEdits = Map<string, Map<string, string>>;

export type PaperGridState = {
  /** paperId -> column key -> typed value. Only what the user actually changed. */
  edits: PaperGridEdits;
  saving: boolean;
  notice: string;
  showHistory: boolean;
  history: PaperGridHistoryEntry[];
};

export function emptyPaperGridState(): PaperGridState {
  return {
    edits: new Map(),
    saving: false,
    notice: "",
    showHistory: false,
    history: loadHistory(),
  };
}

/** What is currently in a cell: the pending edit if there is one, else what is stored. */
export function cellValue(
  state: PaperGridState,
  paper: AdminBotPaperRecord,
  column: Column,
): string {
  const edited = state.edits.get(paper.id)?.get(String(column.key));
  if (edited !== undefined) {
    return edited;
  }
  const artifacts = paper.artifacts as Record<string, string | undefined> | undefined;
  return artifacts?.[String(column.key)] ?? "";
}

/**
 * Why a cell is not acceptable, or undefined when it is.
 *
 * Shape only, never a liveness check — the same rule the service applies to member profile
 * links, and for the same reason: verifying a URL resolves means an outbound fetch driven by
 * whatever someone pasted.
 */
export function cellError(column: Column, raw: string): string | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined; // empty clears the link; nothing is required here
  }
  if (column.pattern) {
    return column.pattern.test(value) ? undefined : "must be 6 letters/digits";
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") {
    return "must be https";
  }
  if (column.hosts && !column.hosts.includes(url.hostname)) {
    return `expected ${column.hosts[0]}`;
  }
  if (column.path && !column.path.test(url.pathname)) {
    return column.hint ?? "wrong kind of link";
  }
  return undefined;
}

function setEdit(state: PaperGridState, paperId: string, key: string, value: string): void {
  const row = state.edits.get(paperId) ?? new Map<string, string>();
  row.set(key, value);
  state.edits.set(paperId, row);
}

/**
 * Spread a clipboard block across the grid, starting at the pasted cell.
 *
 * Google Sheets, Excel and Numbers all put tab-separated rows on the clipboard, so one parser
 * covers every source someone is likely to be copying from.
 */
export function applyPaste(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
  startRow: number,
  startColumn: number,
  clipboard: string,
): number {
  const rows = clipboard.replace(/\r\n?/gu, "\n").replace(/\n$/u, "").split("\n");
  let filled = 0;
  rows.forEach((line, rowOffset) => {
    const paper = papers[startRow + rowOffset];
    if (!paper) {
      return; // pasted more rows than there are papers; the extra rows are dropped
    }
    line.split("\t").forEach((cell, columnOffset) => {
      const column = COLUMNS[startColumn + columnOffset];
      if (!column || !column.save) {
        return; // past the last column, or a column the backend cannot store yet
      }
      setEdit(state, paper.id, String(column.key), cell.trim());
      filled += 1;
    });
  });
  return filled;
}

/** The rows that actually changed, as save inputs. Unchanged papers are not re-sent. */
export function pendingSaves(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
): AdminBotPaperSaveInput[] {
  const out: AdminBotPaperSaveInput[] = [];
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row || row.size === 0) {
      continue;
    }
    const input: AdminBotPaperSaveInput = {
      id: paper.id,
      title: paper.title,
      authors: paper.authors ?? [],
      currentStep: paper.current_step as AdminBotPaperStep,
    };
    let touched = false;
    for (const column of COLUMNS) {
      if (!column.save) {
        continue;
      }
      const value = row.get(String(column.key));
      if (value === undefined || cellError(column, value)) {
        continue; // a cell that fails validation is left behind, not saved as garbage
      }
      (input as Record<string, unknown>)[column.save] = value.trim();
      touched = true;
    }
    if (touched) {
      out.push(input);
    }
  }
  return out;
}

// ── change history ───────────────────────────────────────────────────────────────────────
//
// Kept in localStorage rather than on the record, because there is no audit surface for paper
// artifacts yet -- the service stores the current value and nothing about how it got there.
// That makes this a per-browser log, not a lab-wide one, and it is labelled as such in the UI
// so nobody mistakes it for the audit trail. When the backend grows a slot history (see
// `provided_by_member_id` / `provided_at` in fields_update.md) this should read from there.

const HISTORY_KEY = "openclaw.adminbot.papergrid.history.v1";
const HISTORY_LIMIT = 30;

export type PaperGridHistoryEntry = {
  at: string;
  paperTitle: string;
  column: string;
  from: string;
  to: string;
  kind: "added" | "changed" | "cleared";
};

function safeStorage(): Storage | null {
  try {
    // Presence is not enough: test environments and some embedded browsers expose a
    // `localStorage` object whose methods are missing, so the methods are checked too.
    const storage = typeof localStorage === "undefined" ? null : localStorage;
    return typeof storage?.setItem === "function" && typeof storage.getItem === "function"
      ? storage
      : null;
  } catch {
    return null; // Safari private mode throws on access rather than returning null
  }
}

export function loadHistory(): PaperGridHistoryEntry[] {
  try {
    const raw = safeStorage()?.getItem(HISTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as PaperGridHistoryEntry[]).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Newest first, capped. Returns the stored list so the caller can render without re-reading. */
export function recordHistory(entries: PaperGridHistoryEntry[]): PaperGridHistoryEntry[] {
  const merged = [...entries, ...loadHistory()].slice(0, HISTORY_LIMIT);
  try {
    safeStorage()?.setItem(HISTORY_KEY, JSON.stringify(merged));
  } catch {
    // A full or unavailable storage must not cost the user their save.
  }
  return merged;
}

export function clearHistory(): void {
  try {
    safeStorage()?.removeItem(HISTORY_KEY);
  } catch {
    // ignore
  }
}

/**
 * What changed, comparing each pending edit against what is stored.
 *
 * Computed before the save is sent, because afterwards the record holds the new value and the
 * old one is gone.
 */
export function diffForHistory(
  state: PaperGridState,
  papers: AdminBotPaperRecord[],
): PaperGridHistoryEntry[] {
  const at = new Date().toISOString();
  const out: PaperGridHistoryEntry[] = [];
  for (const paper of papers) {
    const row = state.edits.get(paper.id);
    if (!row) {
      continue;
    }
    for (const column of COLUMNS) {
      if (!column.save) {
        continue;
      }
      const typed = row.get(String(column.key));
      if (typed === undefined || cellError(column, typed)) {
        continue;
      }
      const artifacts = paper.artifacts as Record<string, string | undefined> | undefined;
      const before = (artifacts?.[String(column.key)] ?? "").trim();
      const after = typed.trim();
      if (before === after) {
        continue;
      }
      out.push({
        at,
        paperTitle: paper.title,
        column: column.label,
        from: before,
        to: after,
        kind: !before ? "added" : !after ? "cleared" : "changed",
      });
    }
  }
  return out;
}

/** One line of plain English per entry. */
export function describeHistory(entry: PaperGridHistoryEntry): string {
  if (entry.kind === "added") {
    return `You added ${entry.column}: ${entry.to}`;
  }
  if (entry.kind === "cleared") {
    return `You cleared ${entry.column} (was ${entry.from})`;
  }
  return `You changed ${entry.column} from ${entry.from} to ${entry.to}`;
}

function formatWhen(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return "";
  }
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(then).toLocaleDateString();
}

export type PaperGridProps = {
  state: PaperGridState;
  papers: AdminBotPaperRecord[];
  onChange: () => void;
  onSaveAll: (inputs: AdminBotPaperSaveInput[]) => void;
  onExit: () => void;
};

export function renderPaperGrid(props: PaperGridProps): TemplateResult {
  const { state, papers } = props;
  const changedRows = new Set(
    [...state.edits.entries()].filter(([, row]) => row.size > 0).map(([id]) => id),
  ).size;
  const errorCount = papers.reduce(
    (total, paper) =>
      total +
      COLUMNS.filter((column) => cellError(column, cellValue(state, paper, column))).length,
    0,
  );

  return html`
    <div class="paper-grid">
      <div class="paper-grid__bar">
        <div>
          <strong>Bulk link entry</strong>
          <span class="paper-grid__muted">
            ${papers.length} papers · ${changedRows} changed${errorCount
              ? html` · <span class="paper-grid__warn">${errorCount} cell(s) need a look</span>`
              : nothing}
          </span>
        </div>
        <div class="paper-grid__tools">
          <button
            type="button"
            class="btn primary"
            ?disabled=${state.saving || changedRows === 0}
            @click=${() => props.onSaveAll(pendingSaves(state, papers))}
          >
            ${state.saving ? "Saving…" : `Update ${changedRows || ""}`.trim()}
          </button>
          <button
            type="button"
            class="btn btn--sm"
            @click=${() => {
              state.showHistory = !state.showHistory;
              state.history = loadHistory();
              props.onChange();
            }}
          >
            History${state.history.length ? ` (${state.history.length})` : ""}
          </button>
          <button type="button" class="btn btn--sm" @click=${props.onExit}>Back to cards</button>
        </div>
      </div>

      ${state.notice ? html`<p class="paper-grid__notice">${state.notice}</p>` : nothing}

      ${state.showHistory
        ? html`<div class="paper-grid__history">
            <div class="paper-grid__history-head">
              <strong>Recent changes</strong>
              <span class="paper-grid__muted">last ${HISTORY_LIMIT}, this browser only</span>
              <button
                type="button"
                class="btn btn--sm"
                ?disabled=${state.history.length === 0}
                @click=${() => {
                  clearHistory();
                  state.history = [];
                  props.onChange();
                }}
              >
                Clear
              </button>
            </div>
            ${state.history.length
              ? html`<ol class="paper-grid__history-list">
                  ${state.history.map(
                    (entry) => html`<li>
                      <span class="paper-grid__history-when">${formatWhen(entry.at)}</span>
                      <span class="paper-grid__history-paper">${entry.paperTitle}</span>
                      <span>${describeHistory(entry)}</span>
                    </li>`,
                  )}
                </ol>`
              : html`<p class="paper-grid__hint">
                  Nothing yet — changes are logged when you press Update.
                </p>`}
          </div>`
        : nothing}

      <div class="paper-grid__scroll">
        <table class="paper-grid__table">
          <thead>
            <tr>
              <th scope="col" class="paper-grid__rownum"></th>
              <th scope="col" class="paper-grid__sticky">Paper</th>
              ${COLUMNS.map(
                (column) => html`
                  <th scope="col" title=${column.hint ?? column.label}>
                    ${column.short}${column.save
                      ? nothing
                      : html`<span class="paper-grid__pending" title="No backend field yet">
                          ◦
                        </span>`}
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${papers.map(
              (paper, rowIndex) => html`
                <tr>
                  <td class="paper-grid__rownum">${rowIndex + 1}</td>
                  <th
                    scope="row"
                    class="paper-grid__sticky"
                    tabindex="0"
                    title=${paper.title}
                  >
                    <span class="paper-grid__title">${paper.title}</span>
                  </th>
                  ${COLUMNS.map((column, columnIndex) => {
                    const value = cellValue(state, paper, column);
                    const error = cellError(column, value);
                    return html`
                      <td class=${error ? "paper-grid__cell--bad" : ""}>
                        <div class="paper-grid__cell">
                        <input
                          type="text"
                          .value=${value}
                          ?disabled=${!column.save}
                          title=${error ?? column.label}
                          data-row=${rowIndex}
                          data-col=${columnIndex}
                          @input=${(event: Event) => {
                            setEdit(
                              state,
                              paper.id,
                              String(column.key),
                              (event.target as HTMLInputElement).value,
                            );
                          }}
                          @blur=${() => props.onChange()}
                          @paste=${(event: ClipboardEvent) => {
                            const text = event.clipboardData?.getData("text/plain") ?? "";
                            // A single cell with no tabs or newlines is an ordinary paste; let
                            // the browser handle it so undo keeps working.
                            if (!text.includes("\t") && !text.includes("\n")) {
                              return;
                            }
                            event.preventDefault();
                            const filled = applyPaste(
                              state,
                              papers,
                              rowIndex,
                              columnIndex,
                              text,
                            );
                            state.notice = `Pasted ${filled} cell(s). Nothing is saved until you press Update.`;
                            props.onChange();
                          }}
                        />
                        </div>
                      </td>
                    `;
                  })}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>

      <p class="paper-grid__hint">
        <span class="paper-grid__pending">◦</span> waiting on a backend field — see
        <code>fields_update.md</code>. Saving sends one request per changed paper today; a
        <code>PATCH /papers/bulk</code> endpoint would make it one.
      </p>
    </div>
  `;
}
