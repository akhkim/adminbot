// AdminBot client: The email triage review queue.
//
// Mirrors the service's api/routes/email-review.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import {
  type AdminBotEmailReviewResolution,
  authedJson,
  type AuthResult,
  mapErrorResponse,
} from "../auth/session.ts";

export async function resolveEmailReviewAsAdmin(
  messageId: string,
  resolution: AdminBotEmailReviewResolution,
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ resolution: string; evidence_recorded: boolean }>> {
  const result = await authedJson(
    baseUrl,
    `/automation/email/review/${encodeURIComponent(messageId)}`,
    "POST",
    sessionToken,
    resolution,
  );
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...mapErrorResponse(result.response, result.body, { weakOn400: false }) };
  }
  return {
    ok: true,
    value: result.body as { resolution: string; evidence_recorded: boolean },
  };
}
