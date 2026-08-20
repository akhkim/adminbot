// The Logistics tab's side of the wire.
//
// Five calls: read the requests the caller is allowed to read, submit one, correct one nobody has
// picked up, withdraw one, and -- for an admin -- say what the lab has done about it.
//
// What a member is allowed to see is decided by the service, not here: the same GET returns one
// member's own requests and an admin's whole queue. This controller renders whatever came back,
// which is why a bug in this file cannot show anybody someone else's request.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import {
  fetchLogisticsRequest,
  fetchLogisticsRequests,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
  sendSignedLogisticsDocuments,
  setLogisticsRequestStatus,
  submitLogisticsRequest,
  updateLogisticsRequest,
  withdrawLogisticsRequest,
  type LogisticsAttachment,
  type LogisticsRequest,
  type LogisticsRequestInput,
  type LogisticsRequestStatus,
} from "../auth/session.ts";
import {
  clearLogisticsDraft,
  clearMeetingRequestDraft,
  clearRecommendationLettersDraft,
} from "../data/logistics-draft.ts";
import { saveAttachment } from "../data/logistics-requests.ts";

export type AdminBotLogisticsHost = {
  settings: UiSettings;
  memberId?: string | null;
  adminBotLogisticsRequests: LogisticsRequest[];
  adminBotLogisticsRequestsLoading: boolean;
  adminBotLogisticsRequestsError: string | null;
  /** The one request opened in full, bytes included. Null is the list. */
  adminBotLogisticsOpenRequest: LogisticsRequest | null;
  adminBotLogisticsOpenRequestId: string | null;
  adminBotLogisticsOpenLoading: boolean;
  adminBotLogisticsSubmitting: boolean;
  adminBotLogisticsSubmitError: string | null;
  /** Set on a submit that landed, so the form can say so and stop showing the draft as pending. */
  adminBotLogisticsSubmittedId: string | null;
  /** The request whose signed document is being uploaded, so its row can say so. */
  adminBotLogisticsSigningId: string | null;
  /** "<requestId>:<fileName>" while that one file is being fetched for download. */
  adminBotLogisticsDownloadingId: string | null;
};

function failureText(result: { kind: string; message?: string }, baseUrl: string): string {
  if (result.kind === "unreachable") {
    return t("logistics.requests.error.unreachable", { url: baseUrl });
  }
  if (result.kind === "forbidden") {
    return t("logistics.requests.error.forbidden");
  }
  // A 400 carries the service's own explanation, which names the field it refused. Nothing else
  // does, so everything else falls back to fixed copy.
  return result.message ?? t("logistics.requests.error.failed");
}

function session(host: AdminBotLogisticsHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return null;
  }
  return {
    token: stored.sessionToken,
    baseUrl: resolveAdminBotBaseUrl(host.settings),
  };
}

export async function loadAdminBotLogisticsRequests(host: AdminBotLogisticsHost): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequests = [];
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return;
  }
  host.adminBotLogisticsRequestsLoading = true;
  host.adminBotLogisticsRequestsError = null;
  try {
    const result = await fetchLogisticsRequests(wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsRequests = [];
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      return;
    }
    host.adminBotLogisticsRequests = result.value;
  } finally {
    host.adminBotLogisticsRequestsLoading = false;
  }
}

/**
 * Opens one request in full.
 *
 * A second read rather than reusing the row from the list: the list deliberately carries no file
 * bytes, so the documents an admin came to read are only ever one request away, never twenty.
 */
export async function openAdminBotLogisticsRequest(
  host: AdminBotLogisticsHost,
  requestId: string | null,
): Promise<void> {
  host.adminBotLogisticsOpenRequestId = requestId;
  host.adminBotLogisticsOpenRequest = null;
  if (!requestId) {
    return;
  }
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return;
  }
  host.adminBotLogisticsOpenLoading = true;
  try {
    const result = await fetchLogisticsRequest(requestId, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      // Back to the list rather than an empty card: whatever went wrong, there is nothing to show.
      host.adminBotLogisticsOpenRequestId = null;
      return;
    }
    host.adminBotLogisticsOpenRequest = result.value;
  } finally {
    host.adminBotLogisticsOpenLoading = false;
  }
}

/**
 * Sends a request, and clears the draft it was built from.
 *
 * The draft is cleared only once the service has the request: a submit that failed has to leave the
 * member exactly where they were, with everything they typed still on screen. `scope` names whose
 * drafts to clear -- see logisticsDraftScope.
 */
export async function submitAdminBotLogisticsRequest(
  host: AdminBotLogisticsHost,
  input: LogisticsRequestInput,
  scope: string,
): Promise<LogisticsRequest | null> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsSubmitError = t("logistics.requests.error.signIn");
    return null;
  }
  host.adminBotLogisticsSubmitting = true;
  host.adminBotLogisticsSubmitError = null;
  host.adminBotLogisticsSubmittedId = null;
  try {
    const result = await submitLogisticsRequest(input, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsSubmitError = failureText(result, wire.baseUrl);
      return null;
    }
    host.adminBotLogisticsSubmittedId = result.value.id;
    host.adminBotLogisticsRequests = [result.value, ...host.adminBotLogisticsRequests];
    await clearDraftFor(input.kind, scope);
    return result.value;
  } finally {
    host.adminBotLogisticsSubmitting = false;
  }
}

async function clearDraftFor(kind: LogisticsRequestInput["kind"], scope: string): Promise<void> {
  // Failing to clear is not worth reporting: the request is already filed, and a leftover draft is
  // a stale form, not lost work.
  try {
    if (kind === "document_signature") {
      await clearLogisticsDraft(scope);
    } else if (kind === "recommendation_letters") {
      await clearRecommendationLettersDraft(scope);
    } else {
      await clearMeetingRequestDraft(scope);
    }
  } catch {
    // best-effort
  }
}

export async function updateAdminBotLogisticsRequest(
  host: AdminBotLogisticsHost,
  requestId: string,
  input: LogisticsRequestInput,
): Promise<boolean> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsSubmitError = t("logistics.requests.error.signIn");
    return false;
  }
  host.adminBotLogisticsSubmitting = true;
  host.adminBotLogisticsSubmitError = null;
  try {
    const result = await updateLogisticsRequest(requestId, input, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsSubmitError = failureText(result, wire.baseUrl);
      return false;
    }
    replaceRequest(host, result.value);
    return true;
  } finally {
    host.adminBotLogisticsSubmitting = false;
  }
}

export async function withdrawAdminBotLogisticsRequest(
  host: AdminBotLogisticsHost,
  requestId: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return;
  }
  host.adminBotLogisticsOpenLoading = true;
  host.adminBotLogisticsRequestsError = null;
  try {
    const result = await withdrawLogisticsRequest(requestId, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      return;
    }
    replaceRequest(host, result.value);
  } finally {
    host.adminBotLogisticsOpenLoading = false;
  }
}

/**
 * Fetches one document and hands it to the browser.
 *
 * The queue's rows carry no bytes -- the list read strips them, which is what keeps a queue of
 * twenty requests from being twenty PDFs down the wire to draw a table. So a download is a read of
 * that one request, and the file is picked out of it by name.
 */
export async function downloadAdminBotLogisticsDocument(
  host: AdminBotLogisticsHost,
  requestId: string,
  fileName: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return;
  }
  host.adminBotLogisticsDownloadingId = `${requestId}:${fileName}`;
  host.adminBotLogisticsRequestsError = null;
  try {
    const result = await fetchLogisticsRequest(requestId, wire.token, wire.baseUrl);
    if (!result.ok) {
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      return;
    }
    const file = [...(result.value.documents ?? []), ...(result.value.attachments ?? [])].find(
      (candidate) => candidate.name === fileName && candidate.data_base64,
    );
    if (!file) {
      // The only way here is a request settled between the queue being drawn and the click: its
      // files are gone, and saying so beats a download of nothing.
      host.adminBotLogisticsRequestsError = t("logistics.queue.fileGone", { name: fileName });
      return;
    }
    saveAttachment(file);
  } finally {
    host.adminBotLogisticsDownloadingId = null;
  }
}

/**
 * Returns the signed document to the member who asked for it.
 *
 * The one call that finishes a signature request: the service mails it, marks the request done and
 * drops the stored files. The reply replaces the row, so the queue shows the outcome without a
 * re-read -- and the row it replaces is the last one that had anything downloadable on it.
 */
export async function sendAdminBotSignedDocuments(
  host: AdminBotLogisticsHost,
  requestId: string,
  documents: LogisticsAttachment[],
  note: string,
): Promise<boolean> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return false;
  }
  host.adminBotLogisticsSigningId = requestId;
  host.adminBotLogisticsRequestsError = null;
  try {
    const result = await sendSignedLogisticsDocuments(
      requestId,
      documents,
      note,
      wire.token,
      wire.baseUrl,
    );
    if (!result.ok) {
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      return false;
    }
    replaceRequest(host, result.value);
    return true;
  } finally {
    host.adminBotLogisticsSigningId = null;
  }
}

/** The lab answering a request. Admin-only; the service is what enforces that. */
export async function setAdminBotLogisticsRequestStatus(
  host: AdminBotLogisticsHost,
  requestId: string,
  status: LogisticsRequestStatus,
  note: string,
): Promise<void> {
  const wire = session(host);
  if (!wire) {
    host.adminBotLogisticsRequestsError = t("logistics.requests.error.signIn");
    return;
  }
  host.adminBotLogisticsOpenLoading = true;
  host.adminBotLogisticsRequestsError = null;
  try {
    const result = await setLogisticsRequestStatus(
      requestId,
      status,
      note,
      wire.token,
      wire.baseUrl,
    );
    if (!result.ok) {
      host.adminBotLogisticsRequestsError = failureText(result, wire.baseUrl);
      return;
    }
    replaceRequest(host, result.value);
  } finally {
    host.adminBotLogisticsOpenLoading = false;
  }
}

/**
 * Puts an updated request back into both places it is held.
 *
 * A new array, not a mutated one: lit only re-renders a @state() array when the reference changes.
 * The open request keeps whatever file bytes it was opened with -- the writes reply without them,
 * and dropping them here would blank the documents an admin is looking at.
 */
function replaceRequest(host: AdminBotLogisticsHost, updated: LogisticsRequest): void {
  host.adminBotLogisticsRequests = host.adminBotLogisticsRequests.map((request) =>
    request.id === updated.id ? { ...request, ...updated } : request,
  );
  const open = host.adminBotLogisticsOpenRequest;
  if (open?.id === updated.id) {
    host.adminBotLogisticsOpenRequest = {
      ...open,
      ...updated,
      ...keptBytes(open, updated),
    };
  }
}

/**
 * The file bytes the open request already has, when the reply came back without them.
 *
 * Every write answers with the list-shaped record -- no bytes, by design -- so a plain merge would
 * blank the document an admin is reading the moment they mark the request done. A withdrawal is the
 * exception and must be allowed through: it drops the bytes on purpose, on the service side, and
 * putting them back here would keep somebody's documents on screen after they asked for them to go.
 */
function keptBytes(
  open: LogisticsRequest,
  updated: LogisticsRequest,
): Pick<LogisticsRequest, "documents" | "attachments"> | undefined {
  if (updated.status === "withdrawn") {
    return undefined;
  }
  const keep = (
    before: LogisticsRequest["documents"],
    after: LogisticsRequest["documents"],
  ): LogisticsRequest["documents"] =>
    after?.map((file, index) =>
      file.data_base64 ? file : { ...file, ...(before?.[index]?.data_base64 ? before[index] : {}) },
    );
  return {
    ...(updated.documents ? { documents: keep(open.documents, updated.documents) } : {}),
    ...(updated.attachments ? { attachments: keep(open.attachments, updated.attachments) } : {}),
  };
}
