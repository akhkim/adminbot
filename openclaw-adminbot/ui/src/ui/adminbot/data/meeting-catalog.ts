import type { UiSettings } from "../../storage.ts";
// The lab's standing meetings, loaded once per session for the Profile page's picker.
//
// The Calendar tab reads events straight from Google and is admin-only for that reason. This does
// not: the service keeps a catalog of meeting *names* that every signed-in member may read, which
// is the whole reason the profile field can offer real choices to somebody who cannot see the
// calendar itself.
//
// A failure here is deliberately quiet. The field degrades to whatever the member has already
// answered (see multiSelectOptionsFor, which keeps a held value that the vocabulary no longer
// offers), and the rest of the profile form is unaffected -- an unreachable service must not stop
// somebody fixing their phone number.
import {
  fetchMeetingCatalog,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  type MeetingCatalogEntry,
} from "../auth/session.ts";

export type AdminBotMeetingCatalogHost = {
  settings: UiSettings;
  adminBotMeetingCatalog: MeetingCatalogEntry[];
  adminBotMeetingCatalogLoading: boolean;
  /**
   * When the last attempt *finished*, successful or not.
   *
   * "Checked", not "loaded", because that is what the render pass has to know: a field that meant
   * "loaded" would leave a failed read looking like one that had never been tried, and the render
   * pass would ask again on every frame for as long as the tab stayed open.
   */
  adminBotMeetingCatalogCheckedAt: number | null;
};

/** One attempt per session. See the note on adminBotMeetingCatalogCheckedAt. */
export function shouldLoadMeetingCatalog(host: AdminBotMeetingCatalogHost): boolean {
  return !host.adminBotMeetingCatalogLoading && host.adminBotMeetingCatalogCheckedAt === null;
}

export async function loadMeetingCatalog(host: AdminBotMeetingCatalogHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotMeetingCatalog = [];
    return;
  }
  host.adminBotMeetingCatalogLoading = true;
  try {
    const result = await fetchMeetingCatalog(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (result.ok) {
      host.adminBotMeetingCatalog = result.value;
    }
    // A failure keeps whatever was loaded before rather than blanking the picker mid-session, and
    // still stamps the attempt: see adminBotMeetingCatalogCheckedAt.
    host.adminBotMeetingCatalogCheckedAt = Date.now();
  } finally {
    host.adminBotMeetingCatalogLoading = false;
  }
}

/**
 * The topics the picker offers, deduplicated the way the service deduplicates them.
 *
 * Two families can name one topic ("Theme: Multi-Agent" and "Proj: Multi-Agent"), and a member
 * asked to choose between two identical boxes cannot tell which is which. One box is offered; if
 * the calendar really does carry two such meetings the service refuses to guess which was meant
 * and records why (see resolveMeetingChoice), so the ambiguity is reported rather than acted on.
 */
export function meetingCatalogOptions(catalog: readonly MeetingCatalogEntry[]): string[] {
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const entry of catalog) {
    const topic = entry.topic?.trim() ?? "";
    const key = topic.toLowerCase();
    if (topic && !seen.has(key)) {
      seen.add(key);
      topics.push(topic);
    }
  }
  return topics;
}
