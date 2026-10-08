// AdminBot client: Requests to the PI: signatures, rec letters, and meeting requests.
//
// Mirrors the service's api/routes/logistics.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, calendarFailure } from "../auth/session.ts";

// ---------------------------------------------------------------------------
// Logistics requests
//
// The wire for the request templates: submit one, read the ones you are allowed to read, open a
// single one in full, and -- for an admin -- say what the lab has done about it.
//
// Who may read what is the service's decision, not this file's. The same GET returns one member's
// own requests and an admin's whole queue, so there is nothing to filter here and no bug in this
// module can show a member somebody else's letter deadlines.
// ---------------------------------------------------------------------------

export type LogisticsRequestKind = "document_signature" | "recommendation_letters" | "book_meeting";

export type LogisticsRequestStatus =
  | "submitted"
  | "in_progress"
  | "completed"
  | "declined"
  | "withdrawn";

/**
 * A file on a request.
 *
 * `data_base64` is present only on the read that opens one request -- the list carries names and
 * sizes -- and is gone for good once the request is settled and the service drops its files.
 */
export type LogisticsAttachment = {
  name: string;
  size: number;
  content_type?: string;
  data_base64?: string;
};

export type LogisticsSchool = {
  school: string;
  application_deadline?: string;
  application_deadline_time?: string;
  letter_deadline?: string;
  letter_deadline_time?: string;
  deadline_timezone?: string;
  application_status?: string;
  letter_status?: string;
  program?: string;
  program_link?: string;
  notes?: string;
};

export type LogisticsFact = { project: string; contribution: string };

export type LogisticsMeeting = {
  purpose: string;
  preferred_time?: string;
  timezone?: string;
  length_minutes?: number;
  submitted_at?: string;
  /** Free-text location, which is what the call sheet's city column actually holds. */
  city?: string;
  doc_prep_url?: string;
  /** Tri-state: absent is "not answered", which is not the same as "no". */
  whatsapp_hello?: boolean;
  /** yyyy-mm-dd after which the call stops being worth placing. */
  latest_ok_date?: string;
};

export type LogisticsRequestInput = {
  kind: LogisticsRequestKind;
  documents?: LogisticsAttachment[];
  description?: string;
  attachments?: LogisticsAttachment[];
  schools?: LogisticsSchool[];
  facts?: LogisticsFact[];
  cv_overleaf_url?: string;
  drive_folder_url?: string;
  meetings?: LogisticsMeeting[];
};

/**
 * A request as the service sends it.
 *
 * The list read (`fetchLogisticsRequests`) fills in only the queue's columns: who, kind, status,
 * the stamps, the signed-and-sent line, and on each school or meeting just the fields its deadline
 * is read from. Everything else -- files, description, facts, links, the lab's answer -- arrives
 * with `fetchLogisticsRequest`, which is what opening a request already calls.
 */
export type LogisticsRequest = LogisticsRequestInput & {
  id: string;
  member_id: string;
  member_name: string;
  status: LogisticsRequestStatus;
  submitted_at: string;
  updated_at: string;
  /** RFC3339 instant of the soonest thing the request is working towards. Derived by the service. */
  deadline_at?: string;
  /** The signed copy the lab sent back, and where it went. Bytes are dropped with the rest. */
  signed_documents?: LogisticsAttachment[];
  signed_sent_at?: string;
  signed_sent_to?: string;
  /** When the stored file bytes were dropped, so "never had one" reads differently from "gone". */
  files_cleared_at?: string;
  resolution_note?: string;
  decided_by?: string;
  decided_at?: string;
};

/** One page of the list read: the rows, how many the whole filtered list holds, and where it goes on. */
export type LogisticsRequestsPage = {
  requests: LogisticsRequest[];
  /** The filtered list's size, not the page's. Absent from a service that predates paging. */
  total: number;
  nextCursor: string | null;
};

/**
 * One page of the requests the caller may read.
 *
 * `query` carries the page (`limit`, `cursor`) and the queue's filter and sort; the service applies
 * them before cutting the page, so a search reaches requests that are not on screen yet.
 */
export async function fetchLogisticsRequests(
  sessionToken: string,
  baseUrl: string,
  query?: URLSearchParams,
): Promise<AuthResult<LogisticsRequestsPage>> {
  const search = query?.toString();
  const result = await authedJson(
    baseUrl,
    search ? `/logistics/requests?${search}` : "/logistics/requests",
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
    requests?: LogisticsRequest[];
    total?: number;
    next_cursor?: string;
  } | null;
  const requests = body?.requests ?? [];
  return {
    ok: true,
    value: {
      requests,
      total: body?.total ?? requests.length,
      nextCursor: body?.next_cursor ?? null,
    },
  };
}

/** One request with its file bytes -- the only read that carries them. */
export async function fetchLogisticsRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/**
 * A submitted request, plus what the automatic call-sheet push made of it.
 *
 * Only a `book_meeting` carries `call_sheet`, and only where the deployment has the queue wired
 * up -- so it is optional, and its absence means "no call sheet was involved", never "it failed".
 */
export type SubmittedLogisticsRequest = LogisticsRequest & {
  call_sheet?: { queued: boolean; message: string };
};

export async function submitLogisticsRequest(
  input: LogisticsRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<SubmittedLogisticsRequest>> {
  const result = await authedJson(baseUrl, "/logistics/requests", "POST", sessionToken, input);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as SubmittedLogisticsRequest };
}

/**
 * Files the signature request on the lab's Google Form.
 *
 * Posted through AdminBot rather than from the browser: the form's first column is who is asking,
 * and the service answers it from the roster instead of trusting whatever the page sends.
 */
export async function submitSignatureFormRequest(
  input: { drive_url: string; deadline: string; context?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ submitted: boolean }>> {
  const result = await authedJson(
    baseUrl,
    "/logistics/signature-form",
    "POST",
    sessionToken,
    input,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { submitted: boolean } };
}

/** Replaces the content of a request nobody has picked up yet. The service refuses the rest. */
export async function updateLogisticsRequest(
  requestId: string,
  input: LogisticsRequestInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}`,
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
  return { ok: true, value: result.body as LogisticsRequest };
}

export async function withdrawLogisticsRequest(
  requestId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/withdraw`,
    "POST",
    sessionToken,
    {},
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/** Admin-only; the service enforces it and refuses "withdrawn" here whoever asks. */
export async function setLogisticsRequestStatus(
  requestId: string,
  status: LogisticsRequestStatus,
  note: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/status`,
    "PUT",
    sessionToken,
    { status, ...(note.trim() ? { resolution_note: note.trim() } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}

/**
 * Returns the signed document to the member who asked for it.
 *
 * One call closes the request out: the service mails the file, marks the request completed and
 * drops every stored copy. Admin-only, and the recipient is not ours to choose -- the service reads
 * it off the roster.
 */
export async function sendSignedLogisticsDocuments(
  requestId: string,
  documents: LogisticsAttachment[],
  note: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<LogisticsRequest>> {
  const result = await authedJson(
    baseUrl,
    `/logistics/requests/${encodeURIComponent(requestId)}/signed`,
    "POST",
    sessionToken,
    { documents, ...(note.trim() ? { resolution_note: note.trim() } : {}) },
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as LogisticsRequest };
}
