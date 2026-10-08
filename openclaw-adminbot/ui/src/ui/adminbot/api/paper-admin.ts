// AdminBot client: Lab-wide paper boards and sweeps.
//
// Mirrors the service's api/routes/paper-admin.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  type PaperFeedback,
  parsePaperFeedback,
} from "../../../../../extensions/adminbot/src/contracts/paper-feedback.js";
import { authedJson, type AuthResult, calendarFailure, mapErrorResponse } from "../auth/session.ts";

/**
 * The roster rows the lab holds no address for, and which of them may go.
 *
 * A read, so the page can show the list before anybody presses anything. `blocked` is the half
 * that matters on screen: it is where the shared `admin` login turns up, and an admin who cannot
 * see why a row survived the purge will assume the purge is broken.
 */
/** One paper in the publication digest, as the preview returns it. */
export type PublicationDigestEntry = {
  id: string;
  title: string;
  authors: string[];
  venue?: string;
  url?: string;
  /** Absent only in venue mode, where acceptance puts a paper in the list rather than its date. */
  date?: { iso: string; precision: "month" | "year"; source: "arxiv" | "accepted_year" };
};

/** A venue the picker offers, with what a digest for it would hold. */
export type PublicationDigestVenue = {
  key: string;
  label: string;
  accepted: number;
  pending: number;
};

export type PublicationDigestPreview = {
  from: string;
  to: string;
  /** The venue this digest was composed from, spelled as the records spell it. Absent = by date. */
  venue?: string;
  /** Every venue the records mention. Always returned, so one call fills the picker. */
  venues: PublicationDigestVenue[];
  publications: PublicationDigestEntry[];
  excluded: Array<{
    id: string;
    title: string;
    reason: "no_date" | "out_of_range" | "not_accepted";
    date?: PublicationDigestEntry["date"];
  }>;
  undated_count: number;
  /** Venue mode: papers naming the venue with no decision recorded. */
  pending_count: number;
  subject: string;
  body: string;
};

/**
 * What the digest for this range would contain. Read-only.
 *
 * The tab shows this before anything is sent, and the send recomputes it from the same function --
 * so the preview is the email rather than a rehearsal of it.
 */
export async function fetchPublicationDigest(
  params: { from: string; to: string; venue?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PublicationDigestPreview>> {
  const search = new URLSearchParams({ from: params.from, to: params.to });
  if (params.venue) {
    search.set("venue", params.venue);
  }
  const result = await authedJson(
    baseUrl,
    `/papers/mailing-list?${search.toString()}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body as PublicationDigestPreview };
}

/** Mails the digest for this range to one address. */
export async function sendPublicationDigest(
  params: { from: string; to: string; email: string; venue?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ sent: true; recipient: string; publications: number }>> {
  const result = await authedJson(
    baseUrl,
    "/papers/mailing-list/send",
    "POST",
    sessionToken,
    params,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as { sent: true; recipient: string; publications: number },
  };
}

// Creates or edits a paper over the member's own session (PUT /papers/:id). Papers are written on
// the member Bearer rather than the gateway tool path because the service decides there what a
// plain member may touch -- their own submissions, without the governance fields -- and because a
// member's paired device holds read-only gateway scopes, so `tools.invoke` is not open to them.
/**
 * Asks the service to place the import columns the local pass could not.
 *
 * Nothing is written by this call: what comes back is a suggested mapping the grid shows for
 * review. A failure is not an error the member needs to see -- the local pass has already produced
 * a usable mapping -- so the caller treats an empty answer and a dead tunnel the same way.
 */
export async function mapImportColumns(
  unmapped: Array<{ header: string; samples: string[] }>,
  available: string[],
  sessionToken: string,
  baseUrl: string,
): Promise<Record<string, string>> {
  const result = await authedJson(baseUrl, "/papers/import/columns", "POST", sessionToken, {
    unmapped,
    available,
  });
  if ("unreachable" in result || !result.response.ok) {
    return {};
  }
  const mapping = (result.body as { mapping?: Record<string, string> } | null)?.mapping;
  return mapping && typeof mapping === "object" ? mapping : {};
}

/** One paper waiting on the head professor's yes to post. */
export type PiReviewRow = {
  feedback?: PaperFeedback & { label: string; slot: string };
  paperId: string;
  title: string;
  authors: string[];
  venue?: string;
  /** When the package became ready, which is what the queue is ordered by. */
  waitingSince?: string;
  /** The lab's copy of the exact PDF that would go public. */
  drivePdfUrl?: string;
  /** Whether everything else the arXiv package needs is on file. */
  packageComplete: boolean;
};

/**
 * The papers at the PI gate (GET /papers/pi-review).
 *
 * A missing endpoint or invalid response leaves approval status unknown; only a successful
 * queue response can establish that nobody is waiting.
 */
export async function fetchPiReviewQueue(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PiReviewRow[]>> {
  const result = await authedJson(baseUrl, "/papers/pi-review", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (result.response.status === 404) {
    return {
      ok: false,
      kind: "not-found",
      message: "The backend does not support the PI review queue yet.",
    };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { papers?: Array<Record<string, unknown>> } | null;
  if (
    !body ||
    !Array.isArray(body.papers) ||
    body.papers.some(
      (row) =>
        !row ||
        typeof row.paper_id !== "string" ||
        !row.paper_id.trim() ||
        typeof row.title !== "string" ||
        !row.title.trim(),
    )
  ) {
    return {
      ok: false,
      kind: "invalid-response",
      message: "The backend returned an invalid PI review queue.",
    };
  }
  const rows = (body.papers ?? []).flatMap((row) => {
    const paperId = typeof row.paper_id === "string" ? row.paper_id : "";
    const title = typeof row.title === "string" ? row.title : "";
    if (!paperId || !title) {
      return [];
    }
    const authors = Array.isArray(row.authors)
      ? row.authors.filter((name): name is string => typeof name === "string")
      : [];
    return [
      {
        paperId,
        title,
        authors,
        ...(typeof row.venue === "string" ? { venue: row.venue } : {}),
        ...(typeof row.waiting_since === "string" ? { waitingSince: row.waiting_since } : {}),
        ...(typeof row.drive_pdf_url === "string" ? { drivePdfUrl: row.drive_pdf_url } : {}),
        ...(row.feedback &&
        typeof row.feedback === "object" &&
        parsePaperFeedback(JSON.stringify(row.feedback)) &&
        typeof (row.feedback as Record<string, unknown>).label === "string" &&
        typeof (row.feedback as Record<string, unknown>).slot === "string"
          ? { feedback: row.feedback as PiReviewRow["feedback"] }
          : {}),
        packageComplete: row.package_complete === true,
      },
    ];
  });
  return { ok: true, value: rows };
}

// --- Paper evidence slots ---
//
// The tall table behind My Projects & Papers: one row per artifact per paper. The registry that
// says what each slot is called and what shape it accepts is imported straight from the service's
// contracts module (see views/paper-slots.ts), so this file only moves records, never rules.

/**
 * Only the counts. Title, venue, deadline and step come from the paper record the page already
 * holds, so the service stopped repeating them on every row; an older service still sends them
 * and the extra keys are simply ignored.
 */
export type PaperSlotOverviewRow = {
  paper_id: string;
  provided_count: number;
  required_count: number;
  dormant: boolean;
  closed: boolean;
  missing_slots: string[];
  cycle_closed?: boolean;
  escalating: boolean;
};

/** Every paper's outstanding evidence, computed by the service on read. */
export async function fetchPaperSlotOverview(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSlotOverviewRow[]>> {
  const result = await authedJson(baseUrl, "/papers/slot-overview", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { papers?: PaperSlotOverviewRow[] } | null;
  return { ok: true, value: body?.papers ?? [] };
}

/** One person at one conference. Mirrors ConferenceAttendancePerson in the service. */
export type ConferenceRosterPerson = {
  avatar_url?: string;
  attendee_key: string;
  member_id?: string;
  name: string;
  attending: "yes" | "no" | "unknown";
  papers: Array<{ paper_id: string; title: string; attending: "yes" | "no" | "unknown" }>;
};

/** One conference the lab has an accepted paper at, and everyone on its roll-call. */
export type ConferenceRoster = {
  key: string;
  venue: string;
  year: number;
  label: string;
  paper_count: number;
  people: ConferenceRosterPerson[];
  going_count: number;
  unanswered_count: number;
  papers_awaiting: Array<{ paper_id: string; title: string; unanswered: number }>;
};

/** Privileged attendance read; an unavailable backend is not an empty roster. */
export async function fetchConferenceRosters(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ConferenceRoster[]>> {
  const result = await authedJson(baseUrl, "/papers/conference-rosters", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { conferences?: ConferenceRoster[] } | null;
  return { ok: true, value: body?.conferences ?? [] };
}

export type PaperNudgeBatch = {
  member_id: string;
  member_name: string;
  /** False when there is no Slack id on file. The preview says so before anything is sent. */
  deliverable: boolean;
  item_count: number;
  paper_titles: string[];
  /** The composed message, exactly as it would arrive. */
  message: string;
};

/**
 * What would go out if the button were pressed right now.
 *
 * The same computation the send runs, returned instead of delivered -- so the preview is the send,
 * looked at rather than performed.
 */
export async function fetchPaperNudgeBatches(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperNudgeBatch[]>> {
  const result = await authedJson(baseUrl, "/papers/nudge-batches", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { batches?: PaperNudgeBatch[] } | null;
  return { ok: true, value: body?.batches ?? [] };
}

/**
 * Sends the batches. Recipients and text are server-computed, never ours.
 *
 * `recipientIds` narrows the send to the people an admin ticked in the preview; the service still
 * recomputes the batches, so the list only ever subtracts.
 */
export async function runPaperSlotReminder(
  sessionToken: string,
  baseUrl: string,
  recipientIds?: string[],
): Promise<AuthResult<{ created: number; skipped: number }>> {
  const result = await authedJson(baseUrl, "/papers/slot-reminder/run", "POST", sessionToken, {
    ...(recipientIds?.length ? { recipient_member_ids: recipientIds } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as { created?: unknown[]; skipped?: unknown[] } | null;
  return {
    ok: true,
    value: { created: body?.created?.length ?? 0, skipped: body?.skipped?.length ?? 0 },
  };
}
