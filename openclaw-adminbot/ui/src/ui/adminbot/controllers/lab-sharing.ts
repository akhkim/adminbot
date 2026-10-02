// The Collaborate tab's reads and writes, held together.
//
// The panels are the design from #23 and were written against fixtures; this is the layer that
// stands where those fixtures used to. It keeps the same rule the rest of the AdminBot controllers
// keep: the view decides what to show, the controller decides what to fetch, and neither reaches
// into the other's state.
//
// Every action reloads afterwards rather than patching the snapshot in place. These are six panels
// over the same few rows -- a post also changes what Discover shows and what "your requests"
// counts -- and a hand-maintained local patch is how two panels come to disagree about the same
// paper.
import type { UiSettings } from "../../storage.ts";
import { resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  closeLabSharingRequest,
  loadLabSharing,
  offerLabSharingInterest,
  requestLabSharingInvite,
  saveLabSharingRequest,
  searchLabSharingMembers,
  type LabSharingMemberMatch,
  type LabSharingSnapshot,
} from "../data/lab-sharing.ts";

export type AdminBotLabSharingHost = {
  settings: UiSettings;
  labSharing?: LabSharingSnapshot;
  labSharingLoading?: boolean;
  labSharingErrors?: string[];
  labSharingMembers?: LabSharingMemberMatch[];
  labSharingMembersTruncated?: boolean;
  labSharingBusy?: boolean;
  labSharingNotice?: string | null;
};

function baseUrlOf(host: AdminBotLabSharingHost): string {
  return resolveAdminBotBaseUrl(host.settings);
}

export async function loadAdminBotLabSharing(host: AdminBotLabSharingHost): Promise<void> {
  host.labSharingLoading = true;
  try {
    const { snapshot, errors } = await loadLabSharing(baseUrlOf(host));
    host.labSharing = snapshot;
    host.labSharingErrors = errors;
  } finally {
    host.labSharingLoading = false;
  }
}

/**
 * Runs one write, then re-reads.
 *
 * Shared by all four actions so none of them can forget the re-read, and so the busy flag is set
 * and cleared in exactly one place -- a panel left disabled by an early return is the failure mode
 * this shape exists to make impossible.
 */
async function act(
  host: AdminBotLabSharingHost,
  run: (baseUrl: string) => Promise<{ ok: boolean; error?: string }>,
  done: string,
): Promise<boolean> {
  host.labSharingBusy = true;
  host.labSharingNotice = null;
  try {
    const result = await run(baseUrlOf(host));
    if (!result.ok) {
      host.labSharingNotice = result.error ?? "That did not go through.";
      return false;
    }
    await loadAdminBotLabSharing(host);
    host.labSharingNotice = done;
    return true;
  } finally {
    host.labSharingBusy = false;
  }
}

export function postAdminBotLabSharingRequest(
  host: AdminBotLabSharingHost,
  paperId: string,
  body: {
    description: string;
    tags: string[];
    members_needed: number;
    hours_per_week: number;
    timeline: string;
  },
): Promise<boolean> {
  return act(
    host,
    (baseUrl) => saveLabSharingRequest(baseUrl, paperId, body),
    "Posted. It is on the board for the lab to see.",
  );
}

export function closeAdminBotLabSharingRequest(
  host: AdminBotLabSharingHost,
  paperId: string,
): Promise<boolean> {
  return act(host, (baseUrl) => closeLabSharingRequest(baseUrl, paperId), "Taken down.");
}

export function offerAdminBotLabSharingHelp(
  host: AdminBotLabSharingHost,
  paperId: string,
  body: { hours_per_week: number; note: string },
): Promise<boolean> {
  return act(
    host,
    (baseUrl) => offerLabSharingInterest(baseUrl, paperId, body),
    "Your offer is on the project; its owner sees it on theirs.",
  );
}

export function askAdminBotLabSharingMember(
  host: AdminBotLabSharingHost,
  body: { recipient_id: string; paper_id: string; kind: string; note: string },
): Promise<boolean> {
  return act(
    host,
    (baseUrl) => requestLabSharingInvite(baseUrl, body),
    // Deliberately not "sent": an invitation waits for an admin before it reaches anybody, and a
    // message saying otherwise would have the asker waiting on a reply nobody has been asked for.
    "Filed. It reaches them once an admin approves it.",
  );
}

export async function searchAdminBotLabSharingMembers(
  host: AdminBotLabSharingHost,
  query: string,
): Promise<void> {
  const result = await searchLabSharingMembers(baseUrlOf(host), query);
  host.labSharingMembers = result.members;
  host.labSharingMembersTruncated = result.truncated;
  if (result.error) {
    host.labSharingNotice = result.error;
  }
}
