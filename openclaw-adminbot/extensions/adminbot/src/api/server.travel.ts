import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotService } from "../kernel/service.js";
import { readJson, sendJson, sendServiceResult } from "./server.http.js";

// The member Travel tab. Every route takes the member id from the session (the caller has already
// refused anything that is not a member session), so nobody can RSVP, share or look up on someone
// else's behalf -- and the service token, which speaks for the agent, cannot read anybody's
// whereabouts at all.

async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | undefined> {
  try {
    return await readJson(req, 4096);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    sendJson(res, 400, { error: { message: "Expected JSON." } });
    return undefined;
  }
}

function decodeKey(raw: string, res: ServerResponse): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    sendJson(res, 400, { error: { message: "Invalid conference identifier." } });
    return undefined;
  }
}

export async function handleTravelRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: AdminBotService,
  memberId: string,
): Promise<void> {
  const travel = service.labTravel();
  if (req.method === "GET" && url.pathname === "/travel") {
    sendServiceResult(res, travel.overview(memberId));
    return;
  }
  if (req.method === "GET" && url.pathname === "/travel/sharing") {
    sendServiceResult(res, travel.sharing(memberId));
    return;
  }
  if (req.method === "PUT" && url.pathname === "/travel/sharing") {
    const body = await readBody(req, res);
    if (body === undefined) {
      return;
    }
    sendServiceResult(res, travel.setSharing(memberId, body));
    return;
  }
  if (req.method === "POST" && url.pathname === "/travel/location") {
    const body = await readBody(req, res);
    if (body === undefined) {
      return;
    }
    sendServiceResult(res, travel.reportLocation(memberId, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/travel/whos-in") {
    sendServiceResult(res, travel.whosIn(memberId, url.searchParams));
    return;
  }
  const rsvp = /^\/travel\/conferences\/([^/]+)\/rsvp$/u.exec(url.pathname);
  if (rsvp?.[1] && (req.method === "PUT" || req.method === "DELETE")) {
    const key = decodeKey(rsvp[1], res);
    if (key === undefined) {
      return;
    }
    if (req.method === "DELETE") {
      sendServiceResult(res, travel.withdraw(memberId, key));
      return;
    }
    const body = await readBody(req, res);
    if (body === undefined) {
      return;
    }
    sendServiceResult(res, travel.rsvp(memberId, key, body));
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}
