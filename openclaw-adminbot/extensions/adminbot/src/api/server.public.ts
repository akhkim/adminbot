import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveAdminBotControlUiUrl } from "../contracts/control-ui.js";
import type { AdminBotService, AdminBotServiceStore } from "../kernel/service.js";
import { renderAdminBotWebUi } from "../web/console/index.js";
import { renderMemberMapWebUi } from "../web/member-map/index.js";
import { renderVenuePickerWebUi } from "../web/venue-picker/index.js";
import { DEADLINE_VENUES } from "../workflows/deadlines/generated/dataset.js";
import { findAvatar } from "./avatars.js";
import { isForeignOrigin } from "./routes/origin.js";
import { sendAvatar, sendHtml, sendJson, sendRedirect } from "./server.http.js";

/**
 * The routes answered before anyone is identified: page shells, the public deadline feed and
 * profile photos. Nothing here reads a session, so nothing here may depend on who is asking.
 *
 * Returns whether the request was answered.
 */
export function servePublicRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { service: AdminBotService; store: AdminBotServiceStore },
): boolean {
  // `/` is the address a person types, so it hands them the Control UI rather than the built-in
  // console. The console is a thin operator surface with no sign-in and no member flows (see
  // contracts/control-ui.ts), so landing on it from the bare hostname reads as "this is the
  // product" when it is really the fallback. It keeps its own address at `/adminbot`, which is
  // what makes the redirect safe: when the Control UI deployment is down, the operator surface is
  // still reachable on this origin without touching configuration.
  if (req.method === "GET" && url.pathname === "/") {
    const controlUi = resolveAdminBotControlUiUrl();
    // A Control UI configured to this same origin would redirect to itself forever and leave the
    // service unopenable in a browser. Serving the console is the strictly better failure: the
    // operator sees something, and the misconfiguration is visible rather than fatal.
    if (isForeignOrigin(controlUi, req)) {
      sendRedirect(res, `${controlUi}/`);
      return true;
    }
    sendHtml(res, renderAdminBotWebUi);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/adminbot") {
    sendHtml(res, renderAdminBotWebUi);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/deadlines") {
    sendJson(res, 200, { items: ctx.service.deadlineReadModel(DEADLINE_VENUES) });
    return true;
  }
  // Public and login-free by design: the deck asks for the venue guide to be reachable by anyone
  // the guidebook or the chatbot points at it, including collaborators with no AdminBot account.
  // Served here, above resolvePrincipal, for the same reason /deadlines is.
  if (req.method === "GET" && url.pathname === "/venue-picker") {
    sendHtml(res, renderVenuePickerWebUi);
    return true;
  }
  // Public for the same reason the member map is: the hash is only known to someone already sent
  // the photo, and an <img> on the console's origin cannot carry the bearer token.
  if (req.method === "GET" && url.pathname.startsWith("/avatars/")) {
    sendAvatar(
      res,
      findAvatar(url.pathname.slice("/avatars/".length), () => ctx.store.listLabMembers()),
    );
    return true;
  }
  if (req.method === "GET" && url.pathname === "/lab_stats/member_map") {
    sendHtml(res, renderMemberMapWebUi);
    return true;
  }
  return false;
}
