// AdminBot client: Venue paper search, lab relevance, and workshop nudges.
//
// Mirrors the service's api/routes/conference-papers.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, mapErrorResponse } from "../auth/session.ts";

/** Lists the conferences an admin has made searchable, with how fresh each index is. */
export async function fetchVenueSources(
  sessionToken: string | null,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/sources", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export type VenuePaperCategory = { id: string; label: string; paper_count: number };

export async function fetchVenueCategories(
  venueId: string,
  sessionToken: string | null,
  baseUrl: string,
): Promise<AuthResult<{ venue_id: string; categories: VenuePaperCategory[] }>> {
  const query = new URLSearchParams({ venue_id: venueId });
  const result = await authedJson(
    baseUrl,
    `/venue-papers/categories?${query.toString()}`,
    "GET",
    sessionToken,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { venue_id?: unknown; categories?: unknown } | null;
  if (typeof body?.venue_id !== "string" || !Array.isArray(body.categories)) {
    return { ok: false, kind: "draft-failed", message: "The category list was malformed." };
  }
  const categories = body.categories.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const category = entry as Record<string, unknown>;
    return typeof category.id === "string" &&
      category.id.trim().length > 0 &&
      typeof category.label === "string" &&
      category.label.trim().length > 0 &&
      typeof category.paper_count === "number" &&
      Number.isInteger(category.paper_count) &&
      category.paper_count >= 0
      ? [
          {
            id: category.id.trim(),
            label: category.label.trim(),
            paper_count: category.paper_count,
          },
        ]
      : [];
  });
  return { ok: true, value: { venue_id: body.venue_id, categories } };
}

/**
 * Ranks one conference's accepted papers against what the member says they work on.
 *
 * Carries the service's own sentence up for every failure, not just 400: "that conference has not
 * been indexed yet" (409) and "the embedding model is not reachable" (502) are both things the
 * reader can act on, and the generic copy would throw them away.
 */
export async function searchVenuePapers(
  params: { venueId: string; interests: string; categoryId?: string },
  sessionToken: string | null,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/search", "POST", sessionToken, {
    venue_id: params.venueId,
    interests: params.interests,
    ...(params.categoryId ? { category_id: params.categoryId } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Ranks the lab's own papers against a topic, a keyword, or a whole research proposal.
 *
 * Needs a session where the conference search does not: that one ranks a published programme, this
 * one returns our own paper titles and where they sit. Carries the service's sentence up for the
 * same reason -- "the embedding model is not reachable" (502) is the common failure here and it is
 * something the reader can act on.
 */
export async function searchLabPaperRelevance(
  params: { query: string },
  sessionToken: string | null,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/lab-papers/relevance", "POST", sessionToken, {
    query: params.query,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

/**
 * Fill in run fields an older service does not send.
 *
 * Vercel ships this UI ahead of the Aurora service as a matter of routine, so every run field
 * added on the server arrives as `undefined` here for however long that gap lasts. Defaulting at
 * the boundary is what keeps a page that renders "3 of 2540 calls failed" from rendering
 * "undefined of 2540 calls failed" against a service that has never heard of failed calls.
 */
export function withWorkshopRunDefaults(body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }
  const run = body as Record<string, unknown>;
  if (typeof run.status !== "string") {
    return body;
  }
  return {
    ...run,
    calls_failed: typeof run.calls_failed === "number" ? run.calls_failed : 0,
    ...(run.preview && typeof run.preview === "object"
      ? { preview: withWorkshopProfiles(run.preview as Record<string, unknown>) }
      : {}),
  };
}

/**
 * Put each pair's workshop profile back on the pair.
 *
 * The service sends every profile once, in `workshops`, and has each pair name its workshop by id
 * -- the same profile used to ride on every pair and again inside every draft. The page reads
 * `recommendation.workshop`, so it is restored here. An older service still nests the profile and
 * sends no `workshops`; that body passes through untouched.
 */
function withWorkshopProfiles(preview: Record<string, unknown>): Record<string, unknown> {
  const workshops = preview.workshops;
  if (!workshops || typeof workshops !== "object") {
    return preview;
  }
  const profiles = workshops as Record<string, unknown>;
  const hydrate = (entries: unknown): unknown =>
    Array.isArray(entries)
      ? entries.map((entry) => {
          const pair = entry as Record<string, unknown>;
          return typeof pair.workshop_id === "string" && !pair.workshop
            ? { ...pair, workshop: profiles[pair.workshop_id] }
            : pair;
        })
      : entries;
  const withPairs = (groups: unknown): unknown =>
    Array.isArray(groups)
      ? groups.map((group) => {
          const record = group as Record<string, unknown>;
          return { ...record, recommendations: hydrate(record.recommendations) };
        })
      : groups;
  const { workshops: _workshops, ...rest } = preview;
  return {
    ...rest,
    recipients: withPairs(preview.recipients),
    unresolved_recipients: withPairs(preview.unresolved_recipients),
  };
}

/**
 * Stop the pass in flight (POST /workshop-nudges/cancel).
 *
 * A service too old to know this route answers 404, which `mapErrorResponse` turns into an error
 * the page shows rather than a crash -- the right outcome while Vercel is ahead of Aurora, because
 * the stall window still recovers the run on its own, just more slowly.
 */
export async function cancelWorkshopNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/workshop-nudges/cancel", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: withWorkshopRunDefaults(result.body) };
}

/** Computes the current native-paper workshop preview. Admin only; it sends nothing. */
export async function previewWorkshopNudges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/workshop-nudges/preview", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: withWorkshopRunDefaults(result.body) };
}

export type WorkshopConferenceOption = {
  key: string;
  label: string;
  workshop_count: number;
};

/**
 * The conferences a pass may be narrowed to (GET /workshop-nudges/conferences).
 *
 * Cheap on the service side -- no model calls -- so the page asks on open. An older service has no
 * such route; the caller treats that as "no picker" rather than as an error, so the tab keeps
 * working against a deployment that has not been updated yet.
 */
export async function fetchWorkshopConferences(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<WorkshopConferenceOption[]>> {
  const result = await authedJson(baseUrl, "/workshop-nudges/conferences", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const rows = (result.body as { conferences?: unknown } | null)?.conferences;
  return {
    ok: true,
    value: Array.isArray(rows) ? (rows as WorkshopConferenceOption[]) : [],
  };
}

/**
 * Ask for a fresh match (POST /workshop-nudges/refresh).
 *
 * Returns as soon as the pass has started, not when it finishes: the pass is thousands of model
 * calls and no browser holds a connection that long. Poll previewWorkshopNudges for the answer.
 */
export async function refreshWorkshopNudges(
  sessionToken: string,
  baseUrl: string,
  // `force` replaces a pass that still claims to be running. An older service ignores the field
  // and applies its own stall window, which is slower but not wrong.
  force = false,
  // The conference the admin narrowed the pass to. An older service ignores the field and runs the
  // whole open season, which is the pre-existing behaviour rather than a wrong one.
  conferenceKey?: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/workshop-nudges/refresh", "POST", sessionToken, {
    ...(force ? { force: true } : {}),
    ...(conferenceKey?.trim() ? { conference_key: conferenceKey.trim() } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: withWorkshopRunDefaults(result.body) };
}

/** Recomputes selected recipients and sends one server-generated Slack nudge to each. */
export async function sendWorkshopNudges(
  recipientMemberIds: string[],
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/workshop-nudges/send", "POST", sessionToken, {
    recipient_member_ids: recipientMemberIds,
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}

export async function rebuildVenueIndexes(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<unknown>> {
  const result = await authedJson(baseUrl, "/venue-papers/index", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    const message = (result.body as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return { ok: false, kind: "auth-failed", message: message.trim() };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return { ok: true, value: result.body };
}
