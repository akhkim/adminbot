// AdminBot client: Reimbursement packets.
//
// Mirrors the service's api/routes/reimbursements.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult, calendarFailure } from "../auth/session.ts";

/**
 * Ask AdminBot to mail a cleared reimbursement package to the funder's office.
 *
 * Sends only the artifacts and which funder they are for. The recipient and the reply-to are the
 * service's to resolve -- from settings and from the member's own record -- so a browser cannot
 * redirect somebody's financial paperwork by editing a request.
 */
export async function submitReimbursementPackage(
  input: {
    funder: "DCS" | "MPI-IS";
    artifacts: Array<{ filename: string; data_base64: string }>;
    submission_proof?: string;
    trip_title?: string;
  },
  sessionToken: string,
  baseUrl: string,
): Promise<AuthResult<{ proposal_id: string; to: string; reply_to: string }>> {
  const result = await authedJson(baseUrl, "/reimbursements/submit", "POST", sessionToken, input);
  if ("unreachable" in result) {
    return { ok: false, kind: "unreachable" };
  }
  if (!result.response.ok) {
    return { ok: false, ...calendarFailure(result.response, result.body) };
  }
  return { ok: true, value: result.body as { proposal_id: string; to: string; reply_to: string } };
}
