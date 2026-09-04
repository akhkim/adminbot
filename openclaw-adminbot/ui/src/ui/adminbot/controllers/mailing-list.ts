// The Mailing List tab's side of the wire.
//
// Two calls, deliberately separate: read what the digest for a range would contain, and mail it.
// The send recomputes the digest server-side from the same range rather than posting the previewed
// body back, so a stale tab left open across a paper being filed cannot mail yesterday's list --
// and nothing the browser holds decides what leaves the lab.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchPublicationDigest,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  sendPublicationDigest,
  type PublicationDigestPreview,
} from "../auth/session.ts";

export type AdminBotMailingListHost = {
  settings: UiSettings;
  adminBotMailingListPreview: PublicationDigestPreview | null;
  adminBotMailingListLoading: boolean;
  adminBotMailingListSending: boolean;
  adminBotMailingListError: string | null;
  adminBotMailingListNotice: string | null;
  adminBotMailingListFrom: string;
  adminBotMailingListTo: string;
  adminBotMailingListEmail: string;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("mailingList.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("mailingList.error.forbidden");
  }
  return result.message ?? t("mailingList.error.failed");
}

function session(host: AdminBotMailingListHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

/** The calendar year to date: the range somebody almost always wants, so it is the one on open. */
export function defaultMailingListRange(now = new Date()): { from: string; to: string } {
  const year = now.getUTCFullYear();
  return { from: `${year}-01-01`, to: now.toISOString().slice(0, 10) };
}

export async function loadAdminBotMailingList(host: AdminBotMailingListHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotMailingListError = t("mailingList.error.signIn");
    return;
  }
  host.adminBotMailingListLoading = true;
  host.adminBotMailingListError = null;
  // Cleared with the preview it referred to: a "sent to X" notice sitting above a freshly
  // previewed different range reads as though that range had been sent.
  host.adminBotMailingListNotice = null;
  try {
    const result = await fetchPublicationDigest(
      { from: host.adminBotMailingListFrom, to: host.adminBotMailingListTo },
      wire.token,
      wire.baseUrl,
    );
    if (!result.ok) {
      host.adminBotMailingListPreview = null;
      host.adminBotMailingListError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotMailingListPreview = result.value;
  } finally {
    host.adminBotMailingListLoading = false;
  }
}

export async function sendAdminBotMailingList(host: AdminBotMailingListHost): Promise<void> {
  const wire = session(host);
  const email = host.adminBotMailingListEmail.trim();
  if (!wire || !email) {
    host.adminBotMailingListError = t("mailingList.error.signIn");
    return;
  }
  host.adminBotMailingListSending = true;
  host.adminBotMailingListError = null;
  host.adminBotMailingListNotice = null;
  try {
    const result = await sendPublicationDigest(
      { from: host.adminBotMailingListFrom, to: host.adminBotMailingListTo, email },
      wire.token,
      wire.baseUrl,
    );
    if (!result.ok) {
      host.adminBotMailingListError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotMailingListNotice = t("mailingList.sent", {
      count: String(result.value.publications),
      email: result.value.recipient,
    });
  } finally {
    host.adminBotMailingListSending = false;
  }
}
