// Paper records, evidence slots, the per-paper cycle, and conference trips.
//
// Controller for this zone: loads through api/papers.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import type { AdminBotMyProjectSummary } from "../../../../../extensions/adminbot/src/workflows/papers/my-projects.js";
import type { UiSettings } from "../../storage.ts";
import { deleteOwnPaper, fetchMyProjects } from "../api/papers.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  type AdminBotHost,
  type AdminBotPaperRecord,
  formatAdminBotToolError,
  invokeAdminBotTool,
} from "./admin.ts";

// A delete changes one row; reloading the lab for it re-read every paper and the roster.
function removeDeletedPaper(host: AdminBotHost, paperId: string): void {
  host.adminBotData = {
    ...host.adminBotData,
    papers: host.adminBotData.papers.filter((entry) => entry.id !== paperId),
    nudges: host.adminBotData.nudges.filter((nudge) => nudge.paper_id !== paperId),
  };
}

export type MyProjectsHost = {
  settings: UiSettings;
  myProjects: AdminBotMyProjectSummary[] | null;
  myProjectsLoading: boolean;
  myProjectsError: string | null;
  requestUpdate?: () => void;
};

/**
 * Reads the viewer's active projects for the sidebar and the project cards.
 *
 * A project's full checklist is the per-paper cycle read, fetched when its page opens; this keeps
 * only the summaries. Writes elsewhere clear `myProjects` to null, which is what asks for it again.
 */
export async function loadMyProjects(host: MyProjectsHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || host.myProjectsLoading) {
    return;
  }
  host.myProjectsLoading = true;
  host.myProjectsError = null;
  host.requestUpdate?.();
  const result = await fetchMyProjects(stored.sessionToken, resolveAdminBotBaseUrl(host.settings));
  // A session that changed while the read was in flight belongs to somebody else now.
  if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
    host.myProjectsLoading = false;
    return;
  }
  if (result.ok) {
    host.myProjects = result.value;
  } else {
    host.myProjectsError =
      result.kind === "unreachable"
        ? "AdminBot is not reachable."
        : "Could not load your projects.";
  }
  host.myProjectsLoading = false;
  host.requestUpdate?.();
}

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
      removeDeletedPaper(host, paper.id);
      return;
    }
    await invokeAdminBotTool(host, "adminbot_delete_paper", { paperId: paper.id });
    if (!stillCurrent()) {
      return;
    }
    host.adminBotNotice = { kind: "success", text: `Deleted paper ${paper.title}.` };
    removeDeletedPaper(host, paper.id);
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
