import { requiresProfileCompletion } from "../../../../../extensions/adminbot/src/contracts/profile-completion.js";

export type ProfileGateState = {
  memberId?: string | null;
  memberPrivilegeLevel?: string | null;
  adminBotData?: { members: readonly { id: string; privilege_level?: string }[] };
};

export function profileAccessState(state: ProfileGateState): "loading" | "incomplete" | "ready" {
  if (!state.memberId || state.memberPrivilegeLevel !== "member") return "ready";
  const member = state.adminBotData?.members.find((entry) => entry.id === state.memberId);
  return !member ? "loading" : requiresProfileCompletion(member) ? "incomplete" : "ready";
}

export function isProfileBlocked(state: ProfileGateState): boolean {
  return profileAccessState(state) === "incomplete";
}
