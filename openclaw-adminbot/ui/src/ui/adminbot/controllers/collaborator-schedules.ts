import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import type { AdminBotLabMember } from "./admin.ts";

type CollaboratorScheduleHost = {
  settings: UiSettings;
  adminBotCollaboratorSchedules: AdminBotLabMember[];
  adminBotCollaboratorSchedulesLoading: boolean;
  adminBotCollaboratorSchedulesError: string | null;
  adminBotCollaboratorSchedulesSession: string;
};

export async function loadCollaboratorSchedules(host: CollaboratorScheduleHost): Promise<void> {
  const session = loadStoredMemberSession();
  if (!session || host.adminBotCollaboratorSchedulesLoading) {
    return;
  }
  host.adminBotCollaboratorSchedulesLoading = true;
  host.adminBotCollaboratorSchedulesError = null;
  host.adminBotCollaboratorSchedules = [];
  host.adminBotCollaboratorSchedulesSession = session.sessionToken;
  try {
    const result = await fetchMemberResource(
      "/lab/members/collaborator-schedules",
      session.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (loadStoredMemberSession()?.sessionToken !== session.sessionToken) {
      return;
    }
    if (!result.ok) {
      throw new Error("Collaborator schedules could not be loaded. Please try again.");
    }
    const value = result.value as {
      members: typeof host.adminBotCollaboratorSchedules;
    };
    if (!Array.isArray(value.members)) {
      throw new Error("Invalid collaborator schedule response. Please try again.");
    }
    host.adminBotCollaboratorSchedules = value.members;
  } catch (error) {
    if (loadStoredMemberSession()?.sessionToken === session.sessionToken) {
      host.adminBotCollaboratorSchedulesError = String(error);
    }
  } finally {
    host.adminBotCollaboratorSchedulesLoading = false;
  }
}
