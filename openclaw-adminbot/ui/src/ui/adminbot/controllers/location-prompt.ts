// The "have you moved?" banner's side of the wire.
//
// Two calls and no state of its own beyond the banner: the answer goes through the service, which
// writes the profile through the ordinary self-edit path, so the roster reloads afterwards rather
// than being patched locally.
import {
  answerLocationPrompt,
  fetchLocationDrifts,
  fetchLocationPrompt,
  loadStoredMemberSession,
  resolveAdminBotBaseUrl,
} from "../auth/session.ts";
import { loadAdminBot, type AdminBotHost } from "./admin.ts";

export async function loadAdminBotLocationPrompt(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  const result = await fetchLocationPrompt(stored.sessionToken, baseUrl);
  // Deliberately silent on failure. This banner is an unprompted courtesy; an error notice for a
  // question the member never asked would be worse than not asking it.
  host.adminBotLocationDrift = result.ok ? result.value : null;
}

export async function answerAdminBotLocationPrompt(
  host: AdminBotHost,
  answer: { current_city?: string; timezone?: string },
): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  host.adminBotLocationSaving = true;
  host.adminBotLocationError = null;
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  try {
    const result = await answerLocationPrompt(answer, stored.sessionToken, baseUrl);
    if (!result.ok) {
      host.adminBotLocationError = result.message ?? "Could not save that. Try again.";
      return;
    }
    // Cleared locally as well as on the server: the banner has been answered, and leaving it on
    // screen until the next reload would invite a second answer.
    host.adminBotLocationDrift = null;
    if (answer.current_city) {
      await loadAdminBot(host, "general");
    }
  } finally {
    host.adminBotLocationSaving = false;
  }
}

/**
 * Load the drift list the calendar flags attendees with.
 *
 * Silent on failure for the same reason the banner is: this decorates a screen that works without
 * it, and a member who is not an admin gets a 403 here as a matter of course.
 */
export async function loadAdminBotLocationDrifts(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const result = await fetchLocationDrifts(
    stored.sessionToken,
    resolveAdminBotBaseUrl(host.settings),
  );
  host.adminBotLocationDrifts = result.ok ? result.value : [];
}
