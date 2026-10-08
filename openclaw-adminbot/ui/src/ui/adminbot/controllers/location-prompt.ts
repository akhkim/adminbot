// The "have you moved?" banner's side of the wire.
//
// Two calls and no state of its own beyond the banner: the answer goes through the service, which
// writes the profile through the ordinary self-edit path, so the roster reloads afterwards rather
// than being patched locally.
import { answerLocationPrompt, fetchLocationDrifts, fetchLocationPrompt } from "../api/profile.ts";
import { loadStoredMemberSession, resolveAdminBotBaseUrl } from "../auth/session.ts";
import { loadAdminBot, type AdminBotHost } from "./admin.ts";

let promptInFlight: { token: string; request: ReturnType<typeof fetchLocationPrompt> } | null =
  null;
let driftsInFlight: { token: string; request: ReturnType<typeof fetchLocationDrifts> } | null =
  null;

function sameSession(token: string): boolean {
  return loadStoredMemberSession()?.sessionToken === token;
}

export async function loadAdminBotLocationPrompt(host: AdminBotHost): Promise<void> {
  const stored = loadStoredMemberSession();
  if (!stored) {
    return;
  }
  const baseUrl = resolveAdminBotBaseUrl(host.settings);
  // The render pass asks while the answer is undefined, so every render before it lands would start
  // another identical request. Tracked by token, not on the host, so a member who signs in while
  // the previous one's request is in flight still gets asked.
  //
  // A repeat ask waits on the request in flight rather than returning at once. The render pass
  // re-renders when its ask settles, so an ask that settled immediately would re-render, ask again
  // and settle again -- a microtask loop that starves the very response it is waiting for.
  if (promptInFlight?.token !== stored.sessionToken) {
    const request = fetchLocationPrompt(stored.sessionToken, baseUrl).finally(() => {
      if (promptInFlight?.request === request) promptInFlight = null;
    });
    promptInFlight = { token: stored.sessionToken, request };
  }
  const result = await promptInFlight.request;
  if (!sameSession(stored.sessionToken)) {
    return;
  }
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
    if (!sameSession(stored.sessionToken)) {
      return;
    }
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
    if (sameSession(stored.sessionToken)) {
      host.adminBotLocationSaving = false;
    }
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
  // Same render-pass guard as the prompt above, waiting on the request in flight for the same reason.
  if (driftsInFlight?.token !== stored.sessionToken) {
    const request = fetchLocationDrifts(
      stored.sessionToken,
      resolveAdminBotBaseUrl(host.settings),
    ).finally(() => {
      if (driftsInFlight?.request === request) driftsInFlight = null;
    });
    driftsInFlight = { token: stored.sessionToken, request };
  }
  const result = await driftsInFlight.request;
  if (!sameSession(stored.sessionToken)) {
    return;
  }
  host.adminBotLocationDrifts = result.ok ? result.value : [];
}
