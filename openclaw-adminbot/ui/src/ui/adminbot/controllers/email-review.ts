// The email triage review queue.
//
// Controller for this zone: loads through api/email-review.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { resolveEmailReviewAsAdmin } from "../api/email-review.ts";
import { type AdminBotEmailReviewResolution, loadStoredMemberSession } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotHost,
  loadAdminBot,
  requirePrivilegedSession,
} from "./admin.ts";

export async function resolveAdminBotEmailReview(
  host: AdminBotHost,
  messageId: string,
  resolution: AdminBotEmailReviewResolution,
): Promise<void> {
  host.adminBotBusyActionId = `email-review:${messageId}`;
  host.adminBotNotice = null;
  let sessionToken: string | undefined;
  try {
    const session = requirePrivilegedSession(host);
    if (!session) {
      return;
    }
    sessionToken = session.sessionToken;
    const result = await resolveEmailReviewAsAdmin(
      messageId,
      resolution,
      session.sessionToken,
      session.baseUrl,
    );
    if (loadStoredMemberSession()?.sessionToken !== sessionToken) {
      return;
    }
    if (!result.ok) {
      host.adminBotNotice = {
        kind: "error",
        text:
          result.kind === "unreachable"
            ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
            : result.kind === "forbidden"
              ? "Email review requires an administrator account."
              : `Could not resolve this email: ${result.message ?? result.kind}`,
      };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text:
        resolution.kind === "paperflow_evidence"
          ? "Attached the email to the paper. AdminBot will stop reminders for that stage."
          : "Removed the email from AdminBot's review queue without changing any paper.",
    };
    await loadAdminBot(host, undefined, undefined, true);
  } finally {
    if (!sessionToken || loadStoredMemberSession()?.sessionToken === sessionToken) {
      host.adminBotBusyActionId = null;
    }
  }
}
