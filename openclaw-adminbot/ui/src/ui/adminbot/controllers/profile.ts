// The signed-in member's own record: onboarding acks, profile photo, location prompts.
//
// Controller for this zone: loads through api/profile.ts and writes the result onto the host state.
// Cut from controllers/admin.ts, which keeps the host shape and the shared lab read.

import { applyOwnPolishedProfilePhoto, polishOwnProfilePhoto } from "../api/profile.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { ADMINBOT_SERVICE_UNREACHABLE_MESSAGE, type AdminBotHost, loadAdminBot } from "./admin.ts";

export async function polishAdminBotOwnProfilePhoto(host: AdminBotHost): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to polish your profile photo.",
    };
    return;
  }
  host.adminBotPhotoPolishBusy = true;
  try {
    const result = await polishOwnProfilePhoto(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "rate-limited"
            ? "Too many attempts. Wait a moment and try again."
            : "Couldn't generate a polished photo right now.";
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: "Generated a polished photo option. Review it below and apply if you like it.",
    };
    await loadAdminBot(host, "general");
  } finally {
    host.adminBotPhotoPolishBusy = false;
  }
}

export async function applyAdminBotOwnProfilePhoto(
  host: AdminBotHost,
  variantId: string,
): Promise<void> {
  host.adminBotNotice = null;
  const stored = loadStoredMemberSession();
  if (!stored) {
    host.adminBotNotice = {
      kind: "error",
      text: "Sign in with your member account to apply a profile photo.",
    };
    return;
  }
  host.adminBotPhotoApplyBusy = true;
  try {
    const result = await applyOwnPolishedProfilePhoto(
      variantId,
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    );
    if (!result.ok) {
      const message =
        result.kind === "unreachable"
          ? ADMINBOT_SERVICE_UNREACHABLE_MESSAGE
          : result.kind === "rate-limited"
            ? "Too many attempts. Wait a moment and try again."
            : "Couldn't apply that photo to Slack. Try another variant or retry.";
      host.adminBotNotice = { kind: "error", text: message };
      return;
    }
    host.adminBotNotice = {
      kind: "success",
      text: "Updated your Slack profile photo to the selected version.",
    };
    await loadAdminBot(host, "general");
  } finally {
    host.adminBotPhotoApplyBusy = false;
  }
}
