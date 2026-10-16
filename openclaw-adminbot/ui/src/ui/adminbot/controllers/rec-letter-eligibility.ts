// Recommendation-letter eligibility on the Requests tabs: who reads what, and when.
//
// Everything lives on one state object so the app host carries one field rather than a dozen, and
// a sign-out can drop it in one assignment. The reads are effects of the render pass, the same
// shape as logistics-paging.ts: each one has a sentinel, so a render that changes nothing asks
// nothing. All of it is advisory -- a failed read leaves the request forms exactly as they were.
import { t } from "../../../i18n/index.ts";
import type { UiSettings } from "../../storage.ts";
import type { LogisticsRequest } from "../api/logistics.ts";
import {
  createRecLetterFreezeIncident,
  deleteRecLetterFreezeIncident,
  fetchOwnRecLetterEligibility,
  fetchRecLetterEligibility,
  fetchRecLetterEligibilitySummaries,
  fetchRecLetterFreezeIncidents,
  type RecLetterAdminEligibility,
  type RecLetterEligibility,
  type RecLetterEligibilitySummary,
  type RecLetterFreezeIncident,
} from "../api/rec-letter-eligibility.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";

// Matches adminBotRecLetterSummaryLimit on the service, which refuses a longer batch.
const SUMMARY_BATCH = 100;

export type RecLetterFreezeForm = {
  memberId: string;
  occurredOn: string;
  paperId: string;
  note: string;
};

export type RecLetterEligibilityState = {
  own: {
    value: RecLetterEligibility | null;
    loading: boolean;
    error: string | null;
    loadedAt: number | null;
  };
  /** Queue badges by member id. A member asked about once is not asked again until a change. */
  summaries: Record<string, RecLetterEligibilitySummary>;
  summariesAsked: Record<string, true>;
  summariesLoading: boolean;
  detail: {
    requestId: string | null;
    value: RecLetterAdminEligibility | null;
    loading: boolean;
    error: string | null;
  };
  incidents: {
    list: RecLetterFreezeIncident[];
    loading: boolean;
    error: string | null;
    loadedAt: number | null;
    saving: boolean;
    deletingId: string | null;
    form: RecLetterFreezeForm;
  };
};

export const EMPTY_FREEZE_FORM: RecLetterFreezeForm = {
  memberId: "",
  occurredOn: "",
  paperId: "",
  note: "",
};

export function createRecLetterEligibilityState(): RecLetterEligibilityState {
  return {
    own: { value: null, loading: false, error: null, loadedAt: null },
    summaries: {},
    summariesAsked: {},
    summariesLoading: false,
    detail: { requestId: null, value: null, loading: false, error: null },
    incidents: {
      list: [],
      loading: false,
      error: null,
      loadedAt: null,
      saving: false,
      deletingId: null,
      form: EMPTY_FREEZE_FORM,
    },
  };
}

export type RecLetterEligibilityHost = {
  settings: UiSettings;
  adminBotRecLetter: RecLetterEligibilityState;
};

function wire(host: RecLetterEligibilityHost): { token: string; baseUrl: string } | null {
  const stored = loadStoredMemberSession();
  return stored
    ? { token: stored.sessionToken, baseUrl: resolveAdminBotBaseUrl(host.settings) }
    : null;
}

function stillSignedInAs(token: string): boolean {
  return loadStoredMemberSession()?.sessionToken === token;
}

function failureText(result: { kind: string; message?: string }): string {
  if (result.kind === "forbidden") {
    return t("logistics.eligibility.error.forbidden");
  }
  return result.message ?? t("logistics.eligibility.error.failed");
}

/**
 * The error a read leaves behind, if any.
 *
 * An unreachable service (offline, or down) and a body that is not a whole result are not errors
 * the reader can act on: both leave the value empty and no error, and the views draw a neutral
 * "unavailable" in place of the result rather than a red alert.
 */
function readError(result: { ok: true } | { ok: false; kind: string; message?: string }) {
  return result.ok || result.kind === "unreachable" ? null : failureText(result);
}

// Each writer replaces the sub-object rather than mutating it: Lit compares by reference, and a
// panel handed the same object would not redraw.
function patch<K extends keyof RecLetterEligibilityState>(
  host: RecLetterEligibilityHost,
  key: K,
  value: Partial<RecLetterEligibilityState[K]>,
): void {
  const current = host.adminBotRecLetter[key];
  host.adminBotRecLetter = {
    ...host.adminBotRecLetter,
    [key]:
      typeof current === "object" && current !== null && !Array.isArray(current)
        ? { ...current, ...value }
        : value,
  };
}

export async function loadOwnRecLetterEligibility(host: RecLetterEligibilityHost): Promise<void> {
  const session = wire(host);
  if (!session) {
    return;
  }
  patch(host, "own", { loading: true, error: null, loadedAt: Date.now() });
  const result = await fetchOwnRecLetterEligibility(session.token, session.baseUrl);
  if (!stillSignedInAs(session.token)) {
    return;
  }
  patch(host, "own", {
    value: result.ok ? result.value : null,
    loading: false,
    error: readError(result),
  });
}

/** Badges for the letter requests on screen, asking only about members not asked about yet. */
export async function loadRecLetterSummaries(
  host: RecLetterEligibilityHost,
  memberIds: readonly string[],
): Promise<void> {
  const session = wire(host);
  const state = host.adminBotRecLetter;
  const fresh = [...new Set(memberIds)].filter((id) => !state.summariesAsked[id]);
  if (!session || fresh.length === 0 || state.summariesLoading) {
    return;
  }
  const batch = fresh.slice(0, SUMMARY_BATCH);
  // Marked before the read, and kept on failure: a badge is a hint, and a service that refuses
  // it should not be asked again on every render.
  host.adminBotRecLetter = {
    ...state,
    summariesLoading: true,
    summariesAsked: {
      ...state.summariesAsked,
      ...Object.fromEntries(batch.map((id) => [id, true as const])),
    },
  };
  const result = await fetchRecLetterEligibilitySummaries(batch, session.token, session.baseUrl);
  if (!stillSignedInAs(session.token)) {
    return;
  }
  host.adminBotRecLetter = {
    ...host.adminBotRecLetter,
    summariesLoading: false,
    summaries: result.ok
      ? {
          ...host.adminBotRecLetter.summaries,
          ...Object.fromEntries(result.value.map((entry) => [entry.member_id, entry])),
        }
      : host.adminBotRecLetter.summaries,
  };
}

/** The full result behind the request an admin has open. */
export async function loadRecLetterDetail(
  host: RecLetterEligibilityHost,
  requestId: string,
): Promise<void> {
  const session = wire(host);
  if (!session) {
    return;
  }
  patch(host, "detail", { requestId, value: null, loading: true, error: null });
  const result = await fetchRecLetterEligibility({ requestId }, session.token, session.baseUrl);
  // Another request may have been opened while this one was read; its answer is not this one.
  if (!stillSignedInAs(session.token) || host.adminBotRecLetter.detail.requestId !== requestId) {
    return;
  }
  patch(host, "detail", {
    value: result.ok ? result.value : null,
    loading: false,
    error: readError(result),
  });
}

export async function loadRecLetterFreezeIncidents(host: RecLetterEligibilityHost): Promise<void> {
  const session = wire(host);
  if (!session) {
    return;
  }
  patch(host, "incidents", { loading: true, error: null, loadedAt: Date.now() });
  const result = await fetchRecLetterFreezeIncidents(session.token, session.baseUrl);
  if (!stillSignedInAs(session.token)) {
    return;
  }
  patch(
    host,
    "incidents",
    result.ok
      ? { list: result.value, loading: false }
      : { loading: false, error: failureText(result) },
  );
}

/**
 * Forgets every result an incident change could have moved.
 *
 * The badges, the open panel and the member's own read all depend on the incident list, so after
 * a record or a delete they are re-asked rather than patched: the service owns the arithmetic.
 */
function invalidateResults(host: RecLetterEligibilityHost): void {
  host.adminBotRecLetter = {
    ...host.adminBotRecLetter,
    summaries: {},
    summariesAsked: {},
    detail: { requestId: null, value: null, loading: false, error: null },
    own: { ...host.adminBotRecLetter.own, loadedAt: null },
  };
}

export async function recordRecLetterFreezeIncident(
  host: RecLetterEligibilityHost,
): Promise<boolean> {
  const session = wire(host);
  const form = host.adminBotRecLetter.incidents.form;
  if (!session) {
    return false;
  }
  if (!form.memberId.trim() || !form.occurredOn.trim()) {
    patch(host, "incidents", { error: t("logistics.eligibility.incidents.missingFields") });
    return false;
  }
  patch(host, "incidents", { saving: true, error: null });
  const result = await createRecLetterFreezeIncident(
    {
      member_id: form.memberId.trim(),
      occurred_on: form.occurredOn.trim(),
      ...(form.paperId.trim() ? { paper_id: form.paperId.trim() } : {}),
      ...(form.note.trim() ? { note: form.note.trim() } : {}),
    },
    session.token,
    session.baseUrl,
  );
  if (!stillSignedInAs(session.token)) {
    return false;
  }
  if (!result.ok) {
    patch(host, "incidents", { saving: false, error: failureText(result) });
    return false;
  }
  patch(host, "incidents", { saving: false, form: EMPTY_FREEZE_FORM });
  invalidateResults(host);
  await loadRecLetterFreezeIncidents(host);
  return true;
}

export async function removeRecLetterFreezeIncident(
  host: RecLetterEligibilityHost,
  incidentId: string,
): Promise<boolean> {
  const session = wire(host);
  if (!session) {
    return false;
  }
  patch(host, "incidents", { deletingId: incidentId, error: null });
  const result = await deleteRecLetterFreezeIncident(incidentId, session.token, session.baseUrl);
  if (!stillSignedInAs(session.token)) {
    return false;
  }
  patch(host, "incidents", {
    deletingId: null,
    ...(result.ok ? {} : { error: failureText(result) }),
  });
  if (!result.ok) {
    return false;
  }
  invalidateResults(host);
  await loadRecLetterFreezeIncidents(host);
  return true;
}

export function setRecLetterFreezeForm(
  host: RecLetterEligibilityHost,
  change: Partial<RecLetterFreezeForm>,
): void {
  patch(host, "incidents", { form: { ...host.adminBotRecLetter.incidents.form, ...change } });
}

/**
 * The render pass's read effects.
 *
 * - The letters form, in make mode, reads the member's own result for its advisory note.
 * - An admin's queue reads one badge per member with a letter request on screen.
 * - An admin with a letter request open reads that member's full result.
 * - An admin's view mode reads the incident list once per entry.
 */
export function readRecLetterEligibility(
  host: RecLetterEligibilityHost,
  view: {
    hasMemberSession: boolean;
    isAdmin: boolean;
    lettersFormShowing: boolean;
    queueShowing: boolean;
    queue: readonly LogisticsRequest[];
    open: LogisticsRequest | null;
  },
  requestHostUpdate: (() => void) | undefined,
): void {
  if (!view.hasMemberSession) {
    return;
  }
  const state = host.adminBotRecLetter;
  const redraw = () => requestHostUpdate?.();
  if (view.lettersFormShowing && !state.own.loading && state.own.loadedAt === null) {
    void loadOwnRecLetterEligibility(host).finally(redraw);
  }
  if (!view.isAdmin) {
    return;
  }
  if (view.queueShowing) {
    const ids = view.queue
      .filter((request) => request.kind === "recommendation_letters")
      .map((request) => request.member_id);
    if (ids.some((id) => !state.summariesAsked[id]) && !state.summariesLoading) {
      void loadRecLetterSummaries(host, ids).finally(redraw);
    }
    if (!state.incidents.loading && state.incidents.loadedAt === null) {
      void loadRecLetterFreezeIncidents(host).finally(redraw);
    }
  }
  const open = view.open;
  if (
    open?.kind === "recommendation_letters" &&
    state.detail.requestId !== open.id &&
    !state.detail.loading
  ) {
    void loadRecLetterDetail(host, open.id).finally(redraw);
  }
}
