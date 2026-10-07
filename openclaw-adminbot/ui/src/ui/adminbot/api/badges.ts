// AdminBot client: Badges, nominations, and suggestions.
//
// Mirrors the service's api/routes/badges.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  type AssignedBadge,
  authedJson,
  type AuthResult,
  type BadgeNominationStatus,
  type BadgeNominationView,
  type BadgeSuggestionInput,
  type BadgeSuggestionStatus,
  type BadgeSuggestionView,
  mapErrorResponse,
} from "../auth/session.ts";

export type BadgeDefinitionInput = {
  id?: string;
  category: string;
  name: string;
  description: string;
  criteria_url?: string;
  tier?: string;
};

export type BadgeDefinition = BadgeDefinitionInput & {
  id: string;
  family_key: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export async function fetchBadges(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeDefinition[]>> {
  const result = await authedJson(baseUrl, "/badges", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const badges = (result.body as { badges?: BadgeDefinition[] } | null)?.badges ?? [];
  return { ok: true, value: badges };
}

export async function createBadge(
  input: BadgeDefinitionInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeDefinition>> {
  const result = await authedJson(baseUrl, "/badges", "POST", sessionToken, input);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const badge = (result.body as { badge?: BadgeDefinition } | null)?.badge;
  return badge ? { ok: true, value: badge } : { ok: false, kind: "auth-failed" };
}

export async function updateBadge(
  badgeId: string,
  input: Partial<BadgeDefinitionInput>,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeDefinition>> {
  const result = await authedJson(
    baseUrl,
    `/badges/${encodeURIComponent(badgeId)}`,
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
  const badge = (result.body as { badge?: BadgeDefinition } | null)?.badge;
  return badge ? { ok: true, value: badge } : { ok: false, kind: "auth-failed" };
}

export async function assignBadgeToMember(
  memberId: string,
  badgeId: string,
  sessionToken: string,
  baseUrl: string,
  evidence?: string,
  count?: number,
): Promise<AuthResult<AssignedBadge>> {
  const result = await authedJson(baseUrl, "/badges/assignments", "POST", sessionToken, {
    member_id: memberId,
    badge_id: badgeId,
    ...(count !== undefined ? { count } : {}),
    ...(evidence ? { evidence } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const assignment = (result.body as { assignment?: AssignedBadge } | null)?.assignment;
  return assignment ? { ok: true, value: assignment } : { ok: false, kind: "auth-failed" };
}

export async function removeBadgeFromMember(
  memberId: string,
  badgeId: string,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<void>> {
  const result = await authedJson(
    baseUrl,
    `/badges/assignments/${encodeURIComponent(memberId)}/${encodeURIComponent(badgeId)}`,
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
  return { ok: true, value: undefined };
}

export async function fetchBadgeNominations(
  sessionToken: string,
  baseUrl: string,
  params: { memberId?: string; status?: BadgeNominationStatus } = {},
): Promise<AuthResult<BadgeNominationView[]>> {
  const query = new URLSearchParams();
  if (params.memberId) {
    query.set("member_id", params.memberId);
  }
  if (params.status) {
    query.set("status", params.status);
  }
  const path = query.size ? `/badges/nominations?${query.toString()}` : "/badges/nominations";
  const result = await authedJson(baseUrl, path, "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const nominations = (result.body as { nominations?: BadgeNominationView[] } | null)?.nominations;
  return { ok: true, value: nominations ?? [] };
}

/**
 * Put a badge forward, for yourself or for a colleague.
 *
 * `memberId` names who the badge is *for*; who it is from is the session, which is why it is not in
 * this payload. Omitted for a self-nomination so the service files it as one.
 */
export async function submitBadgeNomination(
  input: { badgeId: string; evidence: string; memberId?: string },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeNominationView>> {
  const result = await authedJson(baseUrl, "/badges/nominations", "POST", sessionToken, {
    badge_id: input.badgeId,
    evidence: input.evidence,
    ...(input.memberId ? { member_id: input.memberId } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const nomination = (result.body as { nomination?: BadgeNominationView } | null)?.nomination;
  return nomination ? { ok: true, value: nomination } : { ok: false, kind: "auth-failed" };
}

/**
 * Badge suggestions: what the catalogue should contain, as opposed to who holds what.
 *
 * The service decides the scope, not this call. A plain member gets their own suggestions back and
 * an admin gets the whole queue, from the same URL -- passing a member id here would be the client
 * asking for somebody else's, which the service would ignore anyway.
 */
export async function fetchBadgeSuggestions(
  sessionToken: string,
  baseUrl: string,
  params: { status?: BadgeSuggestionStatus } = {},
): Promise<AuthResult<BadgeSuggestionView[]>> {
  const path = params.status
    ? `/badges/suggestions?status=${encodeURIComponent(params.status)}`
    : "/badges/suggestions";
  const result = await authedJson(baseUrl, path, "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    if (result.response.status === 403) {
      return { ok: false, kind: "forbidden" };
    }
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const suggestions = (result.body as { suggestions?: BadgeSuggestionView[] } | null)?.suggestions;
  return { ok: true, value: suggestions ?? [] };
}

export async function submitBadgeSuggestion(
  input: BadgeSuggestionInput,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<BadgeSuggestionView>> {
  const result = await authedJson(baseUrl, "/badges/suggestions", "POST", sessionToken, {
    category: input.category,
    name: input.name,
    description: input.description,
    rationale: input.rationale,
    ...(input.criteria_url ? { criteria_url: input.criteria_url } : {}),
    ...(input.tier ? { tier: input.tier } : {}),
  });
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const suggestion = (result.body as { suggestion?: BadgeSuggestionView } | null)?.suggestion;
  return suggestion ? { ok: true, value: suggestion } : { ok: false, kind: "auth-failed" };
}
