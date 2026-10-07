// AdminBot client: Collaborate: lab broadcasts.
//
// Mirrors the service's api/routes/lab-sharing.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, mapErrorResponse } from "../auth/session.ts";

/**
 * One lab-wide broadcast from the head of the lab.
 *
 * Mirrors LabDirectorStatus in extensions/adminbot/src/contracts/lab-sharing-status.ts. `id` and
 * `retracted_at` are optional here and not there: a service older than the archive answers without
 * them, and this page should render that rather than crash on it.
 */
export type LabBroadcast = {
  timezone?: string;
  id?: string;
  availability: "available" | "busy" | "away" | "unknown";
  message: string;
  expires_at: string;
  updated_at: string;
  updated_by: string;
  retracted_at?: string;
};

/**
 * The current broadcast and the archive behind it.
 *
 * Both come from one read, because the banner and the "Zhijing's updates" list are two views of the
 * same answer and a second round trip would let them disagree about which entry is current.
 */
export async function fetchLabBroadcasts(
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ status: LabBroadcast | null; history: LabBroadcast[] }>> {
  const result = await authedJson(baseUrl, "/lab-sharing/status", "GET", sessionToken);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { status?: LabBroadcast | null; history?: LabBroadcast[] } | null;
  return {
    ok: true,
    value: { status: body?.status ?? null, history: body?.history ?? [] },
  };
}

/**
 * Publish a broadcast, or take the current one down.
 *
 * Admin-only server-side; this is the write half of `fetchLabBroadcasts`. `clear` retracts rather
 * than deletes -- see the contract note -- so the archive keeps it either way.
 */
export async function publishLabBroadcast(
  draft: {
    availability: LabBroadcast["availability"];
    message: string;
    expires_at: string;
    timezone?: string;
  } | null,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ status: LabBroadcast | null; history: LabBroadcast[] }>> {
  const result = draft
    ? await authedJson(baseUrl, "/lab-sharing/status", "PUT", sessionToken, draft)
    : await authedJson(baseUrl, "/lab-sharing/status/clear", "POST", sessionToken, {});
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  const body = result.body as { status?: LabBroadcast | null; history?: LabBroadcast[] } | null;
  return { ok: true, value: { status: body?.status ?? null, history: body?.history ?? [] } };
}
