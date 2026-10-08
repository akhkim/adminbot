// Member nudges and escalations.
//
// Controller for this zone: loads through api/nudges.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { sendMemberNudge } from "../api/nudges.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import {
  ADMINBOT_SERVICE_UNREACHABLE_MESSAGE,
  type AdminBotHost,
  type AdminBotMemberNudgeState,
  loadAdminBot,
} from "./admin.ts";

export function createEmptyAdminBotMemberNudgeState(): AdminBotMemberNudgeState {
  return {
    channel: "slack",
    message: "",
    subject: "",
    selectedMemberIds: [],
    busy: false,
  };
}

// Sends the composed Announcements message to every selected recipient. Requires a real admin
// member session (same reasoning as saveAdminBotMember's direct-write path) since the server
// rejects this route outright for the shared service principal. Each recipient becomes its own
// member_nudge.send proposal awaiting pi/lab_manager approval in Pending actions — this never
// sends anything immediately.
export async function sendAdminBotMemberNudge(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const draft = host.adminBotMemberNudge;
  if (draft.busy) {
    return;
  }
  const message = draft.message.trim();
  if (!message) {
    host.adminBotNotice = { kind: "error", text: "Enter a message to send." };
    return;
  }
  if (draft.selectedMemberIds.length === 0) {
    host.adminBotNotice = { kind: "error", text: "Select at least one recipient." };
    return;
  }
  if (draft.channel === "email" && !draft.subject.trim()) {
    host.adminBotNotice = { kind: "error", text: "Enter a subject line for the email." };
    return;
  }
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your admin account to send a nudge.",
    };
    return;
  }
  host.adminBotMemberNudge = { ...draft, busy: true };
  try {
    const result = await sendMemberNudge(
      {
        channel: draft.channel,
        recipient_member_ids: draft.selectedMemberIds,
        message,
        ...(draft.channel === "email" ? { subject: draft.subject.trim() } : {}),
      },
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (loadStoredMemberSession()?.sessionToken !== stored.sessionToken) {
      return;
    }
    if (!result.ok) {
      const text =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "forbidden"
            ? "Your session no longer has admin access — sign in again and retry."
            : result.kind === "rate-limited"
              ? "Too many attempts. Wait a moment and try again."
              : "Couldn't send this nudge. Check the values and try again.";
      host.adminBotNotice = { kind: "error", text };
      return;
    }
    const { created, skipped } = result.value;
    const skippedNote =
      skipped.length > 0
        ? ` Skipped ${skipped.length}: ${skipped.map((entry) => entry.reason).join(", ")}.`
        : "";
    host.adminBotNotice = {
      kind: skipped.length > 0 ? "error" : "success",
      text: `Sent ${created.length} nudge${created.length === 1 ? "" : "s"}.${skippedNote}`,
    };
    host.adminBotMemberNudge = createEmptyAdminBotMemberNudgeState();
    await loadAdminBot(host, undefined, undefined, true);
  } finally {
    if (loadStoredMemberSession()?.sessionToken === stored.sessionToken) {
      host.adminBotMemberNudge = { ...host.adminBotMemberNudge, busy: false };
    }
  }
}
