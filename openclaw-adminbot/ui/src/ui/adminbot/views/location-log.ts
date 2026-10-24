// An admin's view of one member's location log: every observation the service kept, newest first.
//
// The member map shows one pin and the one moment behind it. This is the rest: each sign-in city,
// device city, Slack profile and Slack zone change, and every answer to the check-in -- including
// "Ask me later" and "Prefer not to say", which place nothing but show that the member was asked
// and what they did. Admin only, like the route it reads (GET /lab/members/:id/locations): a
// colleague's movement history is not roster data.
//
// A small element that reads for itself, so the Time Availability view that hosts it needs no new
// state on the app: give it a member and a base URL and it fetches when either changes.
import { html, LitElement, nothing } from "lit";
import { t } from "../../../i18n/index.ts";
import { fetchMemberResource, loadStoredMemberSession } from "../auth/session.ts";

/** One row of GET /lab/members/:id/locations, as far as this view reads it. */
export type LocationLogEntry = {
  id: string;
  observed_at: string;
  observed_at_local?: string;
  source: string;
  raw: string;
  place_label?: string;
  country?: string;
  checkin?: "answered" | "snoozed" | "declined";
  checkin_via?: string;
};

export type LocationLogRow = {
  id: string;
  /** The calendar day it happened, in the zone it happened in when the service knew it. */
  day: string;
  source: string;
  what: string;
  outcome?: string;
};

/** How many rows are read. The route keeps more; this is a recent-history panel, not an export. */
export const LOCATION_LOG_LIMIT = 30;

const SOURCE_KEYS: Record<string, string> = {
  self_reported: "locationLog.source.selfReported",
  login_ip: "locationLog.source.loginIp",
  slack_profile: "locationLog.source.slackProfile",
  slack_timezone: "locationLog.source.slackTimezone",
  device: "locationLog.source.device",
  admin: "locationLog.source.admin",
};

export function parseLocationLog(body: unknown): LocationLogEntry[] {
  const list = (body as { locations?: unknown } | null)?.locations;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.flatMap((raw) => {
    const entry = raw as Partial<LocationLogEntry> | null;
    return entry &&
      typeof entry.id === "string" &&
      typeof entry.observed_at === "string" &&
      typeof entry.source === "string"
      ? [{ ...entry, raw: typeof entry.raw === "string" ? entry.raw : "" } as LocationLogEntry]
      : [];
  });
}

/** The entries as the table shows them. Pure, so the wording is testable without a service. */
export function locationLogRows(entries: readonly LocationLogEntry[]): LocationLogRow[] {
  return entries.map((entry) => {
    // observed_at_local is "2026-07-15T08:00:00-04:00": its date part is the local day.
    const day = (entry.observed_at_local ?? entry.observed_at).slice(0, 10);
    const sourceKey = SOURCE_KEYS[entry.source];
    const source =
      entry.checkin && entry.source === "self_reported"
        ? t("locationLog.source.checkin")
        : sourceKey
          ? t(sourceKey)
          : entry.source;
    const place = entry.place_label
      ? [entry.place_label, entry.country].filter(Boolean).join(", ")
      : entry.raw;
    const outcome =
      entry.checkin === "snoozed"
        ? t("locationLog.outcome.snoozed")
        : entry.checkin === "declined"
          ? t("locationLog.outcome.declined")
          : entry.checkin === "answered" && entry.checkin_via === "device"
            ? t("locationLog.outcome.device")
            : undefined;
    return {
      id: entry.id,
      day,
      source,
      // A non-answer has no place; its row says what they chose instead.
      what: entry.checkin === "snoozed" || entry.checkin === "declined" ? "" : place,
      ...(outcome ? { outcome } : {}),
    };
  });
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading"; key: string }
  | { kind: "loaded"; key: string; entries: LocationLogEntry[] }
  | { kind: "failed"; key: string };

class AdminbotLocationLog extends LitElement {
  static override properties = {
    memberId: { attribute: false },
    baseUrl: { attribute: false },
    loadState: { state: true },
  };

  public memberId = "";
  public baseUrl = "";
  private loadState: LoadState = { kind: "idle" };

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  protected override willUpdate(): void {
    const key = `${this.baseUrl}|${this.memberId}`;
    if (!this.memberId || ("key" in this.loadState && this.loadState.key === key)) {
      return;
    }
    const token = loadStoredMemberSession()?.sessionToken;
    if (!token) {
      return;
    }
    this.loadState = { kind: "loading", key };
    void fetchMemberResource(
      `/lab/members/${encodeURIComponent(this.memberId)}/locations?limit=${LOCATION_LOG_LIMIT}`,
      token,
      this.baseUrl,
    ).then((result) => {
      // A different member picked while this was in flight: that read owns the panel now.
      if ("key" in this.loadState && this.loadState.key !== key) {
        return;
      }
      this.loadState = result.ok
        ? { kind: "loaded", key, entries: parseLocationLog(result.value) }
        : { kind: "failed", key };
    });
  }

  protected override render() {
    const state = this.loadState;
    return html`
      <section class="adminbot-location-log" data-testid="location-log">
        <h4 class="adminbot-location-log__title">${t("locationLog.title")}</h4>
        ${state.kind === "loaded"
          ? renderLocationLogRows(locationLogRows(state.entries))
          : html`<p class="muted">
              ${state.kind === "failed" ? t("locationLog.failed") : t("locationLog.loading")}
            </p>`}
      </section>
    `;
  }
}

export function renderLocationLogRows(rows: readonly LocationLogRow[]) {
  if (rows.length === 0) {
    return html`<p class="muted">${t("locationLog.empty")}</p>`;
  }
  return html`
    <ol class="adminbot-location-log__list">
      ${rows.map(
        (row) => html`<li class="adminbot-location-log__row">
          <time class="adminbot-location-log__day">${row.day}</time>
          <span class="adminbot-location-log__source">${row.source}</span>
          ${row.what ? html`<span class="adminbot-location-log__what">${row.what}</span>` : nothing}
          ${row.outcome
            ? html`<span class="adminbot-location-log__outcome">${row.outcome}</span>`
            : nothing}
        </li>`,
      )}
    </ol>
  `;
}

if (!customElements.get("adminbot-location-log")) {
  customElements.define("adminbot-location-log", AdminbotLocationLog);
}

/** The panel for one member. Renders nothing without one. */
export function renderLocationLog(memberId: string | undefined, baseUrl: string) {
  return memberId
    ? html`<adminbot-location-log
        .memberId=${memberId}
        .baseUrl=${baseUrl}
      ></adminbot-location-log>`
    : nothing;
}
