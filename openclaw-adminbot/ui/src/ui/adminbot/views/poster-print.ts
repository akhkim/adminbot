// Poster printing, from the two sides of one batch.
//
// <adminbot-poster-print-request> sits on a paper's Talk tab, next to the Poster row, and asks the
// first author the one question the batch needs from them: does this poster go in the lab's print
// run, and if so at what size, for which city. <adminbot-poster-print-batches> is the other side --
// the Poster printing view under Conference Papers -- where the printer and admins see one list
// per conference city, copy it, and mark it printed.
//
// Both fetch their own data, like <adminbot-collaborator-chats>: the batch is derived on the
// service from accepted papers, trips and the deadline dataset, so there is no client state worth
// sharing with the rest of the app, and each element reloads after its own writes.
import "../../../styles/poster-print.css";
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import {
  ADMINBOT_POSTER_PRINT_DEFAULTS_KEY,
  adminBotPosterOrientations,
  adminBotPosterPrintSizes,
  type AdminBotPosterOrientation,
  type AdminBotPosterPrintBatchInput,
  type AdminBotPosterPrintBatchRecord,
  type AdminBotPosterPrintBatchStatus,
  type AdminBotPosterPrintBatchView,
  type AdminBotPosterPrintChoice,
  type AdminBotPosterPrintOverview,
  type AdminBotPosterPrintPaper,
  type AdminBotPosterPrintPaperOptions,
  type AdminBotPosterPrintPaperState,
  type AdminBotPosterPrintRequestInput,
  type AdminBotPosterPrintRequestRecord,
  type AdminBotPosterPrintSize,
} from "../../../../../extensions/adminbot/src/contracts/poster-printing.js";
import { authedJson } from "../auth/session.ts";

type CallResult<T> = { ok: true; value: T } | { ok: false; message: string };

async function call<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "PUT" | "POST",
  token: string,
  payload?: unknown,
): Promise<CallResult<T>> {
  const result = await authedJson(baseUrl.replace(/\/$/u, ""), path, method, token, payload);
  if ("unreachable" in result) {
    return { ok: false, message: "AdminBot is unreachable. Try again in a moment." };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: string } } | null)?.error?.message;
    return { ok: false, message: message ?? `Request failed (${result.response.status}).` };
  }
  return { ok: true, value: result.body as T };
}

/** "Wednesday 25 November", the same wording the reminders use, so the two never disagree. */
export function posterPrintDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) {
    return day;
  }
  return date.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

function daysLeftText(days: number | undefined): string {
  if (days === undefined) {
    return "";
  }
  if (days < 0) {
    return `${-days} day${days === -1 ? "" : "s"} ago`;
  }
  if (days === 0) {
    return "today";
  }
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export const POSTER_PRINT_STATE_LABELS: Record<AdminBotPosterPrintPaperState, string> = {
  unanswered: "No answer yet",
  missing_file: "Waiting for the file",
  ready: "Ready to print",
  self_print: "Printing it themselves",
  no_poster: "No poster",
};

const STATUS_LABELS: Record<AdminBotPosterPrintBatchStatus, string> = {
  no_deadline: "No deadline",
  collecting: "Collecting",
  due: "Due",
  sent: "List sent",
};

const SIZE_LABELS: Record<AdminBotPosterPrintSize, string> = {
  A0: "A0",
  A1: "A1",
  custom: "Other size",
};

/** "A0 portrait", "36x48 in landscape, 2 copies". */
export function posterPrintSpec(request: AdminBotPosterPrintRequestRecord | undefined): string {
  if (!request || request.choice !== "lab_print") {
    return "";
  }
  const size =
    request.size === "custom" ? (request.custom_size ?? "custom size") : (request.size ?? "A0");
  const copies = request.copies && request.copies > 1 ? `, ${request.copies} copies` : "";
  return `${size} ${request.orientation ?? "portrait"}${copies}`;
}

/**
 * The plain-text list a printer pastes into an email or a print queue: the ready posters only,
 * since a paper still missing its file is not something they can print.
 */
export function posterPrintList(view: AdminBotPosterPrintBatchView): string {
  const ready = view.papers.filter((paper) => paper.state === "ready");
  const lines = ready.map((paper) =>
    [
      `- ${paper.title}`,
      paper.first_author?.name ?? "no first author on record",
      posterPrintSpec(paper.request),
      paper.site_source === "unknown" ? "city not chosen" : "",
      paper.poster_url ?? "",
    ]
      .filter(Boolean)
      .join(" | "),
  );
  return [`${view.label}: ${ready.length} poster${ready.length === 1 ? "" : "s"}`, ...lines].join(
    "\n",
  );
}

// ---------------------------------------------------------------- the paper page's section

type RequestDraft = {
  choice?: AdminBotPosterPrintChoice;
  site_key: string;
  size: AdminBotPosterPrintSize;
  custom_size: string;
  orientation: AdminBotPosterOrientation;
  copies: number;
  notes: string;
};

function draftFrom(options: AdminBotPosterPrintPaperOptions): RequestDraft {
  const request = options.request;
  return {
    ...(request ? { choice: request.choice } : {}),
    site_key: request?.site_key ?? options.site_key ?? "",
    size: request?.size ?? "A0",
    custom_size: request?.custom_size ?? "",
    orientation: request?.orientation ?? "portrait",
    copies: request?.copies ?? 1,
    notes: request?.notes ?? "",
  };
}

const CHOICES: ReadonlyArray<readonly [AdminBotPosterPrintChoice, string]> = [
  ["lab_print", "Print it with the lab batch"],
  ["self_print", "I'll print it myself"],
  ["no_poster", "No poster for this paper"],
];

export class PosterPrintRequest extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @property() paperId = "";
  /** `undefined` while the first read is out, `null` when the paper owes no poster. */
  @state() private options: AdminBotPosterPrintPaperOptions | null | undefined = undefined;
  @state() private draft: RequestDraft | undefined;
  @state() private busy = false;
  @state() private notice = "";
  private generation = 0;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("paperId") || changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.options = undefined;
      this.draft = undefined;
      this.notice = "";
      this.busy = false;
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private async load() {
    if (!this.sessionToken || !this.paperId) {
      return;
    }
    const generation = this.generation;
    const result = await call<AdminBotPosterPrintPaperOptions | null>(
      this.baseUrl,
      `/papers/${encodeURIComponent(this.paperId)}/poster-print`,
      "GET",
      this.sessionToken,
    );
    if (generation !== this.generation) {
      return;
    }
    if (!result.ok) {
      // A paper the viewer cannot answer for, or a service without the feature: say nothing on a
      // page that is about something else.
      this.options = null;
      return;
    }
    this.options = result.value;
    this.draft = result.value ? draftFrom(result.value) : undefined;
  }

  private async save() {
    const draft = this.draft;
    if (!draft?.choice || this.busy) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.notice = "";
    const body: AdminBotPosterPrintRequestInput =
      draft.choice === "lab_print"
        ? {
            choice: draft.choice,
            ...(draft.site_key ? { site_key: draft.site_key } : {}),
            size: draft.size,
            ...(draft.size === "custom" ? { custom_size: draft.custom_size } : {}),
            orientation: draft.orientation,
            copies: draft.copies,
            notes: draft.notes,
          }
        : { choice: draft.choice, notes: draft.notes };
    const result = await call<AdminBotPosterPrintPaperOptions | null>(
      this.baseUrl,
      `/papers/${encodeURIComponent(this.paperId)}/poster-print`,
      "PUT",
      this.sessionToken,
      body,
    );
    if (generation !== this.generation) {
      return;
    }
    this.busy = false;
    if (!result.ok) {
      this.notice = result.message;
      return;
    }
    this.options = result.value;
    this.draft = result.value ? draftFrom(result.value) : undefined;
    this.notice = "Saved.";
  }

  private patch(change: Partial<RequestDraft>) {
    if (this.draft) {
      this.draft = { ...this.draft, ...change };
      this.notice = "";
    }
  }

  override render() {
    const options = this.options;
    const draft = this.draft;
    if (!options || !draft) {
      return nothing;
    }
    const multiSite = options.sites.length > 1;
    const lab = draft.choice === "lab_print";
    const incomplete =
      !draft.choice ||
      (lab && multiSite && !draft.site_key) ||
      (lab && draft.size === "custom" && !draft.custom_size.trim());
    return html`<section
      class="project__panel poster-print"
      data-testid=${`poster-print-request-${options.paper_id}`}
    >
      <h3>Print with the lab batch</h3>
      <p>${requestLede(options)}</p>
      ${options.notes ? html`<p class="paper-slot__note">${options.notes}</p>` : nothing}
      <fieldset class="poster-print__choices" ?disabled=${this.busy}>
        <legend class="poster-print__legend">This paper's poster</legend>
        ${CHOICES.map(
          ([choice, label]) =>
            html`<label class="poster-print__choice">
              <input
                type="radio"
                name=${`poster-print-${options.paper_id}`}
                .checked=${draft.choice === choice}
                data-testid=${`poster-print-choice-${choice}`}
                @change=${() => this.patch({ choice })}
              />
              <span>${label}</span>
            </label>`,
        )}
      </fieldset>
      ${lab ? this.renderSpec(options, draft, multiSite) : nothing}
      <label class="poster-print__field poster-print__field--wide">
        <span>Note for the printer</span>
        <input
          class="input"
          type="text"
          maxlength="500"
          placeholder="Optional"
          .value=${draft.notes}
          ?disabled=${this.busy}
          @input=${(event: Event) =>
            this.patch({ notes: (event.target as HTMLInputElement).value })}
        />
      </label>
      <div class="poster-print__actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${this.busy || incomplete}
          data-testid="poster-print-save"
          @click=${() => void this.save()}
        >
          ${options.request ? "Update answer" : "Save answer"}
        </button>
        <span role="status" class="paper-slot__note">${this.notice}</span>
      </div>
      <p class="paper-slot__note" data-testid="poster-print-state">
        ${requestStateLine(options.state)}
      </p>
    </section>`;
  }

  private renderSpec(
    options: AdminBotPosterPrintPaperOptions,
    draft: RequestDraft,
    multiSite: boolean,
  ) {
    return html`<div class="poster-print__spec">
      ${multiSite
        ? html`<label class="poster-print__field">
            <span>City</span>
            <select
              class="input"
              ?disabled=${this.busy}
              data-testid="poster-print-site"
              @change=${(event: Event) =>
                this.patch({ site_key: (event.target as HTMLSelectElement).value })}
            >
              <option value="" ?selected=${!draft.site_key}>Choose where you present</option>
              ${options.sites.map(
                (site) =>
                  html`<option value=${site.key} ?selected=${site.key === draft.site_key}>
                    ${site.label}${site.starts ? ` (${posterPrintDay(site.starts)})` : ""}
                  </option>`,
              )}
            </select>
          </label>`
        : nothing}
      <label class="poster-print__field">
        <span>Size</span>
        <select
          class="input"
          ?disabled=${this.busy}
          data-testid="poster-print-size"
          @change=${(event: Event) =>
            this.patch({
              size: (event.target as HTMLSelectElement).value as AdminBotPosterPrintSize,
            })}
        >
          ${adminBotPosterPrintSizes.map(
            (size) =>
              html`<option value=${size} ?selected=${size === draft.size}>
                ${SIZE_LABELS[size]}
              </option>`,
          )}
        </select>
      </label>
      ${draft.size === "custom"
        ? html`<label class="poster-print__field">
            <span>Exact size</span>
            <input
              class="input"
              type="text"
              maxlength="60"
              placeholder="e.g. 36 x 48 in"
              .value=${draft.custom_size}
              ?disabled=${this.busy}
              @input=${(event: Event) =>
                this.patch({ custom_size: (event.target as HTMLInputElement).value })}
            />
          </label>`
        : nothing}
      <label class="poster-print__field">
        <span>Orientation</span>
        <select
          class="input"
          ?disabled=${this.busy}
          @change=${(event: Event) =>
            this.patch({
              orientation: (event.target as HTMLSelectElement).value as AdminBotPosterOrientation,
            })}
        >
          ${adminBotPosterOrientations.map(
            (orientation) =>
              html`<option value=${orientation} ?selected=${orientation === draft.orientation}>
                ${orientation === "portrait" ? "Portrait" : "Landscape"}
              </option>`,
          )}
        </select>
      </label>
      <label class="poster-print__field poster-print__field--narrow">
        <span>Copies</span>
        <input
          class="input"
          type="number"
          min="1"
          max="5"
          .value=${String(draft.copies)}
          ?disabled=${this.busy}
          @input=${(event: Event) => {
            const copies = Number((event.target as HTMLInputElement).value);
            if (Number.isInteger(copies) && copies >= 1 && copies <= 5) {
              this.patch({ copies });
            }
          }}
        />
      </label>
    </div>`;
  }
}

function requestLede(options: AdminBotPosterPrintPaperOptions): string {
  const who = options.printer_name ?? "the lab's printer";
  const where = options.print_location ? ` at ${options.print_location}` : "";
  if (options.status === "sent") {
    return `${options.conference_label}: the print list has gone to ${who}. For a late change, message them directly.`;
  }
  if (!options.deadline_on) {
    return `${options.conference_label}: posters are printed together by ${who}${where}. The print deadline is not set yet.`;
  }
  return `${options.conference_label}: posters are printed together by ${who}${where}. Files are due by ${posterPrintDay(options.deadline_on)}.`;
}

function requestStateLine(paperState: AdminBotPosterPrintPaperState): string {
  switch (paperState) {
    case "unanswered":
      return "No answer yet. AdminBot reminds the first author before the deadline until this is answered.";
    case "missing_file":
      return "In the batch, but the Poster link above is still empty. The printer needs the file.";
    case "ready":
      return "Ready. This poster and its details are on the printer's list.";
    case "self_print":
    case "no_poster":
      return "Settled. No more reminders for this paper.";
  }
}

customElements.define("adminbot-poster-print-request", PosterPrintRequest);

// ---------------------------------------------------------------- the batches view

type SettingsDraft = {
  printer_member_id: string;
  print_location: string;
  deadline_on: string;
  lead_days: string;
  notes: string;
};

function settingsDraft(record: AdminBotPosterPrintBatchRecord | undefined): SettingsDraft {
  return {
    printer_member_id: record?.printer_member_id ?? "",
    print_location: record?.print_location ?? "",
    deadline_on: record?.deadline_on ?? "",
    lead_days: record?.lead_days === undefined ? "" : String(record.lead_days),
    notes: record?.notes ?? "",
  };
}

const SETTLED: ReadonlySet<AdminBotPosterPrintPaperState> = new Set(["self_print", "no_poster"]);

export class PosterPrintBatches extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private overview: AdminBotPosterPrintOverview | undefined;
  @state() private drafts: Record<string, SettingsDraft> = {};
  @state() private busy = false;
  @state() private notice = "";
  @state() private failed = "";
  private generation = 0;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.overview = undefined;
      this.drafts = {};
      this.notice = "";
      this.failed = "";
      this.busy = false;
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private async load() {
    if (!this.sessionToken) {
      return;
    }
    const generation = this.generation;
    const result = await call<AdminBotPosterPrintOverview>(
      this.baseUrl,
      "/poster-printing",
      "GET",
      this.sessionToken,
    );
    if (generation !== this.generation) {
      return;
    }
    if (!result.ok) {
      this.failed = result.message;
      return;
    }
    this.failed = "";
    this.overview = result.value;
  }

  private stored(key: string): AdminBotPosterPrintBatchRecord | undefined {
    return this.overview?.settings?.find((row) => row.conference_key === key);
  }

  private draftFor(key: string): SettingsDraft {
    return this.drafts[key] ?? settingsDraft(this.stored(key));
  }

  private patchDraft(key: string, change: Partial<SettingsDraft>) {
    this.drafts = { ...this.drafts, [key]: { ...this.draftFor(key), ...change } };
  }

  private async run(work: () => Promise<CallResult<unknown>>, done: string) {
    if (this.busy) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.notice = "";
    const result = await work();
    if (generation !== this.generation) {
      return;
    }
    this.busy = false;
    if (!result.ok) {
      this.notice = result.message;
      return;
    }
    this.notice = done;
    await this.load();
  }

  private saveSettings(key: string) {
    const draft = this.draftFor(key);
    const body: AdminBotPosterPrintBatchInput = {
      printer_member_id: draft.printer_member_id,
      print_location: draft.print_location,
      notes: draft.notes,
      ...(key === ADMINBOT_POSTER_PRINT_DEFAULTS_KEY
        ? draft.lead_days.trim()
          ? { lead_days: Number(draft.lead_days) }
          : {}
        : { deadline_on: draft.deadline_on }),
    };
    void this.run(async () => {
      const result = await call(
        this.baseUrl,
        `/poster-printing/${encodeURIComponent(key)}`,
        "PUT",
        this.sessionToken,
        body,
      );
      if (result.ok) {
        const { [key]: _saved, ...rest } = this.drafts;
        this.drafts = rest;
      }
      return result;
    }, "Settings saved.");
  }

  private markPrinted(view: AdminBotPosterPrintBatchView) {
    const ready = view.counts.ready;
    if (
      !globalThis.confirm?.(
        `Mark ${ready} ready poster${ready === 1 ? "" : "s"} for ${view.label} as printed?`,
      )
    ) {
      return;
    }
    void this.run(
      () =>
        call(
          this.baseUrl,
          `/poster-printing/${encodeURIComponent(view.conference_key)}/printed`,
          "POST",
          this.sessionToken,
          {},
        ),
      `Marked ${view.label} printed.`,
    );
  }

  private async copyList(view: AdminBotPosterPrintBatchView) {
    try {
      await navigator.clipboard.writeText(posterPrintList(view));
      this.notice = `Copied the ${view.label} print list.`;
    } catch {
      this.notice = "Could not reach the clipboard. Select the rows and copy them instead.";
    }
  }

  override render() {
    const overview = this.overview;
    return html`<section class="poster-batches" data-testid="poster-print-batches">
      <p class="poster-batches__intro">
        One print run per conference city. First authors answer on their paper's Talk tab; AdminBot
        reminds the ones who have not, and hands the printer this list on the deadline. Every Slack
        message waits for an admin in Pending actions.
      </p>
      ${this.failed
        ? html`<p class="poster-batches__notice" role="alert">${this.failed}</p>`
        : nothing}
      ${this.notice
        ? html`<p class="poster-batches__notice" role="status">${this.notice}</p>`
        : nothing}
      ${!overview
        ? this.failed
          ? nothing
          : html`<p class="poster-batches__empty">Loading print batches…</p>`
        : overview.batches.length === 0
          ? html`<p class="poster-batches__empty">
              No lab paper is accepted at an upcoming conference yet. A batch appears here as soon
              as one is.
            </p>`
          : overview.batches.map((view) => this.renderBatch(view, overview))}
      ${overview?.can_manage ? this.renderDefaults(overview) : nothing}
    </section>`;
  }

  private renderBatch(view: AdminBotPosterPrintBatchView, overview: AdminBotPosterPrintOverview) {
    const open = view.papers.filter((paper) => !SETTLED.has(paper.state));
    const settled = view.papers.filter((paper) => SETTLED.has(paper.state));
    const meta = [
      view.conference_starts ? `Starts ${posterPrintDay(view.conference_starts)}` : "",
      view.deadline_on
        ? `Files due ${posterPrintDay(view.deadline_on)} (${daysLeftText(view.days_left)})`
        : "No print deadline yet",
      view.printer
        ? `Printed by ${view.printer.name}${view.print_location ? `, ${view.print_location}` : ""}`
        : "No printer set",
    ].filter(Boolean);
    const counts = (Object.keys(POSTER_PRINT_STATE_LABELS) as AdminBotPosterPrintPaperState[])
      .filter((key) => view.counts[key] > 0)
      .map((key) => `${view.counts[key]} ${POSTER_PRINT_STATE_LABELS[key].toLowerCase()}`);
    return html`<section
      class="poster-batch"
      data-testid=${`poster-batch-${view.conference_key}`}
    >
      <div class="poster-batch__head">
        <h3>${view.label}</h3>
        <span class=${`poster-batch__status poster-batch__status--${view.status}`}>
          ${STATUS_LABELS[view.status]}
        </span>
      </div>
      <p class="poster-batch__meta">${meta.join(" · ")}</p>
      ${view.notes ? html`<p class="poster-batch__meta">${view.notes}</p>` : nothing}
      <p class="poster-batch__meta">${counts.join(" · ")}</p>
      <ul class="poster-batch__rows">
        ${open.map((paper) => renderPaperRow(paper))}
      </ul>
      ${settled.length
        ? html`<details class="poster-batch__settled">
            <summary>${settled.length} not in the print run</summary>
            <ul class="poster-batch__rows">
              ${settled.map((paper) => renderPaperRow(paper))}
            </ul>
          </details>`
        : nothing}
      <div class="poster-batch__actions">
        <button
          class="btn btn--sm"
          type="button"
          ?disabled=${view.counts.ready === 0}
          @click=${() => void this.copyList(view)}
        >
          Copy print list
        </button>
        ${overview.printable.includes(view.conference_key) && view.counts.ready > 0
          ? html`<button
              class="btn btn--sm"
              type="button"
              ?disabled=${this.busy}
              data-testid=${`poster-batch-printed-${view.conference_key}`}
              @click=${() => this.markPrinted(view)}
            >
              Mark ready posters printed
            </button>`
          : nothing}
      </div>
      ${overview.can_manage
        ? html`<details class="poster-batch__settings">
            <summary>Settings for ${view.label}</summary>
            ${this.renderSettingsForm(view.conference_key, overview, false)}
          </details>`
        : nothing}
    </section>`;
  }

  private renderDefaults(overview: AdminBotPosterPrintOverview) {
    return html`<section class="poster-batch" data-testid="poster-print-defaults">
      <div class="poster-batch__head"><h3>Lab defaults</h3></div>
      <p class="poster-batch__meta">
        Every city uses these unless its own settings say otherwise. Files are due this many days
        before a conference starts.
      </p>
      ${this.renderSettingsForm(ADMINBOT_POSTER_PRINT_DEFAULTS_KEY, overview, true)}
    </section>`;
  }

  private renderSettingsForm(
    key: string,
    overview: AdminBotPosterPrintOverview,
    defaults: boolean,
  ) {
    const draft = this.draftFor(key);
    const fallback = defaults ? undefined : this.stored(ADMINBOT_POSTER_PRINT_DEFAULTS_KEY);
    const fallbackPrinter = overview.printer_candidates?.find(
      (candidate) => candidate.member_id === fallback?.printer_member_id,
    );
    return html`<div class="poster-print__spec" data-testid=${`poster-settings-${key}`}>
      <label class="poster-print__field">
        <span>Printer</span>
        <select
          class="input"
          ?disabled=${this.busy}
          @change=${(event: Event) =>
            this.patchDraft(key, {
              printer_member_id: (event.target as HTMLSelectElement).value,
            })}
        >
          <option value="" ?selected=${!draft.printer_member_id}>
            ${defaults
              ? "Nobody yet"
              : `Lab default${fallbackPrinter ? ` (${fallbackPrinter.name})` : ""}`}
          </option>
          ${(overview.printer_candidates ?? []).map(
            (candidate) =>
              html`<option
                value=${candidate.member_id}
                ?selected=${candidate.member_id === draft.printer_member_id}
              >
                ${candidate.name}
              </option>`,
          )}
        </select>
      </label>
      <label class="poster-print__field">
        <span>Where it is printed</span>
        <input
          class="input"
          type="text"
          maxlength="120"
          placeholder=${fallback?.print_location ?? "e.g. MPI Tübingen"}
          .value=${draft.print_location}
          ?disabled=${this.busy}
          @input=${(event: Event) =>
            this.patchDraft(key, { print_location: (event.target as HTMLInputElement).value })}
        />
      </label>
      ${defaults
        ? html`<label class="poster-print__field poster-print__field--narrow">
            <span>Days before</span>
            <input
              class="input"
              type="number"
              min="0"
              max="120"
              placeholder="14"
              .value=${draft.lead_days}
              ?disabled=${this.busy}
              @input=${(event: Event) =>
                this.patchDraft(key, { lead_days: (event.target as HTMLInputElement).value })}
            />
          </label>`
        : html`<label class="poster-print__field">
            <span>Files due</span>
            <input
              class="input"
              type="date"
              .value=${draft.deadline_on}
              ?disabled=${this.busy}
              @input=${(event: Event) =>
                this.patchDraft(key, { deadline_on: (event.target as HTMLInputElement).value })}
            />
          </label>`}
      <label class="poster-print__field poster-print__field--wide">
        <span>Note to authors</span>
        <input
          class="input"
          type="text"
          maxlength="500"
          placeholder=${fallback?.notes ?? "How posters reach the venue, file rules"}
          .value=${draft.notes}
          ?disabled=${this.busy}
          @input=${(event: Event) =>
            this.patchDraft(key, { notes: (event.target as HTMLInputElement).value })}
        />
      </label>
      <div class="poster-print__actions">
        <button
          class="btn primary"
          type="button"
          ?disabled=${this.busy}
          data-testid=${`poster-settings-save-${key}`}
          @click=${() => this.saveSettings(key)}
        >
          Save
        </button>
      </div>
    </div>`;
  }
}

function renderPaperRow(paper: AdminBotPosterPrintPaper) {
  const details = [
    paper.first_author
      ? `${paper.first_author.name}${paper.first_author_going ? ", going" : ""}`
      : "No first author on record",
    posterPrintSpec(paper.request),
    paper.site_source === "unknown" ? "City not chosen" : "",
    paper.request?.notes ?? "",
  ].filter(Boolean);
  return html`<li class="poster-row" data-testid=${`poster-row-${paper.paper_id}`}>
    <div class="poster-row__main">
      <span class="poster-row__title">
        ${paper.poster_url
          ? html`<a href=${paper.poster_url} target="_blank" rel="noopener noreferrer"
              >${paper.title}</a
            >`
          : paper.title}
      </span>
      <span class="poster-row__details">${details.join(" · ")}</span>
    </div>
    <span class=${`poster-row__state poster-row__state--${paper.state}`}>
      ${POSTER_PRINT_STATE_LABELS[paper.state]}
    </span>
  </li>`;
}

customElements.define("adminbot-poster-print-batches", PosterPrintBatches);
