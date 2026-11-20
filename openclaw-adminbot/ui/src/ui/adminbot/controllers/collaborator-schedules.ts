import type { UiSettings } from "../../storage.ts";
import {
  fetchMemberResource,
  loadStoredMemberSession,
  peekAuthedRead,
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

const COLLABORATOR_SCHEDULES_PATH = "/lab/members/collaborator-schedules";

export async function loadCollaboratorSchedules(host: CollaboratorScheduleHost): Promise<void> {
  const session = loadStoredMemberSession();
  if (!session || host.adminBotCollaboratorSchedulesLoading) {
    return;
  }
  host.adminBotCollaboratorSchedulesLoading = true;
  host.adminBotCollaboratorSchedulesError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  // A second look draws what this session read last time, rather than an empty list for a round
  // trip; the request below still goes out and replaces it. The kept copy belongs to this token
  // alone, so another member signing in on this browser starts from nothing.
  const seen = peekAuthedRead(baseUrl, COLLABORATOR_SCHEDULES_PATH, session.sessionToken) as {
    members?: unknown;
  } | null;
  host.adminBotCollaboratorSchedules = Array.isArray(seen?.members)
    ? (seen.members as AdminBotLabMember[])
    : [];
  host.adminBotCollaboratorSchedulesSession = session.sessionToken;
  try {
    const result = await fetchMemberResource(
      COLLABORATOR_SCHEDULES_PATH,
      session.sessionToken,
      baseUrl,
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
      // The kept list was drawn as a placeholder; a refusal means it may no longer be ours to see.
      host.adminBotCollaboratorSchedules = [];
      host.adminBotCollaboratorSchedulesError = String(error);
    }
  } finally {
    host.adminBotCollaboratorSchedulesLoading = false;
  }
}
