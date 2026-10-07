// Paper records, evidence slots, the per-paper cycle, and conference trips.
//
// Controller for this zone: loads through api/papers.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { deleteOwnPaper } from "../api/papers.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  type AdminBotHost,
  type AdminBotPaperRecord,
  formatAdminBotToolError,
  invokeAdminBotTool,
  loadAdminBot,
} from "./admin.ts";

/**
 * Remove a paper.
 *
 * Prefers the member's own session, for the same reason saveAdminBotPaper does: the service scopes
 * the delete to what that member may remove -- any paper for an admin, one they authored for an
 * author -- and a member's paired device holds read-only gateway scopes, so the tool path below is
 * not open to them at all. Until this existed an author who filed a paper by mistake had to ask an
 * admin to undo it.
 */
export async function deleteAdminBotPaper(
  host: AdminBotHost,
  paper: Pick<AdminBotPaperRecord, "id" | "title">,
): Promise<void> {
  const startingToken = loadStoredMemberSession()?.sessionToken ?? null;
  const startingClient = host.client;
  const stillCurrent = () =>
    (loadStoredMemberSession()?.sessionToken ?? null) === startingToken &&
    host.client === startingClient;
  host.adminBotBusyActionId = paper.id;
  host.adminBotNotice = null;
  try {
    const stored = loadStoredMemberSession();
    if (stored) {
      const removed = await deleteOwnPaper(
        paper.id,
        stored.sessionToken,
        resolveAdminBotBaseUrl(host.settings),
      );
      if (!stillCurrent()) {
        return;
      }
      if (!removed.ok) {
        host.adminBotNotice = { kind: "error", text: paperDeleteErrorText(removed.kind) };
        return;
      }
      host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
      await loadAdminBot(host);
      return;
    }
    await invokeAdminBotTool(host, "adminbot_delete_paper", { paperId: paper.id });
    if (!stillCurrent()) {
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
    await loadAdminBot(host);
  } catch (err) {
    if (!stillCurrent()) {
      return;
    }
    host.adminBotNotice = {
      kind: "error",
      text: formatAdminBotToolError(err),
    };
  } finally {
    if (stillCurrent()) {
      host.adminBotBusyActionId = null;
    }
  }
}

/** Deleting fails for its own reasons, and "check the details" is not one of them. */
function paperDeleteErrorText(kind: string): string {
  switch (kind) {
    case "unreachable":
      return "Couldn't reach AdminBot to delete this paper.";
    case "forbidden":
      return "You can only delete papers you authored.";
    case "auth-failed":
      return "Sign in again to delete this paper.";
    default:
      return "Couldn't delete this paper. Try again.";
  }
}
