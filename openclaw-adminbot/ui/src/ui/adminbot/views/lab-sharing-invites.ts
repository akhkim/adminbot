import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
type Invite = {
  id: string;
  status: string;
  kind: string;
  project_title: string;
  recipient_name: string;
};
const invitationStatus = (status: string) =>
  (
    ({
      pending: "Pending administrator approval",
      approved: "Approved; waiting to send",
      executed: "Sent",
      rejected: "Rejected",
      failed: "Send failed",
    }) as Record<string, string>
  )[status] ?? status;
export class LabSharingInvites extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private projects: { id: string; title: string }[] = [];
  @state() private invites: Invite[] = [];
  @state() private recipient: { id: string; name: string } | null = null;
  @state() private paper = "";
  @state() private kind = "collaboration";
  @state() private note = "";
  @state() private start = "";
  @state() private end = "";
  @state() private busy = false;
  @state() private error = "";
  @state() private result = "";
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.reset();
      if (this.sessionToken) {
        void this.load();
      }
    }
  }
  override disconnectedCallback() {
    this.reset();
    super.disconnectedCallback();
  }
  private reset() {
    this.generation++;
    this.projects = [];
    this.invites = [];
    this.recipient = null;
    this.paper = this.note = this.start = this.end = this.error = this.result = "";
    this.kind = "collaboration";
    this.busy = false;
  }
  async selectMember(id: string, name: string) {
    if (this.busy) {
      return;
    }
    const generation = this.generation;
    if (this.recipient?.id !== id) {
      this.note = this.start = this.end = this.error = this.result = "";
      this.kind = "collaboration";
    }
    this.recipient = { id, name };
    await this.updateComplete;
    if (generation !== this.generation) {
      return;
    }
    this.scrollIntoView({ block: "start", behavior: "smooth" });
    this.querySelector("select")?.focus();
  }
  private async request(path: string, body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}${path}`, {
        method: body === undefined ? "GET" : "POST",
        signal: controller.signal,
        headers: { Authorization: `Bearer ${this.sessionToken}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message ?? "Could not load invitations.");
      }
      return data;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(body === undefined
          ? "Invitations took too long to load. Try Refresh invitations."
          : "The request timed out. It may have been accepted. Refresh invitations before trying again.");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async load() {
    const generation = ++this.generation;
    this.busy = true;
    this.error = "";
    try {
      const [directory, data] = await Promise.all([
        this.request("/lab-sharing/mine"),
        this.request("/lab-sharing/invites"),
      ]);
      if (generation !== this.generation) {
        return;
      }
      const openProjects = new Set(
        directory.requests.filter((request: { status: string }) => request.status === "open")
          .map((request: { paper_id: string }) => request.paper_id),
      );
      this.projects = directory.projects.filter((project: { id: string }) => openProjects.has(project.id));
      if (!this.projects.some((project) => project.id === this.paper)) {
        this.paper = "";
      }
      this.invites = data.invites;
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "Could not load invitations.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  private async submit() {
    if (this.busy || !this.recipient) {
      return;
    }
    const generation = ++this.generation;
    this.busy = true;
    this.error = this.result = "";
    try {
      const data = await this.request("/lab-sharing/invites", {
        paper_id: this.paper,
        recipient_id: this.recipient.id,
        kind: this.kind,
        note: this.note,
        ...(this.kind === "call"
          ? { start: new Date(this.start).toISOString(), end: new Date(this.end).toISOString() }
          : {}),
      });
      if (generation !== this.generation) {
        return;
      }
      this.result = `Invitation request: ${invitationStatus(data.status)}.`;
      try {
        const rows = await this.request("/lab-sharing/invites");
        if (generation === this.generation) {
          this.invites = rows.invites;
        }
      } catch {
        if (generation === this.generation) {
          this.error = "Your request was accepted, but history could not refresh. Use Refresh invitations to check its status.";
        }
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error = error instanceof Error ? error.message : "Could not request invitation.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    if (!this.sessionToken) {
      return nothing;
    }
    const field = (
      label: string,
      value: string,
      set: (value: string) => void,
      type = "datetime-local",
    ) =>
      html`<label class="lab-sharing-ask__field"
        ><span>${label}</span
        ><input
          class="lab-sharing-ask__input"
          type=${type}
          required
          .value=${value}
          @input=${(event: Event) => set((event.target as HTMLInputElement).value)}
      /></label>`;
    return html`<section class="lab-sharing lab-sharing-directory" aria-label="Project invitations">
      <h2 class="lab-sharing-seek__title">Project invitations</h2>
      <p>
        Choose a member from search above. Project authors can request a collaboration email or a
        call invitation. An administrator reviews the recipient and content before anything is sent.
      </p>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.load()}>
        Refresh invitations
      </button>
      ${this.busy ? html`<p role="status">Loading invitation details…</p>` : nothing}
      ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}${this.result
        ? html`<p role="status">${this.result}</p>`
        : nothing}
      ${this.recipient && this.projects.length
        ? html`<form
            class="lab-sharing-directory__form"
            @submit=${(event: Event) => {
              event.preventDefault();
              void this.submit();
            }}
          >
            <p>To: <strong>${this.recipient.name}</strong></p>
            <label class="lab-sharing-ask__field"
              ><span>Invitation project</span
              ><select
                class="lab-sharing-ask__input"
                required
                .value=${this.paper}
                @change=${(event: Event) => {
                  this.paper = (event.target as HTMLSelectElement).value;
                }}
              >
                <option value="">Choose your project</option>
                ${this.projects.map(
                  (project) => html`<option value=${project.id}>${project.title}</option>`,
                )}
              </select></label
            >
            <label class="lab-sharing-ask__field"
              ><span>Invitation type</span
              ><select
                class="lab-sharing-ask__input"
                .value=${this.kind}
                @change=${(event: Event) => {
                  this.kind = (event.target as HTMLSelectElement).value;
                }}
              >
                <option value="collaboration">Collaboration email</option>
                <option value="call">Call invitation</option>
              </select></label
            >
            <label class="lab-sharing-ask__field"
              ><span>Invitation note</span
              ><textarea
                class="lab-sharing-ask__input"
                required
                maxlength="1000"
                .value=${this.note}
                @input=${(event: Event) => {
                  this.note = (event.target as HTMLTextAreaElement).value;
                }}
              ></textarea>
            </label>
            ${this.kind === "call"
              ? html`<p>
                    Call times use your device's timezone. The request proposes a calendar event; it
                    does not reserve a time until approved and sent.
                  </p>
                  ${field("Call starts", this.start, (value) => {
                    this.start = value;
                  })}${field("Call ends", this.end, (value) => {
                    this.end = value;
                  })}`
              : nothing}
            <button class="btn primary" ?disabled=${this.busy} type="submit">
              Request invitation
            </button>
          </form>`
        : this.busy || this.error ? nothing : html`<p>
            ${this.projects.length
              ? "Select a member above to prepare an invitation."
              : "Open a help request for a project you manage in Open projects above, then refresh invitations."}
          </p>`}
      <h3 class="lab-sharing-request__project">Your invitation requests</h3>
      ${this.invites.length
        ? this.invites.map(
            (invite) =>
              html`<article class="lab-sharing-request">
                <h4 class="lab-sharing-request__project">
                  ${invite.project_title} · ${invite.recipient_name}
                </h4>
                <p>
                  ${invite.kind === "call" ? "Call invitation" : "Collaboration email"} ·
                  ${invitationStatus(invite.status)}
                </p>
              </article>`,
          )
        : html`<p>No invitation requests yet.</p>`}
    </section>`;
  }
}
if (!customElements.get("lab-sharing-invites")) {
  customElements.define("lab-sharing-invites", LabSharingInvites);
}
