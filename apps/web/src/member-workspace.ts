import type {
  MemberRosterEntry,
  MemberRosterProjection,
  UpdateMemberGovernanceInput,
} from "@adminbot/api-contracts";
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import { MemberApiClient, MemberApiError, type MemberClient } from "./member-api-client.js";

export class AdminBotMemberWorkspace extends LitElement {
  static override properties = {
    workspace: { state: true }, loading: { state: true }, errorMessage: { state: true },
    notice: { state: true }, search: { state: true }, tier: { state: true },
    lifecycle: { state: true }, selectedPersonId: { state: true }, saving: { state: true },
  };

  static override styles = css`
    :host { display:block; color:var(--text); } * { box-sizing:border-box; }
    button,input,select,textarea { font:inherit; } h1 { margin:0; color:var(--text-strong); font:500 clamp(2rem,5vw,3.5rem)/1.05 Georgia,serif; }
    h2,h3 { color:var(--text-strong); } .eyebrow { color:var(--accent); font-size:.65rem; font-weight:780; letter-spacing:.14em; text-transform:uppercase; }
    .lede { max-width:54rem; color:var(--text-muted); line-height:1.6; }
    .filters { display:grid; grid-template-columns:minmax(14rem,2fr) repeat(2,minmax(9rem,1fr)); gap:.65rem; margin:1rem 0; }
    input,select,textarea { width:100%; border:1px solid var(--border-strong); border-radius:.58rem; padding:.6rem .65rem; color:var(--text-strong); background:var(--surface-1); }
    textarea { min-height:7rem; resize:vertical; } button { border:1px solid var(--border-strong); border-radius:.58rem; padding:.56rem .72rem; color:var(--text); background:var(--surface-3); cursor:pointer; }
    button.primary { border-color:var(--accent); color:var(--accent-ink); background:var(--accent); font-weight:750; } button:disabled { opacity:.5; cursor:wait; }
    .roster { display:grid; grid-template-columns:repeat(auto-fill,minmax(17rem,1fr)); gap:.75rem; }
    .member { display:grid; gap:.55rem; min-height:12rem; border:1px solid var(--border); border-radius:.82rem; padding:1rem; background:var(--surface-2); }
    .member.self { border-color:color-mix(in srgb,var(--accent) 55%,var(--border)); } .member-head { display:flex; justify-content:space-between; gap:.6rem; }
    .member h2 { margin:0; font-size:1rem; } .member small,.muted { color:var(--text-muted); }
    .tags { display:flex; flex-wrap:wrap; gap:.3rem; } .tag { border:1px solid var(--border); border-radius:999px; padding:.17rem .43rem; color:var(--text-muted); font-size:.62rem; }
    .bio { margin:0; color:var(--text-muted); font-size:.76rem; line-height:1.5; } .member-actions { align-self:end; display:flex; gap:.45rem; }
    .editor { margin-top:1rem; border:1px solid var(--border); border-radius:.85rem; padding:1rem; background:var(--surface-2); }
    form { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.7rem; } label { display:grid; gap:.3rem; color:var(--text-muted); font-size:.7rem; }
    label.full,.form-actions { grid-column:1/-1; } .form-actions { display:flex; gap:.5rem; }
    .status { border-left:.2rem solid var(--accent); padding:.65rem .8rem; background:var(--accent-soft); }
    .status.error { border-color:var(--danger); color:var(--danger); } .empty { border:1px dashed var(--border); border-radius:.8rem; padding:2rem; color:var(--text-muted); text-align:center; }
    @media(max-width:700px){ .filters,form { grid-template-columns:1fr; } label.full,.form-actions { grid-column:auto; } }
  `;

  client: MemberClient = new MemberApiClient(import.meta.env.VITE_ADMINBOT_API_ORIGIN || window.location.origin);
  declare private workspace: MemberRosterProjection | undefined;
  declare private loading: boolean;
  declare private errorMessage: string;
  declare private notice: string;
  declare private search: string;
  declare private tier: string;
  declare private lifecycle: string;
  declare private selectedPersonId: string;
  declare private saving: boolean;

  constructor() {
    super(); this.loading = true; this.errorMessage = ""; this.notice = "";
    this.search = ""; this.tier = ""; this.lifecycle = ""; this.selectedPersonId = ""; this.saving = false;
  }

  override connectedCallback(): void { super.connectedCallback(); void this.load(); }

  override render(): TemplateResult {
    if (this.loading) return html`<div class="empty">Loading member roster…</div>`;
    const members = this.filteredMembers;
    return html`
      <header><p class="eyebrow">Workspace · authenticated directory</p><h1>Lab members</h1>
        <p class="lede">Find collaborators and maintain the fields you own. Membership tier, lifecycle, mentor, institutional email, and canonical name remain administrator-governed.</p></header>
      ${this.notice ? html`<p class="status" role="status">${this.notice}</p>` : nothing}
      ${this.errorMessage ? html`<p class="status error" role="alert">${this.errorMessage}</p>` : nothing}
      <div class="filters">
        <input type="search" aria-label="Search members" placeholder="Search name, biography, topic, or email" .value=${this.search} @input=${(event: Event) => { this.search = (event.target as HTMLInputElement).value; }}>
        ${selectFilter("Membership tier", this.tier, ["external_collaborator", "member"], (value) => { this.tier = value; })}
        ${selectFilter("Lifecycle", this.lifecycle, ["applicant", "accepted", "onboarding", "active", "leave", "departing", "alumni"], (value) => { this.lifecycle = value; })}
      </div>
      <section class="roster" aria-label="Member roster">${members.length ? members.map((member) => this.renderMember(member)) : html`<div class="empty">No members match these filters.</div>`}</section>
      ${this.renderEditor()}
    `;
  }

  private renderMember(member: MemberRosterEntry): TemplateResult {
    const profile = member.profile; const membership = member.membership;
    const self = profile.personId === this.workspace?.viewerPersonId;
    return html`<article class=${`member ${self ? "self" : ""}`}>
      <div class="member-head"><div><h2>${profile.preferredName || profile.displayName}</h2>${profile.preferredName ? html`<small>${profile.displayName}</small>` : nothing}</div><span class="tag">${friendly(membership.lifecycle)}</span></div>
      ${profile.institutionalEmail ? html`<a href=${`mailto:${profile.institutionalEmail}`}>${profile.institutionalEmail}</a>` : nothing}
      <p class="bio">${profile.biography || "No biography provided."}</p>
      <div class="tags"><span class="tag">${friendly(membership.tier)}</span>${profile.researchTopics.map((topic) => html`<span class="tag">${topic}</span>`)}</div>
      ${member.mentorName ? html`<small>Mentor: ${member.mentorName}</small>` : nothing}
      <div class="member-actions">${member.canEditOwnProfile || member.canEditGovernance ? html`<button @click=${() => { this.selectedPersonId = profile.personId; }}>Edit ${self ? "my profile" : "member"}</button>` : nothing}</div>
    </article>`;
  }

  private renderEditor(): TemplateResult | typeof nothing {
    const member = this.workspace?.members.find(({ profile }) => profile.personId === this.selectedPersonId);
    if (member === undefined) return nothing;
    return html`<section class="editor"><h2>Edit ${member.profile.displayName}</h2>
      ${member.canEditOwnProfile ? this.renderOwnForm(member) : nothing}
      ${member.canEditGovernance ? this.renderGovernanceForm(member) : nothing}
    </section>`;
  }

  private renderOwnForm(member: MemberRosterEntry): TemplateResult {
    return html`<form @submit=${(event: SubmitEvent) => this.saveOwn(event, member)}>
      <h3 class="full">Self-service profile</h3>
      <label>Preferred name<input name="preferredName" maxlength="200" .value=${member.profile.preferredName ?? ""}></label>
      <label>Research topics<input name="researchTopics" maxlength="3000" .value=${member.profile.researchTopics.join(", ")} placeholder="Systems, machine learning"></label>
      <label class="full">Biography<textarea name="biography" maxlength="5000" .value=${member.profile.biography ?? ""}></textarea></label>
      <div class="form-actions"><button class="primary" type="submit" ?disabled=${this.saving}>Save my profile</button><button type="button" @click=${this.closeEditor}>Cancel</button></div>
    </form>`;
  }

  private renderGovernanceForm(member: MemberRosterEntry): TemplateResult {
    return html`<form @submit=${(event: SubmitEvent) => this.saveGovernance(event, member)}>
      <h3 class="full">Administrator-governed fields</h3>
      <label>Canonical display name<input name="displayName" required maxlength="300" .value=${member.profile.displayName}></label>
      <label>Institutional email<input name="institutionalEmail" type="email" maxlength="320" .value=${member.profile.institutionalEmail ?? ""}></label>
      <label>Membership tier<select name="tier"><option value="external_collaborator" ?selected=${member.membership.tier === "external_collaborator"}>External collaborator</option><option value="member" ?selected=${member.membership.tier === "member"}>Member</option></select></label>
      <label>Lifecycle<select name="lifecycle">${["applicant", "accepted", "onboarding", "active", "leave", "departing", "alumni"].map((value) => html`<option value=${value} ?selected=${member.membership.lifecycle === value}>${friendly(value)}</option>`)}</select></label>
      <label>Mentor<select name="mentorId"><option value="">No mentor</option>${this.workspace?.members.filter(({ profile }) => profile.personId !== member.profile.personId).map(({ profile }) => html`<option value=${profile.personId} ?selected=${member.membership.mentorId === profile.personId}>${profile.displayName}</option>`)}</select></label>
      <label>Reason<input name="reason" required maxlength="2000" placeholder="Reason for this governance change"></label>
      <div class="form-actions"><button class="primary" type="submit" ?disabled=${this.saving}>Save governance fields</button><button type="button" @click=${this.closeEditor}>Cancel</button></div>
    </form>`;
  }

  private get filteredMembers(): readonly MemberRosterEntry[] {
    const query = this.search.trim().toLowerCase();
    return (this.workspace?.members ?? []).filter((member) => {
      const profile = member.profile;
      const haystack = `${profile.displayName} ${profile.preferredName ?? ""} ${profile.institutionalEmail ?? ""} ${profile.biography ?? ""} ${profile.researchTopics.join(" ")}`.toLowerCase();
      return (!query || haystack.includes(query)) && (!this.tier || member.membership.tier === this.tier) && (!this.lifecycle || member.membership.lifecycle === this.lifecycle);
    });
  }

  private async load(): Promise<void> {
    this.loading = true; this.errorMessage = "";
    try { this.workspace = await this.client.list(); }
    catch (error) { this.errorMessage = userError(error); }
    finally { this.loading = false; }
  }

  private readonly saveOwn = async (event: SubmitEvent, member: MemberRosterEntry): Promise<void> => {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    await this.mutate(() => this.client.updateOwn({
      expectedVersion: member.profile.version,
      preferredName: nullable(field(data, "preferredName")),
      biography: nullable(field(data, "biography")),
      researchTopics: csv(field(data, "researchTopics")),
    }), "Profile updated.");
  };

  private async saveGovernance(event: SubmitEvent, member: MemberRosterEntry): Promise<void> {
    event.preventDefault(); const data = new FormData(event.currentTarget as HTMLFormElement);
    const input: UpdateMemberGovernanceInput = {
      expectedProfileVersion: member.profile.version,
      expectedMembershipVersion: member.membership.version,
      displayName: field(data, "displayName"),
      institutionalEmail: nullable(field(data, "institutionalEmail")),
      tier: field(data, "tier") as NonNullable<UpdateMemberGovernanceInput["tier"]>,
      lifecycle: field(data, "lifecycle") as NonNullable<UpdateMemberGovernanceInput["lifecycle"]>,
      mentorId: nullable(field(data, "mentorId")),
      reason: field(data, "reason"),
    };
    await this.mutate(() => this.client.updateGovernance(member.profile.personId, input), "Member governance updated.");
  }

  private async mutate(action: () => Promise<MemberRosterProjection>, notice: string): Promise<void> {
    this.saving = true; this.errorMessage = ""; this.notice = "";
    try { this.workspace = await action(); this.selectedPersonId = ""; this.notice = notice; }
    catch (error) { this.errorMessage = userError(error); }
    finally { this.saving = false; }
  }

  private readonly closeEditor = (): void => { this.selectedPersonId = ""; };
}

function selectFilter(label: string, value: string, options: readonly string[], apply: (value: string) => void): TemplateResult { return html`<select aria-label=${label} .value=${value} @change=${(event: Event) => apply((event.target as HTMLSelectElement).value)}><option value="">All ${label.toLowerCase()}s</option>${options.map((option) => html`<option value=${option}>${friendly(option)}</option>`)}</select>`; }
function friendly(value: string): string { return value.split("_").map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" "); }
function field(data: FormData, key: string): string { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function nullable(value: string): string | null { return value || null; }
function csv(value: string): string[] { return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))]; }
function userError(error: unknown): string { if (error instanceof MemberApiError && error.message === "recent reauthentication required") return "Sign out and sign in again before changing governance fields."; return error instanceof Error ? error.message : "Member operation failed."; }
