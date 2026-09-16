// What the Collaborate tab reads and writes, as the service actually shapes it.
//
// The tab's panels are the design from #23; these are the routes that grew under them afterwards
// (extensions/adminbot/src/api/server.lab-sharing.ts). Keeping the wire types here, in the service's
// own spelling -- snake_case, `paper_id` rather than `id` -- means the view does the translating in
// one place and nothing silently half-renames a field.
//
// Every function answers rather than throws. The panels are six independent strips: one endpoint
// being down is a reason for that strip to say so, not for the tab to fail to render.
import { loadStoredMemberSession } from "../auth/session.ts";

/** One "help wanted" post, on somebody's paper. The unit both Discover and Your Requests read. */
export type LabSharingHelpRequest = {
  paper_id: string;
  title: string;
  owner_name: string;
  description: string;
  tags: string[];
  members_needed: number;
  hours_per_week: number;
  timeline: string;
  status: "open" | "closed";
  /** True where the viewer owns the paper, so the row may be edited or closed. */
  can_manage: boolean;
};

export type LabSharingMemberMatch = {
  id: string;
  name: string;
  research_branch: string;
  research_topics: string[];
  matched_fields: string[];
  projects: { id: string; title: string }[];
};

/**
 * The lab-wide broadcast, as read by everybody.
 *
 * Written on My Desk rather than here -- one surface writes it, this one reads it. Note what it
 * does *not* carry: no per-person local clock, no progress figure. The panel that reads it was
 * drawn around both, and neither exists.
 */
export type LabSharingSharedStatus = {
  availability: string;
  message: string;
  updated_at: string;
  expires_at: string;
  retracted_at?: string;
};

/**
 * An invitation the viewer has *sent*, and where it has got to.
 *
 * The direction is worth stating because the panel that shows these was drawn for the opposite
 * one: invitations here are outgoing and pass an admin before they reach anybody (`pending` ->
 * `approved` -> `executed`). There is no incoming-invite record to accept or decline.
 */
export type LabSharingInvite = {
  id: string;
  status: string;
  kind: string;
  project_title: string;
  recipient_name: string;
};

export type LabSharingSnapshot = {
  /** Papers the viewer can post a request against. */
  projects: { id: string; title: string }[];
  /** The viewer's own posts. */
  mine: LabSharingHelpRequest[];
  /** Everybody else's open posts. */
  open: LabSharingHelpRequest[];
  invites: LabSharingInvite[];
  status: LabSharingSharedStatus | null;
};

export const EMPTY_LAB_SHARING: LabSharingSnapshot = {
  projects: [],
  mine: [],
  open: [],
  invites: [],
  status: null,
};

type Wire = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

async function call(
  baseUrl: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Wire> {
  const session = loadStoredMemberSession();
  if (!session) {
    return { ok: false, error: "Sign in to use Collaborate." };
  }
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, "")}/lab-sharing${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${session.sessionToken}`,
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = (data.error as { message?: string } | undefined)?.message;
      return { ok: false, error: message ?? `The service answered ${response.status}.` };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requests(value: unknown): LabSharingHelpRequest[] {
  return Array.isArray(value) ? (value as LabSharingHelpRequest[]) : [];
}

/**
 * Everything the tab opens with, in one pass.
 *
 * Four reads in parallel rather than in series: they are independent, and a member watching a
 * spinner for the sum of four round trips is watching three of them for no reason. A read that
 * fails contributes its own message and leaves the rest of the tab populated.
 */
export async function loadLabSharing(
  baseUrl: string,
): Promise<{ snapshot: LabSharingSnapshot; errors: string[] }> {
  const [mine, open, invites, status] = await Promise.all([
    call(baseUrl, "/mine"),
    call(baseUrl, "/discover?sort=title&limit=20"),
    call(baseUrl, "/invites"),
    call(baseUrl, "/status"),
  ]);
  const errors: string[] = [];
  const snapshot: LabSharingSnapshot = { ...EMPTY_LAB_SHARING };
  if (mine.ok) {
    snapshot.projects = Array.isArray(mine.data.projects)
      ? (mine.data.projects as { id: string; title: string }[])
      : [];
    snapshot.mine = requests(mine.data.requests);
  } else {
    errors.push(mine.error);
  }
  if (open.ok) {
    // Discover answers with everybody's open posts, the viewer's own included; those already have
    // a panel of their own, and a row that appears twice on one page reads as two projects.
    const ownIds = new Set(snapshot.mine.map((row) => row.paper_id));
    snapshot.open = requests(open.data.requests).filter((row) => !ownIds.has(row.paper_id));
  } else {
    errors.push(open.error);
  }
  if (invites.ok) {
    snapshot.invites = Array.isArray(invites.data.invites)
      ? (invites.data.invites as LabSharingInvite[])
      : [];
  } else {
    errors.push(invites.error);
  }
  if (status.ok) {
    snapshot.status = (status.data.status as LabSharingSharedStatus | null) ?? null;
  } else {
    errors.push(status.error);
  }
  return { snapshot, errors };
}

/** Name search, for the "find lab members" strip. Debouncing belongs to the caller. */
export async function searchLabSharingMembers(
  baseUrl: string,
  query: string,
): Promise<{ members: LabSharingMemberMatch[]; truncated: boolean; error?: string }> {
  const result = await call(baseUrl, `/members?q=${encodeURIComponent(query.trim())}`);
  if (!result.ok) {
    return { members: [], truncated: false, error: result.error };
  }
  return {
    members: Array.isArray(result.data.members)
      ? (result.data.members as LabSharingMemberMatch[])
      : [],
    truncated: Boolean(result.data.truncated),
  };
}

/** Posts (or rewrites) the viewer's help request on one of their papers. */
export async function saveLabSharingRequest(
  baseUrl: string,
  paperId: string,
  body: {
    description: string;
    tags: string[];
    members_needed: number;
    hours_per_week: number;
    timeline: string;
  },
): Promise<{ ok: boolean; error?: string }> {
  const result = await call(baseUrl, `/requests/${encodeURIComponent(paperId)}`, {
    method: "PUT",
    body,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Takes the viewer's own post down. The service keeps the row and marks it closed. */
export async function closeLabSharingRequest(
  baseUrl: string,
  paperId: string,
): Promise<{ ok: boolean; error?: string }> {
  const result = await call(baseUrl, `/requests/${encodeURIComponent(paperId)}/close`, {
    method: "POST",
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** Offers to help on somebody else's post. `withdraw` takes the offer back. */
export async function offerLabSharingInterest(
  baseUrl: string,
  paperId: string,
  body: { hours_per_week: number; note: string },
  withdraw = false,
): Promise<{ ok: boolean; error?: string }> {
  const path = `/requests/${encodeURIComponent(paperId)}/interest${withdraw ? "/withdraw" : ""}`;
  const result = await call(baseUrl, path, { method: "POST", body: withdraw ? {} : body });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Asks to collaborate with one member on one paper.
 *
 * Files a proposal rather than sending anything: the invitation reaches its recipient only after an
 * admin approves it, which is why the panel reports a status rather than "sent".
 */
export async function requestLabSharingInvite(
  baseUrl: string,
  body: { recipient_id: string; paper_id: string; kind: string; note: string },
): Promise<{ ok: boolean; error?: string }> {
  const result = await call(baseUrl, "/invites", { method: "POST", body });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
