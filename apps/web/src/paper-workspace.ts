import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type { PaperProjection, PaperWorkspaceProjection, UpdatePaperCommand } from "@adminbot/api-contracts";
import { PaperApiClient, PaperApiError, type PaperClient } from "./paper-api-client.js";

type PaperStage = PaperProjection["paper"]["stage"];
const STAGES: readonly PaperStage[] = ["idea", "outline", "drafting", "internal_review", "submission_ready", "submitted", "revision", "accepted", "camera_ready", "published", "archived"];

export class AdminBotPaperWorkspace extends LitElement {
  static override properties = {
    workspace: { state: true }, loading: { state: true }, needsLogin: { state: true },
    errorMessage: { state: true }, notice: { state: true }, selectedPaperId: { state: true },
    search: { state: true }, venue: { state: true }, topic: { state: true }, stage: { state: true }, progress: { state: true }, busyPaperId: { state: true },
  };
  static override styles = css`
    :host { display: block; color: var(--text); } * { box-sizing: border-box; }
    button, input, select { font: inherit; }
    h1 { margin: 0; color: var(--text-strong); font-family: Georgia, serif; font-size: clamp(2rem, 5vw, 3.5rem); font-weight: 500; }
    .eyebrow { margin: 0 0 .55rem; color: var(--accent); font-size: .65rem; font-weight: 780; letter-spacing: .14em; text-transform: uppercase; }
    .lede { max-width: 50rem; color: var(--text-muted); line-height: 1.6; }
    .toolbar { display: flex; gap: .6rem; align-items: center; justify-content: space-between; margin: 1.2rem 0; }
    .filters { display: grid; grid-template-columns: minmax(12rem, 1.4fr) repeat(4, minmax(8rem, 1fr)); gap: .6rem; margin-bottom: 1rem; }
    input, select { width: 100%; border: 1px solid var(--border-strong); border-radius: .6rem; padding: .62rem .68rem; color: var(--text-strong); background: var(--surface-1); }
    button { border: 1px solid var(--border-strong); border-radius: .6rem; padding: .58rem .72rem; color: var(--text); background: var(--surface-3); cursor: pointer; }
    button.primary { border-color: var(--accent); color: var(--accent-ink); background: var(--accent); font-weight: 750; }
    button.danger { color: var(--danger); } button:disabled { opacity: .5; cursor: wait; }
    .count { color: var(--text-muted); font-size: .75rem; }
    .paper-list { display: grid; gap: .75rem; }
    .paper { overflow: hidden; border: 1px solid var(--border); border-radius: .85rem; background: var(--surface-2); }
    .paper-head { display: grid; grid-template-columns: minmax(12rem, 18rem) minmax(20rem, 1fr); gap: 1rem; padding: 1rem; }
    .identity { display: grid; gap: .3rem; align-content: start; }
    .identity strong { color: var(--text-strong); } .identity small { color: var(--text-muted); }
    .tags { display: flex; flex-wrap: wrap; gap: .3rem; }
    .tag { border: 1px solid var(--border); border-radius: 999px; padding: .16rem .42rem; color: var(--text-muted); font-size: .62rem; }
    .meter { height: .3rem; overflow: hidden; border-radius: 999px; background: var(--surface-3); }
    .meter span { display: block; height: 100%; background: var(--accent); }
    .timeline { position: relative; display: grid; min-height: 4.8rem; border-left: 1px solid var(--border); }
    .bar { position: absolute; top: 0; height: 2rem; overflow: hidden; border: 1px solid var(--border-strong); border-radius: .45rem; padding: .35rem .42rem; color: var(--text-muted); background: var(--surface-3); font-size: .62rem; white-space: nowrap; }
    .bar.complete { border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); background: var(--accent-soft); }
    .bar.current { top: 2.35rem; border-color: var(--warning); color: var(--text-strong); background: var(--warning-soft); }
    .paper-actions { display: flex; gap: .45rem; padding: 0 1rem 1rem; }
    .editor, .creator, .nudges { margin-top: 1rem; border: 1px solid var(--border); border-radius: .85rem; padding: 1rem; background: var(--surface-2); }
    .editor form, .creator form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; }
    label { display: grid; gap: .35rem; color: var(--text-muted); font-size: .7rem; } label.full { grid-column: 1 / -1; }
    .form-actions { grid-column: 1 / -1; display: flex; gap: .5rem; }
    .nudge { border-left: .2rem solid var(--warning); padding: .65rem .8rem; background: var(--surface-1); }
    .nudge + .nudge { margin-top: .5rem; } .nudge strong { color: var(--text-strong); } .nudge p { margin: .3rem 0 0; color: var(--text-muted); font-size: .75rem; }
    .status { margin: 1rem 0; border-left: .2rem solid var(--accent); padding: .65rem .8rem; background: var(--accent-soft); }
    .status.error { border-color: var(--danger); color: var(--danger); }
    .empty { border: 1px dashed var(--border); border-radius: .8rem; padding: 2rem; color: var(--text-muted); text-align: center; }
    @media (max-width: 900px) { .filters { grid-template-columns: repeat(2, 1fr); } .paper-head { grid-template-columns: 1fr; } .timeline { border-left: 0; min-height: 5.2rem; } }
    @media (max-width: 600px) { .filters, .editor form, .creator form { grid-template-columns: 1fr; } label.full { grid-column: auto; } }
  `;

  client: PaperClient = new PaperApiClient(import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin);
  declare private workspace: PaperWorkspaceProjection | undefined;
  declare private loading: boolean; declare private needsLogin: boolean; declare private errorMessage: string; declare private notice: string;
  declare private selectedPaperId: string; declare private search: string; declare private venue: string; declare private topic: string; declare private stage: string; declare private progress: string; declare private busyPaperId: string;

  constructor() { super(); this.loading = true; this.needsLogin = false; this.errorMessage = ""; this.notice = ""; this.selectedPaperId = ""; this.search = ""; this.venue = ""; this.topic = ""; this.stage = ""; this.progress = ""; this.busyPaperId = ""; }
  override connectedCallback(): void { super.connectedCallback(); void this.load(); }
  override render(): TemplateResult {
    if (this.needsLogin) return html`<adminbot-login-app @adminbot-session-changed=${() => this.load()}></adminbot-login-app>`;
    if (this.loading) return html`<div class="empty">Loading publication pipeline…</div>`;
    const papers = this.filteredPapers;
    return html`
      <header><p class="eyebrow">Workspace · authoritative records</p><h1>Publication pipeline</h1><p class="lede">Track paper stages on a shared business-day scale. Authors can edit their own records; administrator-only deletion is version checked and audited.</p></header>
      ${this.notice ? html`<p class="status" role="status">${this.notice}</p>` : nothing}
      ${this.errorMessage ? html`<p class="status error" role="alert">${this.errorMessage}</p>` : nothing}
      <div class="toolbar"><span class="count">${papers.length} of ${this.workspace?.papers.length ?? 0} papers</span><button @click=${() => { this.selectedPaperId = "new"; }}>Add paper</button></div>
      ${this.renderFilters()}
      <section class="paper-list">${papers.length ? papers.map((paper) => this.renderPaper(paper)) : html`<div class="empty">No papers match these filters.</div>`}</section>
      ${this.selectedPaperId === "new" ? this.renderCreateForm() : this.renderEditForm()}
      ${this.workspace?.nudges.length ? this.renderNudges() : nothing}
    `;
  }

  private renderFilters(): TemplateResult {
    const venues = unique(this.workspace?.papers.map(({ paper }) => paper.targetVenue).filter(isString) ?? []);
    const topics = unique(this.workspace?.papers.flatMap(({ paper }) => paper.topicTags) ?? []);
    return html`<div class="filters">
      ${this.filterInput("Search papers or authors", this.search, (value) => { this.search = value; })}
      ${this.filterSelect("Venue", this.venue, venues, (value) => { this.venue = value; })}
      ${this.filterSelect("Topic", this.topic, topics, (value) => { this.topic = value; })}
      ${this.filterSelect("Stage", this.stage, STAGES, (value) => { this.stage = value; })}
      ${this.filterSelect("Progress", this.progress, ["not-started", "early", "middle", "late", "complete"], (value) => { this.progress = value; })}
    </div>`;
  }
  private filterInput(label: string, value: string, apply: (value: string) => void): TemplateResult { return html`<input type="search" aria-label=${label} placeholder=${label} .value=${value} @input=${(event: Event) => apply((event.target as HTMLInputElement).value)} />`; }
  private filterSelect(label: string, value: string, options: readonly string[], apply: (value: string) => void): TemplateResult { return html`<select aria-label=${label} .value=${value} @change=${(event: Event) => apply((event.target as HTMLSelectElement).value)}><option value="">All ${label.toLowerCase()}s</option>${options.map((option) => html`<option value=${option}>${friendly(option)}</option>`)}</select>`; }

  private renderPaper(projection: PaperProjection): TemplateResult {
    const paper = projection.paper; const canEdit = this.isAdministrator || paper.authorIds.includes(this.workspace?.viewerPersonId ?? ""); const total = projection.timeline.totalEstimatedBusinessDays;
    return html`<article class="paper"><div class="paper-head"><div class="identity"><strong>${paper.title}</strong><small>${projection.authorNames.join(", ") || "No authors"}</small><div class="tags">${paper.targetVenue ? html`<span class="tag">${paper.targetVenue}</span>` : nothing}${paper.topicTags.map((tag) => html`<span class="tag">${tag}</span>`)}</div><div class="meter" role="img" aria-label=${`${projection.timeline.progressPercent}% complete`}><span style=${`width:${projection.timeline.progressPercent}%`}></span></div><small>${projection.timeline.progressPercent}% · ${friendly(paper.stage)}${paper.deadlineAt ? ` · due ${new Date(paper.deadlineAt).toLocaleDateString()}` : ""}</small></div><div class="timeline" aria-label=${`${paper.title} timeline`}>${projection.timeline.items.map((item) => html`<span class=${`bar ${item.state}`} style=${`left:${(item.offsetStartBusinessDay / total) * 100}%;width:${Math.max(5, (item.durationBusinessDays / total) * 100)}%`} title=${`${item.label}: ${item.durationBusinessDays} business days`}>${item.label}</span>`)}</div></div><div class="paper-actions">${canEdit ? html`<button @click=${() => { this.selectedPaperId = paper.id; }}>Edit</button>` : nothing}${this.isAdministrator ? html`<button class="danger" ?disabled=${this.busyPaperId === paper.id} @click=${() => this.removePaper(projection)}>Delete</button>` : nothing}</div></article>`;
  }

  private renderCreateForm(): TemplateResult { return html`<section class="creator"><h2>Add paper</h2><form @submit=${this.createPaper}><label class="full">Title<input name="title" required maxlength="500" /></label><label class="full">Author person IDs<input name="authorIds" .value=${this.workspace?.viewerPersonId ?? ""} required /></label>${this.commonFields()}<div class="form-actions"><button class="primary" type="submit">Add paper</button><button type="button" @click=${this.closeEditor}>Cancel</button></div></form></section>`; }
  private renderEditForm(): TemplateResult | typeof nothing {
    const projection = this.workspace?.papers.find(({ paper }) => paper.id === this.selectedPaperId); if (!projection) return nothing; const paper = projection.paper;
    return html`<section class="editor"><h2>Edit ${paper.title}</h2><form @submit=${(event: SubmitEvent) => this.updatePaper(event, projection)}><label class="full">Title<input name="title" .value=${paper.title} required maxlength="500" /></label><label class="full">Author person IDs<input name="authorIds" .value=${paper.authorIds.join(", ")} ?disabled=${!this.isAdministrator} required /></label>${this.commonFields(paper)}<div class="form-actions"><button class="primary" type="submit">Save changes</button><button type="button" @click=${this.closeEditor}>Cancel</button></div></form></section>`;
  }
  private commonFields(paper?: PaperProjection["paper"]): TemplateResult { return html`<label>Stage<select name="stage">${STAGES.map((stage) => html`<option value=${stage} ?selected=${paper?.stage === stage}>${friendly(stage)}</option>`)}</select></label><label>Target venue<input name="targetVenue" .value=${paper?.targetVenue ?? ""} /></label><label>Deadline<input name="deadlineAt" type="datetime-local" .value=${toLocalInput(paper?.deadlineAt)} /></label><label>Source URL<input name="sourceUri" type="url" .value=${paper?.sourceUri ?? ""} /></label><label class="full">Topic tags<input name="topicTags" .value=${paper?.topicTags.join(", ") ?? ""} /></label>`; }
  private renderNudges(): TemplateResult { return html`<section class="nudges"><h2>Paper nudges</h2>${this.workspace?.nudges.map((nudge) => html`<article class="nudge"><strong>${nudge.kind === "administrator_escalation" ? "Escalate" : "Nudge"}: ${nudge.title}</strong><p>${nudge.message} Recipients: ${nudge.recipientNames.join(", ") || "none"}.</p></article>`)}</section>`; }

  private get filteredPapers(): readonly PaperProjection[] { const query = this.search.trim().toLowerCase(); return (this.workspace?.papers ?? []).filter((projection) => { const paper = projection.paper; return (!query || `${paper.title} ${projection.authorNames.join(" ")}`.toLowerCase().includes(query)) && (!this.venue || paper.targetVenue === this.venue) && (!this.topic || paper.topicTags.includes(this.topic)) && (!this.stage || paper.stage === this.stage) && (!this.progress || progressBucket(projection.timeline.progressPercent) === this.progress); }); }
  private get isAdministrator(): boolean { return this.workspace?.viewerRoles.includes("administrator") ?? false; }
  private readonly closeEditor = (): void => { this.selectedPaperId = ""; };
  private async load(): Promise<void> { this.loading = true; this.errorMessage = ""; try { this.workspace = await this.client.list(); this.needsLogin = false; } catch (error) { if (error instanceof PaperApiError && error.status === 401) this.needsLogin = true; else this.errorMessage = userError(error); } finally { this.loading = false; } }
  private readonly createPaper = async (event: SubmitEvent): Promise<void> => { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); await this.mutate("new", () => this.client.create({ title: required(data, "title"), authorIds: csv(data, "authorIds"), stage: field(data, "stage") as PaperStage, ...createCommandFields(data) }), "Paper added."); };
  private async updatePaper(event: SubmitEvent, projection: PaperProjection): Promise<void> { event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement); const input: UpdatePaperCommand = { paperId: projection.paper.id, expectedVersion: projection.paper.version, title: required(data, "title"), stage: field(data, "stage") as PaperStage, ...optionalCommandFields(data), ...(this.isAdministrator ? { authorIds: csv(data, "authorIds") } : {}) }; await this.mutate(projection.paper.id, () => this.client.update(projection.paper.id, input), "Paper updated."); }
  private async removePaper(projection: PaperProjection): Promise<void> { if (!window.confirm(`Delete paper “${projection.paper.title}”? This cannot be undone.`)) return; await this.mutate(projection.paper.id, () => this.client.delete(projection.paper.id, { paperId: projection.paper.id, expectedVersion: projection.paper.version }), "Paper deleted."); }
  private async mutate(id: string, action: () => Promise<unknown>, notice: string): Promise<void> { this.busyPaperId = id; this.errorMessage = ""; this.notice = ""; try { await action(); this.notice = notice; this.selectedPaperId = ""; await this.load(); } catch (error) { this.errorMessage = userError(error); } finally { this.busyPaperId = ""; } }
}

function optionalCommandFields(data: FormData) { const deadline = field(data, "deadlineAt"); return { targetVenue: nullable(field(data, "targetVenue")), deadlineAt: deadline ? new Date(deadline).toISOString() : null, sourceUri: nullable(field(data, "sourceUri")), topicTags: csv(data, "topicTags") }; }
function createCommandFields(data: FormData) { const deadline = field(data, "deadlineAt"); const targetVenue = field(data, "targetVenue"); const sourceUri = field(data, "sourceUri"); const topicTags = csv(data, "topicTags"); return { ...(targetVenue ? { targetVenue } : {}), ...(deadline ? { deadlineAt: new Date(deadline).toISOString() } : {}), ...(sourceUri ? { sourceUri } : {}), ...(topicTags.length ? { topicTags } : {}) }; }
function required(data: FormData, key: string): string { const value = field(data, key); if (!value) throw new Error(`${key} is required`); return value; }
function field(data: FormData, key: string): string { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function csv(data: FormData, key: string): string[] { return [...new Set(field(data, key).split(",").map((value) => value.trim()).filter(Boolean))]; }
function nullable(value: string): string | null { return value || null; }
function unique(values: readonly string[]): readonly string[] { return [...new Set(values)].toSorted(); }
function isString(value: string | null | undefined): value is string { return typeof value === "string"; }
function friendly(value: string): string { return value.split(/[_-]/u).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "); }
function progressBucket(progress: number): string { return progress === 0 ? "not-started" : progress < 34 ? "early" : progress < 67 ? "middle" : progress < 100 ? "late" : "complete"; }
function toLocalInput(value: string | null | undefined): string { if (!value) return ""; const date = new Date(value); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }
function userError(error: unknown): string { if (error instanceof PaperApiError) return error.message; return error instanceof Error ? error.message : "Paper operation failed."; }
