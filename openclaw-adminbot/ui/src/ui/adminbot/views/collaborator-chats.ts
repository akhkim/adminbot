import "../../../styles/collaborator-chats.css";
import { html, LitElement, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

type SavedRequest = {
  id: string;
  context: string;
  participant_ids: string[];
  action?: { id: string; status: string; proposed_payload: unknown; payload_hash: string };
  receipt?: Record<string, string>;
};

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
  private async load(save = false, requestId?: string) {
    if (this.busy || !this.sessionToken) {
      return;
    }
    const generation = this.generation;
    this.busy = true;
    this.notice = "";
    try {
      const response = await fetch(
        `${this.baseUrl.replace(/\/$/u, "")}/collaborator-chats${requestId ? `/${encodeURIComponent(requestId)}/prepare` : ""}`,
        {
          method: save || requestId ? "POST" : "GET",
          headers: { ...memberAuthHeaders(this.sessionToken), "Content-Type": "application/json" },
          ...(save
            ? {
                body: JSON.stringify({
                  context: this.context,
                  participant_ids: this.participantIds,
                }),
              }
            : {}),
          signal: AbortSignal.timeout(30_000),
        },
      );
      const data = await response.json();
      if (generation !== this.generation) {
        return;
      }
      if (!response.ok) {
        throw new Error(data.error?.message ?? "Request failed.");
      }
      if (requestId) {
        this.requests = this.requests.map((r) =>
          r.id === requestId ? { ...r, action: data.action } : r,
        );
        this.notice =
          "Prepared for review. Check the exact participants and message in Pending actions; nothing has been sent.";
      } else if (save) {
        this.requests = [...this.requests.filter((r) => r.id !== data.request.id), data.request];
        this.notice = data.message;
      } else {
        this.members = data.members;
        this.requests = data.requests;
      }
    } catch (error) {
      if (generation === this.generation) {
        this.notice = error instanceof Error ? error.message : "Request failed.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  override render() {
    return html`<section class="card" aria-label="Collaborator chat requests">
      <h2>Collaborator chat requests</h2>
      <p>
        Save who you want to connect and why. Saving does not create a Slack chat or send an
        invitation.
      </p>
      <button class="btn" ?disabled=${this.busy} @click=${() => this.load()}>
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
        >Opening message and project context (shown to participants)
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
        class="btn"
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
          ${r.action
            ? html`<p>Approval status: ${r.action.status}</p>
                <pre>${JSON.stringify(r.action.proposed_payload, null, 2)}</pre>
                <p>Payload hash: ${r.action.payload_hash}</p>
                ${!r.receipt && (r.action.status === "pending" || r.action.status === "approved")
                  ? html`<button
                      class="btn"
                      ?disabled=${this.busy}
                      @click=${() => this.load(false, r.id)}
                    >
                      Recheck Slack identities and refresh approval
                    </button>`
                  : ""}
                <a href="/pending-actions"
                  >Review exact participants and message in Pending actions</a
                >`
            : html`<p>
                  Saved only. A Slack invitation or linked ID does not establish active membership.
                </p>
                <button class="btn" ?disabled=${this.busy} @click=${() => this.load(false, r.id)}>
                  Verify Slack and prepare approval
                </button>`}
          ${r.receipt
            ? html`<p role="status">
                Slack outcome:
                ${r.receipt.outcome === "message_unknown"
                  ? "Group opened; opening message outcome unknown"
                  : r.receipt.outcome === "message_accepted"
                    ? "Slack accepted the opening message"
                    : "Attempt outcome unknown"}.
                Conversation receipt: ${r.receipt.slack_channel ?? "not retained"}. Provider
                acceptance does not establish that participants read the message. Unknown outcomes
                are locked against retry: inspect Slack and reconcile before further action.
              </p>`
            : html`<p>
                No execution receipt. Reload after reviewing or executing the approved action.
              </p>`}
        </article>`,
      )}
    </section>`;
  }
}
customElements.define("adminbot-collaborator-chats", CollaboratorChats);
