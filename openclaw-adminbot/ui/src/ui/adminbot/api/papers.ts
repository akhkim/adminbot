// AdminBot client: Paper records, evidence slots, the per-paper cycle, and conference trips.
//
// Mirrors the service's api/routes/papers.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  authedJson,
  type AuthResult,
  calendarFailure,
  mapErrorResponse,
  readRecentUpdates,
  type RecentUpdateRow,
} from "../auth/session.ts";

/**
 * Write this member's own line about their week on one paper.
 *
 * The member id is never sent: the service takes it from the session, because the log is only
 * worth reading if every line is first-hand. `weekStart` is omitted in the ordinary case -- the
 * service files it under the week containing now -- and passed only to correct an earlier week.
 */
export async function savePaperWeeklyUpdate(
  paperId: string,
  body: string,
  sessionToken: string,
  baseUrl: string,
  weekStart?: string,
): Promise<AuthResult<{ update: PaperWeeklyUpdate }>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/weekly-updates`,
    "POST",
    sessionToken,
    { body, ...(weekStart ? { week_start: weekStart } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { update: PaperWeeklyUpdate } };
}

/**
 * One LinkedIn announcement draft, generated from a paper PDF.
 *
 * Nothing about this round trip is stored -- not on the server, not here. The draft exists in
 * the dialog until the author copies it, which is the whole point: the authoritative version is
 * the one they post, and a saved copy would only ever be the stale one.
 */
export type LinkedInDraftAuthor = {
  paperName: string;
  displayName: string;
  matched: boolean;
  match: "none" | "exact" | "initial";
  member_id?: string;
  linkedin_url?: string;
  linkedin_urn?: string;
};

export type LinkedInDraft = {
  paper: { title: string; authors: string[]; abstract: string; url?: string };
  text: string;
  model: string;
  issues: string[];
  authors: LinkedInDraftAuthor[];
};

export async function draftLinkedInPost(
  request: { pdfBase64?: string; paperId?: string; url?: string; venue?: string; note?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LinkedInDraft>> {
  const result = await authedJson(baseUrl, "/papers/linkedin-draft", "POST", sessionToken, {
    // Either is enough. An attached file wins; otherwise the service reads the Drive copy the
    // paper already names, which the card has been chasing the author for anyway.
    ...(request.pdfBase64 ? { pdf_base64: request.pdfBase64 } : {}),
    ...(request.paperId ? { paper_id: request.paperId } : {}),
    ...(request.url ? { url: request.url } : {}),
    ...(request.venue ? { venue: request.venue } : {}),
    ...(request.note ? { note: request.note } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    // A 502 here carries the connector's own message -- a missing OPENROUTER_API_KEY, or a PDF
    // with no extractable abstract. Both are things the person clicking can act on.
    const body = result.body as { error?: { message?: string } } | null;
    return { ok: false, kind: "draft-failed", message: body?.error?.message ?? "draft failed" };
  }
  return { ok: true, value: result.body as LinkedInDraft };
}

export async function saveOwnPaper(
  paperId: string,
  body: Record<string, unknown>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}`,
    "PUT",
    sessionToken,
    body,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

// Removes a paper over the member's own session (DELETE /papers/:id). Same reasoning as
// saveOwnPaper: the service decides there what this member may remove -- any paper for an admin,
// one they authored for a plain member -- so the affordance never has to guess.
export async function deleteOwnPaper(
  paperId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}`,
    "DELETE",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/** Not going is the absence of a row, never a value. Withdrawing deletes; see deleteConferenceTrip. */
export type ConferenceTripIntent = "going" | "undecided";

export type ConferenceFundingNeed = "none" | "fee_only" | "flight_only" | "full_travel";

/** One member's own plan for one conference. Mirrors AdminBotConferenceTripRecord. */
export type ConferenceTrip = {
  conference_key: string;
  member_id: string;
  intent: ConferenceTripIntent;
  funding: ConferenceFundingNeed;
  needs_lodging: boolean;
  arrival_on?: string;
  departure_on?: string;
  needs_visa_letter: boolean;
  paper_id?: string;
  notes?: string;
  updated_at: string;
};

/** One conference card. `roster` arrives only for an admin; see listConferenceOverview. */
export type ConferenceSummary = {
  key: string;
  label: string;
  family: string;
  year?: number;
  location?: string;
  description: string;
  homepage_url?: string;
  next_deadline_aoe?: string;
  next_deadline_label?: string;
  workshop_count: number;
  roster?: {
    going: number;
    undecided: number;
    funding: Record<ConferenceFundingNeed, number>;
    visa_letters: number;
    lodging: {
      guests: number;
      first_night?: string;
      last_night?: string;
      members: Array<{
        member_id: string;
        name: string;
        arrival_on?: string;
        departure_on?: string;
      }>;
    };
    trips: Array<ConferenceTrip & { member_name: string; paper_title?: string }>;
  };
};

export type ConferenceOverview = {
  conferences: ConferenceSummary[];
  /** The viewer's own trips. Empty when signed out. */
  mine: ConferenceTrip[];
};

/**
 * The conference overview.
 *
 * Readable signed out, like the deadline board it is derived from -- so this takes an optional
 * token rather than requiring one, and the service narrows the payload to whoever is asking.
 */
export async function fetchConferenceOverview(
  sessionToken: string | null,
  baseUrl: string,
): Promise<AuthResult<ConferenceOverview>> {
  // `authedJson` takes a null token, which is how the Opportunities board reads publicly too.
  const result = await authedJson(baseUrl, "/conferences", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (result.response.status === 404) {
    // The service predates this route: the Control UI ships on merge and the service is deployed
    // separately, so a new tab can reach a host that has never heard of it.
    return { ok: true, value: { conferences: [], mine: [] } };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as Partial<ConferenceOverview> | null;
  return { ok: true, value: { conferences: body?.conferences ?? [], mine: body?.mine ?? [] } };
}

/** Sign the signed-in member up, or change what they said. Always their own row. */
export async function saveConferenceTrip(
  conferenceKey: string,
  input: {
    intent: ConferenceTripIntent;
    funding: ConferenceFundingNeed;
    needs_lodging: boolean;
    needs_visa_letter: boolean;
    arrival_on?: string;
    departure_on?: string;
    paper_id?: string;
    notes?: string;
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<ConferenceTrip>> {
  const result = await authedJson(
    baseUrl,
    `/conferences/${encodeURIComponent(conferenceKey)}/trip`,
    "PUT",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: (result.body as { trip: ConferenceTrip }).trip };
}

/**
 * Withdraw from a conference: the member's row is removed and they are simply not going.
 *
 * Idempotent on the service side, so a double press is not an error.
 */
export async function deleteConferenceTrip(
  conferenceKey: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ withdrawn: boolean }>> {
  const result = await authedJson(
    baseUrl,
    `/conferences/${encodeURIComponent(conferenceKey)}/trip`,
    "DELETE",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { withdrawn: boolean } };
}

/** The same, for one paper: its record and every evidence slot on it. */
export async function fetchPaperRecentEdits(
  paperId: string,
  sessionToken: string,
  baseUrl: string,
  limit = 20,
): Promise<AuthResult<RecentUpdateRow[]>> {
  return readRecentUpdates(
    await authedJson(
      baseUrl,
      `/papers/${encodeURIComponent(paperId)}/recent-edits?limit=${encodeURIComponent(String(limit))}`,
      "GET",
      sessionToken,
    ),
  );
}

export type PaperSlotRow = {
  paper_id: string;
  slot: string;
  status: "missing" | "provided" | "invalid" | "waived";
  url?: string;
  /** Absent, not blank, when the reader is not entitled to a credential slot. */
  value_text?: string;
  /** The free-text half of an enum slot. */
  value_note?: string;
  provided_at?: string;
  verified_by?: string;
  verified_at?: string;
  verified_title?: string;
  previous_submission_id?: string;
  identity_review?: import("../../../../../extensions/adminbot/src/contracts/paper-artifact-links.js").OpenReviewIdentityReview;
  invalid_reason?: string;
  waived_reason?: string;
};

/**
 * One rung of the venue ladder, as the card draws it.
 *
 * There is no save path for these on purpose: the only thing that closes a rung is the mail
 * arriving in the bot mailbox. Mirrors AdminBotPaperflowStageView in the service.
 */
export type PaperflowStageRow = {
  stage: string;
  label: string;
  node: string;
  state: "closed" | "waiting" | "upcoming";
  closed_at?: string;
  closed_by_subject?: string;
  closed_by?: "email_bcc" | "admin";
};

export type PaperSocialDraft = {
  id: string;
  paper_id: string;
  platform: "x" | "linkedin";
  body: string;
  model?: string;
  generated_at: string;
  status: "draft" | "circulated" | "approved" | "superseded";
};

export type PaperSocialConsent = {
  draft_id: string;
  member_id: string;
  decision: "pending" | "ok" | "changes_requested";
  comment?: string;
  asked_at: string;
  decided_at?: string;
};

export type PaperAttendee = {
  paper_id: string;
  attendee_key: string;
  member_id?: string;
  name: string;
  attending: "yes" | "no" | "unknown";
  confirmed_at?: string;
};

export type PaperReimbursement = {
  paper_id: string;
  member_id: string;
  status: "not_applicable" | "pending" | "submitted" | "reimbursed";
  submitted_at?: string;
  completed_at?: string;
};

/** Everything one card needs: the checklist plus the lists that hang off the paper. */
/** One author's account of their own week on one paper. */
export type PaperWeeklyUpdate = {
  paper_id: string;
  member_id: string;
  week_start: string;
  body: string;
  created_at: string;
  updated_at: string;
};

export type PaperCycle = {
  slots: PaperSlotRow[];
  drafts: PaperSocialDraft[];
  consents: PaperSocialConsent[];
  attendees: PaperAttendee[];
  reimbursements: PaperReimbursement[];
  /** The venue ladder. Read-only: closed by a bcc, never by a control on this card. */
  stages: PaperflowStageRow[];
  /** The weekly log, newest week first. Written by each author about themselves. */
  weeklyUpdates: PaperWeeklyUpdate[];
  cycleClosed: boolean;
  missingAcceptanceDetails: string[];
  /** The conference this paper goes to. Absent until the acceptance details are in. */
  conferenceKey?: string;
  /** The reader's own trip to that conference, when they have recorded one. */
  myTrip?: ConferenceTrip;
};

/** One paper's slots and venue ladder, blanks included -- the card renders the whole cycle. */
export async function fetchPaperSlots(
  paperId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperCycle>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/slots`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  const body = result.body as {
    slots?: PaperSlotRow[];
    drafts?: PaperSocialDraft[];
    consents?: PaperSocialConsent[];
    attendees?: PaperAttendee[];
    reimbursements?: PaperReimbursement[];
    paperflow_stages?: PaperflowStageRow[];
    weekly_updates?: PaperWeeklyUpdate[];
    cycle_closed?: boolean;
    missing_acceptance_details?: string[];
    conference_key?: string;
    my_trip?: ConferenceTrip;
  } | null;
  return {
    ok: true,
    value: {
      slots: body?.slots ?? [],
      drafts: body?.drafts ?? [],
      consents: body?.consents ?? [],
      attendees: body?.attendees ?? [],
      reimbursements: body?.reimbursements ?? [],
      stages: body?.paperflow_stages ?? [],
      weeklyUpdates: body?.weekly_updates ?? [],
      cycleClosed: Boolean(body?.cycle_closed),
      missingAcceptanceDetails: body?.missing_acceptance_details ?? [],
      ...(body?.conference_key ? { conferenceKey: body.conference_key } : {}),
      ...(body?.my_trip ? { myTrip: body.my_trip } : {}),
    },
  };
}

/** Save a social draft. Supersedes whatever it replaces, server-side. */
export async function savePaperSocialDraft(
  paperId: string,
  input: { platform: string; body: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSocialDraft>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/social-drafts`,
    "POST",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { draft?: PaperSocialDraft } | null;
  return body?.draft
    ? { ok: true, value: body.draft }
    : { ok: false, kind: "auth-failed", message: "the service returned no draft" };
}

/** Ask the paper's lab-member authors to sign off on a draft. */
export async function circulatePaperSocialDraft(
  draftId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/social-drafts/${encodeURIComponent(draftId)}/circulate`,
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/** The signed-in member's own answer on a draft. The service takes the id from the session. */
export async function recordPaperSocialConsent(
  draftId: string,
  input: { decision: string; comment?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/social-drafts/${encodeURIComponent(draftId)}/consent`,
    "POST",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export async function savePaperAttendee(
  paperId: string,
  input: { name: string; member_id?: string; attending: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/attendees`,
    "PUT",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export async function savePaperReimbursementStatus(
  paperId: string,
  memberId: string,
  status: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/reimbursements/${encodeURIComponent(memberId)}`,
    "PUT",
    sessionToken,
    { status },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Write one slot.
 *
 * The service derives `status` from the value, so this sends the value and nothing else -- there
 * is deliberately no way for the browser to declare an artifact provided.
 */
export async function savePaperSlot(
  paperId: string,
  slot: string,
  input: { url?: string; value_text?: string; value_note?: string; done?: boolean },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<PaperSlotRow>> {
  const result = await authedJson(
    baseUrl,
    `/papers/${encodeURIComponent(paperId)}/slots/${encodeURIComponent(slot)}`,
    "PUT",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { slot?: PaperSlotRow } | null;
  return body?.slot
    ? { ok: true, value: body.slot }
    : { ok: false, kind: "auth-failed", message: "the service returned no slot" };
}
