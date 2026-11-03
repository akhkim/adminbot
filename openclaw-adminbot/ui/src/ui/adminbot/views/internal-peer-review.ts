import "../../../styles/internal-peer-review.css";
import { html, LitElement } from "lit";
import { property, state } from "lit/decorators.js";
import type { PeerReviewDraft } from "../../../../../extensions/adminbot/src/workflows/papers/internal-peer-review.js";
import { loadSettings } from "../../storage.ts";
import { memberAuthHeaders } from "../api/device-clock.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";

type Suggestion = { member_id: string; name: string; matched_topics: string[] };
export class InternalPeerReview extends LitElement {
  @property() paperId = "";
  @property() sessionToken = "";
  @state() private data: PeerReviewDraft = { purpose: "", draft_url: "", nominee_ids: [] };
  @state() private suggestions: Suggestion[] = [];
  @state() private revision = 0;
  @state() private loaded = false;
  @state() private busy = false;
  @state() private notice = "";
  private generation = 0;
  protected override createRenderRoot() {
    return this;
  }
  protected override willUpdate(changed: Map<string, unknown>) {
    if (changed.has("paperId") || changed.has("sessionToken")) {
      this.generation++;
      this.data = { purpose: "", draft_url: "", nominee_ids: [] };
      this.suggestions = [];
      this.revision = 0;
      this.loaded = false;
      this.busy = false;
      this.notice = "";
    }
  }
  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }
  private async run(save = false) {
    if (
      this.busy ||
      !this.paperId ||
      !this.sessionToken ||
      loadStoredMemberSession()?.sessionToken !== this.sessionToken ||
      (save && !this.loaded)
    ) {
      return;
    }
    const generation = this.generation;
    const paper = this.paperId;
    const token = this.sessionToken;
    this.busy = true;
    this.notice = "";
    try {
      const response = await fetch(
        `${resolveAdminBotBaseUrl(loadSettings()).replace(/\/$/u, "")}/papers/${encodeURIComponent(paper)}/internal-peer-review`,
        {
          method: save ? "PUT" : "GET",
          headers: { ...memberAuthHeaders(token), "Content-Type": "application/json" },
          signal: AbortSignal.timeout(30000),
          ...(save
            ? {
                body: JSON.stringify({
                  data: this.data,
                  revision: this.revision,
                  mutation_id: crypto.randomUUID(),
                }),
              }
            : {}),
        },
      );
      const result = await response.json();
      if (
        generation !== this.generation ||
        token !== loadStoredMemberSession()?.sessionToken ||
        !this.isConnected
      ) {
        return;
      }
      if (!response.ok) {
        throw new Error(result.error?.message ?? "Could not save or load this draft.");
      }
      this.data = result.draft?.data ?? { purpose: "", draft_url: "", nominee_ids: [] };
      this.revision = result.draft?.revision ?? 0;
      this.loaded = true;
      if (!save) {
        this.suggestions = result.suggestions ?? [];
      }
      this.notice = save
        ? result.detail
        : "Loaded your private draft. Topic matches are suggestions, not availability or consent.";
    } catch (error) {
      if (generation === this.generation) {
        this.notice = error instanceof Error ? error.message : "Draft unavailable.";
      }
    } finally {
      if (generation === this.generation) {
        this.busy = false;
      }
    }
  }
  private edit(
    key: "purpose" | "draft_url" | "nominee_ids",
    value: string | string[],
    event: Event,
  ) {
    event.stopPropagation();
    this.data = { ...this.data, [key]: value };
  }
  override render() {
    return html`<details class="paper-slots__group internal-peer-review">
      <summary>Internal peer review draft</summary>
      <p>
        Save possible reviewers for when your paper is ready. This private working copy sends no
        invitation and grants no document access. Nominations are not accepted assignments.
      </p>
      <button type="button" ?disabled=${this.busy} @click=${() => this.run()}>
        Load my draft and suggestions
      </button>
      ${this.loaded
        ? html`<label
              >What feedback would help?<textarea
                .value=${this.data.purpose}
                maxlength="2000"
                ?disabled=${this.busy}
                @input=${(e: Event) =>
                  this.edit("purpose", (e.target as HTMLTextAreaElement).value, e)}
              ></textarea>
            </label>
            <label
              >Draft link (optional HTTPS URL)<input
                type="url"
                .value=${this.data.draft_url}
                maxlength="2000"
                ?disabled=${this.busy}
                @input=${(e: Event) =>
                  this.edit("draft_url", (e.target as HTMLInputElement).value, e)}
            /></label>
            <label
              >Nominee member IDs (comma separated)<input
                .value=${this.data.nominee_ids.join(", ")}
                ?disabled=${this.busy}
                @input=${(e: Event) =>
                  this.edit(
                    "nominee_ids",
                    (e.target as HTMLInputElement).value
                      .split(",")
                      .map((id) => id.trim())
                      .filter(Boolean),
                    e,
                  )}
            /></label>
            <p>Relevant topic matches:</p>
            <ul>
              ${this.suggestions.map(
                (candidate) =>
                  html`<li>
                    ${candidate.name} (${candidate.member_id}):
                    ${candidate.matched_topics.join(", ")}
                    <button
                      type="button"
                      ?disabled=${this.busy ||
                      this.data.nominee_ids.includes(candidate.member_id) ||
                      this.data.nominee_ids.length >= 10}
                      @click=${(e: Event) =>
                        this.edit(
                          "nominee_ids",
                          [...this.data.nominee_ids, candidate.member_id],
                          e,
                        )}
                    >
                      Nominate
                    </button>
                  </li>`,
              )}
            </ul>
            ${this.suggestions.length
              ? ""
              : "No topical matches. You may nominate a known member by ID."}
            <button type="button" ?disabled=${this.busy} @click=${() => this.run(true)}>
              Save private draft
            </button>`
        : ""}
      <p role="status">${this.notice}</p>
    </details>`;
  }
}
customElements.define("adminbot-internal-peer-review", InternalPeerReview);
