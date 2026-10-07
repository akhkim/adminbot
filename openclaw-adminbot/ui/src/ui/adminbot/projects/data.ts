// Reads the viewer's active projects from the service, for the sidebar and the card list.
//
// The service decides what "mine" and "active" mean (GET /my/projects); this only fetches the
// summaries and keeps them on the host. A project's full checklist is the existing per-paper cycle
// read (loadAdminBotPaperSlots), fetched when its page opens.
import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import type { ProjectSummary } from "./model.ts";

export type MyProjectsHost = {
  settings: UiSettings;
  myProjects: ProjectSummary[] | null;
  myProjectsLoading: boolean;
  myProjectsError: string | null;
  requestUpdate?: () => void;
};

export async function loadMyProjects(host: MyProjectsHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored || host.myProjectsLoading) {
    return;
  }
  host.myProjectsLoading = true;
  host.myProjectsError = null;
  host.requestUpdate?.();
  const result = await fetchMemberResource(
    "/my/projects",
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  // A session that changed while the read was in flight belongs to somebody else now.
  if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
    host.myProjectsLoading = false;
    return;
  }
  if (result.ok) {
    const body = result.value as { projects?: ProjectSummary[] } | null;
    host.myProjects = body?.projects ?? [];
  } else {
    host.myProjectsError =
      result.kind === "unreachable"
        ? "AdminBot is not reachable."
        : "Could not load your projects.";
  }
  host.myProjectsLoading = false;
  host.requestUpdate?.();
}
