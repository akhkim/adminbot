// Nudge campaigns in the admin UI: one button that previews before it sends, and the list of
// campaigns with whom each has reached. The server side is extensions/adminbot/src/workflows/
// nudges/campaign.ts; every campaign route takes `{dry_run, confirm}` and answers the same shape,
// so one element serves all of them.
//
// <adminbot-nudge-campaign route="/members/some-nudge" label="Ask on Slack">
//   1. The button asks for a dry run: count, skips by reason, up to three sample messages.
//   2. "Send to N" posts `{dry_run: false, confirm: N}`. The server refuses if the count moved since
//      the preview (409), and the element shows that refusal and offers a fresh preview.
// Nothing is sent without that second, explicit press.
import { html, LitElement, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { memberAuthHeaders } from "../api/device-clock.ts";

export type NudgeCampaignSample = { member_id: string; name: string; message: string };

export type NudgeCampaignResult = {
  campaign: string;
  dry_run: boolean;
  count: number;
  skipped: Record<string, number>;
  samples: NudgeCampaignSample[];
  sent?: number;
  failed?: Array<{ member_id: string; reason: string }>;
};

export type NudgeCampaignListing = {
  key: string;
  label: string;
  description: string;
  route: string;
  cooldown_days: number | null;
  scheduled: boolean;
  members_reached: number;
  last_sent_at?: string;
};

/** Plain words for the module's skip reasons; an unknown reason shows as itself. */
export const NUDGE_SKIP_LABELS: Record<string, string> = {
  already_sent: "already asked",
  nudges_off: "nudges turned off",
  no_slack_id: "no Slack account linked",
  head_professor: "head professor",
  on_leave: "on leave",
  compliant: "photo meets the guidelines",
};

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, "");
}

function errorText(body: unknown, fallback: string): string {
  const record = body as { error?: { message?: unknown }; message?: unknown } | null;
  const message = record?.error?.message ?? record?.message;
  return typeof message === "string" && message ? message : fallback;
}

/** Reads a campaign response defensively: an unexpected shape is an error, never a zero. */
export function parseNudgeCampaignResult(raw: unknown): NudgeCampaignResult | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const body = raw as Partial<NudgeCampaignResult>;
  if (
    typeof body.campaign !== "string" ||
    typeof body.dry_run !== "boolean" ||
    typeof body.count !== "number"
  ) {
    return null;
  }
  const skipped: Record<string, number> = {};
  for (const [reason, n] of Object.entries(body.skipped ?? {})) {
    if (typeof n === "number" && n > 0) {
      skipped[reason] = n;
    }
  }
  const samples = Array.isArray(body.samples)
    ? body.samples.filter(
        (s): s is NudgeCampaignSample =>
          Boolean(s) &&
          typeof s.member_id === "string" &&
          typeof s.name === "string" &&
          typeof s.message === "string",
      )
    : [];
  return {
    campaign: body.campaign,
    dry_run: body.dry_run,
    count: body.count,
    skipped,
    samples,
    ...(typeof body.sent === "number" ? { sent: body.sent } : {}),
    ...(Array.isArray(body.failed) ? { failed: body.failed } : {}),
  };
}

export function skipSummary(skipped: Record<string, number>): string {
  return Object.entries(skipped)
    .map(([reason, n]) => `${n} ${NUDGE_SKIP_LABELS[reason] ?? reason.replaceAll("_", " ")}`)
    .join(" · ");
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy"; what: "preview" | "send" }
  | { kind: "preview"; result: NudgeCampaignResult }
  | { kind: "done"; result: NudgeCampaignResult }
  | { kind: "error"; message: string };

export class AdminBotNudgeCampaign extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  /** The campaign's route, e.g. `/members/some-nudge`. */
  @property() route = "";
  @property() label = "";
  @state() private phase: Phase = { kind: "idle" };
  private generation = 0;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl") || changed.has("route")) {
      this.generation++;
      this.phase = { kind: "idle" };
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  private async post(body: { dry_run: boolean; confirm?: number }) {
    const generation = ++this.generation;
    this.phase = { kind: "busy", what: body.dry_run ? "preview" : "send" };
    try {
      const response = await fetch(`${trimBase(this.baseUrl)}${this.route}`, {
        method: "POST",
        headers: {
          ...memberAuthHeaders(this.sessionToken),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const json = (await response.json().catch(() => null)) as unknown;
      if (generation !== this.generation) {
        return;
      }
      const result = response.ok ? parseNudgeCampaignResult(json) : null;
      if (!result) {
        this.phase = {
          kind: "error",
          message: errorText(
            json,
            response.ok ? "Unexpected response." : "Could not reach AdminBot.",
          ),
        };
        return;
      }
      this.phase = result.dry_run ? { kind: "preview", result } : { kind: "done", result };
      if (!result.dry_run) {
        this.dispatchEvent(
          new CustomEvent("nudge-campaign-sent", { bubbles: true, composed: true }),
        );
      }
    } catch {
      if (generation === this.generation) {
        this.phase = { kind: "error", message: "Could not reach AdminBot." };
      }
    }
  }

  preview() {
    return this.post({ dry_run: true });
  }

  send() {
    if (this.phase.kind !== "preview" || this.phase.result.count === 0) {
      return Promise.resolve();
    }
    return this.post({ dry_run: false, confirm: this.phase.result.count });
  }

  private cancel() {
    this.generation++;
    this.phase = { kind: "idle" };
  }

  private renderPreview(result: NudgeCampaignResult) {
    const skips = skipSummary(result.skipped);
    return html`<div class="nudge-campaign__preview" data-testid="nudge-campaign-preview">
      <p>
        <strong>${result.count}</strong> ${result.count === 1 ? "member" : "members"} would get
        this.${skips ? html` <span class="muted">Skipped: ${skips}.</span>` : nothing}
      </p>
      ${result.samples.map(
        (sample) =>
          html`<figure class="nudge-campaign__sample" data-member=${sample.member_id}>
            <figcaption class="muted">To ${sample.name}</figcaption>
            <blockquote style="white-space: pre-wrap">${sample.message}</blockquote>
          </figure>`,
      )}
      <div class="row">
        ${result.count > 0
          ? html`<button
              class="btn primary"
              data-testid="nudge-campaign-send"
              @click=${() => void this.send()}
            >
              Send to ${result.count}
            </button>`
          : nothing}
        <button class="btn" @click=${() => this.cancel()}>
          ${result.count > 0 ? "Cancel" : "Close"}
        </button>
      </div>
    </div>`;
  }

  private renderDone(result: NudgeCampaignResult) {
    const failed = result.failed ?? [];
    return html`<div class="nudge-campaign__done" role="status" data-testid="nudge-campaign-done">
      <p>
        Sent to ${result.sent ?? 0} of
        ${result.count}.${failed.length ? html` ${failed.length} could not be delivered.` : nothing}
      </p>
      ${failed.length
        ? html`<ul class="muted">
            ${failed.map((f) => html`<li>${f.member_id}: ${f.reason}</li>`)}
          </ul>`
        : nothing}
      <button class="btn" @click=${() => this.cancel()}>Close</button>
    </div>`;
  }

  override render() {
    if (!this.sessionToken || !this.route) {
      return nothing;
    }
    const phase = this.phase;
    return html`<div class="nudge-campaign" data-route=${this.route}>
      ${phase.kind === "preview"
        ? this.renderPreview(phase.result)
        : phase.kind === "done"
          ? this.renderDone(phase.result)
          : html`<button
              class="btn"
              data-testid="nudge-campaign-preview-button"
              ?disabled=${phase.kind === "busy"}
              @click=${() => void this.preview()}
            >
              ${phase.kind === "busy" ? "Checking…" : this.label}
            </button>`}
      ${phase.kind === "error"
        ? html`<p class="muted" role="alert">
            ${phase.message}
            <button class="btn btn--sm" @click=${() => void this.preview()}>Preview again</button>
          </p>`
        : nothing}
    </div>`;
  }
}

export function parseNudgeCampaignListing(raw: unknown): NudgeCampaignListing[] | null {
  const list = (raw as { campaigns?: unknown } | null)?.campaigns;
  if (!Array.isArray(list)) {
    return null;
  }
  return list.filter(
    (c): c is NudgeCampaignListing =>
      Boolean(c) &&
      typeof c.key === "string" &&
      typeof c.label === "string" &&
      typeof c.route === "string" &&
      typeof c.members_reached === "number",
  );
}

export function cooldownText(days: number | null): string {
  return days === null ? "once per member" : days === 0 ? "every run" : `at most every ${days}d`;
}

/** The campaigns the server knows, with who each has reached. Read-only; sending is per campaign. */
export class AdminBotNudgeCampaigns extends LitElement {
  @property() baseUrl = "";
  @property() sessionToken = "";
  @state() private campaigns: NudgeCampaignListing[] | null = null;
  @state() private error = "";
  private generation = 0;

  protected override createRenderRoot() {
    return this;
  }

  protected override willUpdate(changed: PropertyValues) {
    if (changed.has("sessionToken") || changed.has("baseUrl")) {
      this.campaigns = null;
      this.error = "";
      void this.load();
    }
  }

  override disconnectedCallback() {
    this.generation++;
    super.disconnectedCallback();
  }

  async load() {
    if (!this.sessionToken) {
      return;
    }
    const generation = ++this.generation;
    try {
      const response = await fetch(`${trimBase(this.baseUrl)}/nudges/campaigns`, {
        headers: memberAuthHeaders(this.sessionToken),
      });
      const parsed = response.ok ? parseNudgeCampaignListing(await response.json()) : null;
      if (generation !== this.generation) {
        return;
      }
      if (!parsed) {
        throw new Error("unavailable");
      }
      this.campaigns = parsed;
      this.error = "";
    } catch {
      if (generation === this.generation) {
        this.error = "Nudge campaigns could not be loaded.";
      }
    }
  }

  override render() {
    if (!this.sessionToken) {
      return nothing;
    }
    const campaigns = this.campaigns;
    return html`<section class="card nudge-campaigns" data-testid="nudge-campaigns">
      <div class="card-title">Nudge campaigns</div>
      ${this.error
        ? html`<p class="muted" role="alert">${this.error}</p>`
        : !campaigns
          ? html`<p class="muted" role="status">Loading…</p>`
          : html`<table>
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Asks</th>
                  <th>Reached</th>
                  <th>Last sent</th>
                </tr>
              </thead>
              <tbody>
                ${campaigns.map(
                  (c) =>
                    html`<tr data-campaign=${c.key}>
                      <td title=${c.description}>
                        ${c.label}${c.scheduled
                          ? html` <span class="muted">(scheduled)</span>`
                          : nothing}
                      </td>
                      <td>${cooldownText(c.cooldown_days)}</td>
                      <td>${c.members_reached}</td>
                      <td>${c.last_sent_at ? c.last_sent_at.slice(0, 10) : "never"}</td>
                    </tr>`,
                )}
              </tbody>
            </table>`}
    </section>`;
  }
}

if (!customElements.get("adminbot-nudge-campaign")) {
  customElements.define("adminbot-nudge-campaign", AdminBotNudgeCampaign);
}
if (!customElements.get("adminbot-nudge-campaigns")) {
  customElements.define("adminbot-nudge-campaigns", AdminBotNudgeCampaigns);
}
