import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

type SavedRequest = { id: string; context: string; participant_ids: string[] };

export class CollaboratorChats extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private members: { id: string; name: string }[] = [];
  @state() private requests: SavedRequest[] = [];
  @state() private context = "";
  @state() private participantIds: string[] = [];
  @state() private busy = false;
  @state() private notice = "";
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.generation++;
      this.members = [];
      this.requests = [];
      this.context = "";
      this.participantIds = [];
      this.notice = "";
      this.busy = false;
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async load(save = false) {
    if (this.busy || !this.sessionToken) {return;}
    const generation = this.generation;
    this.busy = true;
    this.notice = "";
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/u, "")}/collaborator-chats`, {
        method: save ? "POST" : "GET",
        headers: { ...memberAuthHeaders(this.sessionToken), "Content-Type": "application/json" },
        ...(save
          ? {
              body: JSON.stringify({ context: this.context, participant_ids: this.participantIds }),
            }
          : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const data = await response.json();
      if (generation !== this.generation) {return;}
      if (!response.ok) {throw new Error(data.error?.message ?? "Request failed.");}
      if (save) {
        this.requests = [...this.requests.filter((r) => r.id !== data.request.id), data.request];
        this.notice = data.message;
      } else {
        this.members = data.members;
        this.requests = data.requests;
      }
    } catch (error) {
      if (generation === this.generation)
        {this.notice = error instanceof Error ? error.message : "Request failed.";}
    } finally {
      if (generation === this.generation) {this.busy = false;}
    }
  }
  override render() {
    return html`<section class="card" aria-label="Collaborator chat requests">
      <h2>Collaborator chat requests</h2>
      <p>
        Save who you want to connect and why. Saving does not create a Slack chat or send an
        invitation.
      </p>
      <button ?disabled=${this.busy} @click=${() => this.load()}>
        Load saved requests and members
      </button>
      <label
        >Participants (choose two to eight)
        <select
          multiple
          aria-label="Chat participants"
          ?disabled=${this.busy}
          @change=${(e: Event) => {
            this.participantIds = Array.from(
              (e.target as HTMLSelectElement).selectedOptions,
              (o) => o.value,
            );
          }}
        >
          ${this.members.map(
            (m) =>
              html`<option value=${m.id} ?selected=${this.participantIds.includes(m.id)}>
                ${m.name}
              </option>`,
          )}
        </select>
      </label>
      <label
        >Project or reason for connecting
        <textarea
          .value=${this.context}
          maxlength="2000"
          ?disabled=${this.busy}
          @input=${(e: Event) => {
            this.context = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
      </label>
      <button
        ?disabled=${this.busy ||
        !this.context.trim() ||
        this.participantIds.length < 2 ||
        this.participantIds.length > 8}
        @click=${() => this.load(true)}
      >
        Save request
      </button>
      <p role="status">${this.notice}</p>
      ${this.requests.map(
        (r) => html`<article>
          <h3>${r.context}</h3>
          <p>
            ${r.participant_ids
              .map((id) => this.members.find((m) => m.id === id)?.name ?? id)
              .join(", ")}
          </p>
          <p>
            Saved only — Slack verification and approved creation are not available in this version.
          </p>
        </article>`,
      )}
    </section>`;
  }
}
customElements.define("adminbot-collaborator-chats", CollaboratorChats);
