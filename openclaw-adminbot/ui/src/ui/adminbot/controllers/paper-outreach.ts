// The research-outreach half of the Mailing List tab: one draft per outlet for a venue's
// acceptances, and the lab's acceptance tab kept in step with our records.
//
// Three calls. The read returns every draft already composed; a send posts only the venue and the
// outlet's key, and the service recomposes the draft and takes the recipients from its own
// configuration -- so a stale tab cannot mail an old list and the browser never names an address.
// The sheet call is a comparison first and a write second, each its own press.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchPaperOutreach,
  sendPaperOutreach,
  syncAcceptanceSheet,
  type AcceptanceSheetSync,
  type PaperOutreach,
} from "../api/paper-admin.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";

/** Held as one value and replaced whole, so a single host field carries the section. */
export type AdminBotOutreachState = {
  data: PaperOutreach | null;
  loading: boolean;
  /** The outlet key being sent, or "sheet" while the acceptance tab is read or written. */
  busy: string | null;
  error: string | null;
  notice: string | null;
  /** Outlets mailed since this venue was loaded, so a second press is a visible choice. */
  sent: string[];
  /** The last comparison with the acceptance tab. Cleared whenever the records are re-read. */
  sheet: AcceptanceSheetSync | null;
};

export const EMPTY_OUTREACH_STATE: AdminBotOutreachState = {
  data: null,
  loading: false,
  busy: null,
  error: null,
  notice: null,
  sent: [],
  sheet: null,
};

export type AdminBotOutreachHost = {
  settings: UiSettings;
  adminBotOutreach: AdminBotOutreachState;
};

function patch(host: AdminBotOutreachHost, change: Partial<AdminBotOutreachState>): void {
  host.adminBotOutreach = { ...host.adminBotOutreach, ...change };
}

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("mailingList.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("mailingList.error.forbidden");
  }
  return result.message ?? t("mailingList.outreach.error.failed");
}

function session(host: AdminBotOutreachHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

/** Reads the drafts for a venue ("" = none, which still returns the acceptance rows). */
export async function loadAdminBotOutreach(
  host: AdminBotOutreachHost,
  venue: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    return;
  }
  // Everything that described the previous read goes with it, the sent marks included: they were
  // about another venue's drafts.
  host.adminBotOutreach = { ...EMPTY_OUTREACH_STATE, loading: true };
  const result = await fetchPaperOutreach(venue.trim(), wire.token, wire.baseUrl);
  host.adminBotOutreach = result.ok
    ? { ...EMPTY_OUTREACH_STATE, data: result.value }
    : { ...EMPTY_OUTREACH_STATE, error: failureText(result, wire.baseUrl) };
}

export async function sendAdminBotOutreach(
  host: AdminBotOutreachHost,
  outlet: string,
): Promise<void> {
  const wire = session(host);
  const venue = host.adminBotOutreach.data?.venue;
  if (!wire || !venue || host.adminBotOutreach.busy) {
    return;
  }
  patch(host, { busy: outlet, error: null, notice: null });
  const result = await sendPaperOutreach({ venue, outlet }, wire.token, wire.baseUrl);
  if (!result.ok) {
    patch(host, { busy: null, error: failureText(result, wire.baseUrl) });
    return;
  }
  patch(host, {
    busy: null,
    sent: [...host.adminBotOutreach.sent, outlet],
    notice: t("mailingList.outreach.sent", {
      count: String(result.value.papers),
      recipients: result.value.recipients.join(", "),
    }),
  });
}

/** Compares the acceptance tab with our records, or with `write` appends what it lacks. */
export async function syncAdminBotAcceptanceSheet(
  host: AdminBotOutreachHost,
  write: boolean,
): Promise<void> {
  const wire = session(host);
  if (!wire || host.adminBotOutreach.busy) {
    return;
  }
  patch(host, { busy: "sheet", error: null, notice: null });
  const result = await syncAcceptanceSheet({ dry_run: !write }, wire.token, wire.baseUrl);
  if (!result.ok) {
    patch(host, { busy: null, error: failureText(result, wire.baseUrl) });
    return;
  }
  patch(host, {
    busy: null,
    // After a write the sheet holds everything, so the comparison on screen says so rather than
    // still offering the rows that were just added.
    sheet: write ? { ...result.value, missing: [] } : result.value,
    notice: write
      ? t("mailingList.outreach.sheet.added", { count: String(result.value.added) })
      : null,
  });
}
