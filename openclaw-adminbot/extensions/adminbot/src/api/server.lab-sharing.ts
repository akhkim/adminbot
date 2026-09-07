import type { IncomingMessage, ServerResponse } from "node:http";
import { askMemberGuidebook } from "../guidebook/member-ask.js";
import type { AdminBotService } from "../kernel/service.js";
import { readJson, sendJson, sendServiceResult } from "./server.http.js";

export async function handleLabSharingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: AdminBotService,
  memberId: string,
): Promise<void> {
  if (url.pathname === "/lab-sharing/invites") {
    if (req.method === "GET") {
      sendServiceResult(res, service.labSharingInvites().list(memberId));
      return;
    }
    if (req.method === "POST") {
      let body: unknown;
      try {
        body = await readJson(req, 4096);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        sendJson(res, 400, { error: { message: "Expected an invitation as JSON." } });
        return;
      }
      sendServiceResult(res, service.labSharingInvites().request(memberId, body));
      return;
    }
  }
  if (req.method === "POST" && url.pathname === "/lab-sharing/ask") {
    let body: unknown;
    try {
      body = await readJson(req, 4096);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      sendJson(res, 400, { error: { message: "Expected a question as JSON." } });
      return;
    }
    const question =
      body && typeof body === "object" ? (body as Record<string, unknown>).question : undefined;
    if (typeof question !== "string" || !question.trim() || question.trim().length > 1000) {
      sendJson(res, 400, { error: { message: "Enter a question of 1 to 1000 characters." } });
      return;
    }
    sendJson(res, 200, await askMemberGuidebook(question.trim()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab-sharing") {
    sendServiceResult(res, service.labSharing().list(memberId));
    return;
  }
  if (req.method === "GET" && url.pathname === "/lab-sharing/members") {
    sendServiceResult(
      res,
      service.labSharing().searchMembers(memberId, url.searchParams.get("q") ?? ""),
    );
    return;
  }
  if (url.pathname === "/lab-sharing/status" && req.method === "GET") {
    sendServiceResult(res, service.labSharing().directorStatus().read(memberId));
    return;
  }
  if (
    (url.pathname === "/lab-sharing/status" && req.method === "PUT") ||
    (url.pathname === "/lab-sharing/status/clear" && req.method === "POST")
  ) {
    const clear = url.pathname.endsWith("/clear");
    let body: unknown;
    try {
      body = clear ? null : await readJson(req, 4096);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      sendJson(res, 400, { error: { message: "Expected valid JSON for a shared status." } });
      return;
    }
    sendServiceResult(res, service.labSharing().directorStatus().save(memberId, body, clear));
    return;
  }
  const interest = /^\/lab-sharing\/requests\/([^/]+)\/interest(\/withdraw)?$/u.exec(url.pathname);
  if (
    interest &&
    ((req.method === "PUT" && !interest[2]) || (req.method === "POST" && interest[2]))
  ) {
    let body: unknown;
    try {
      body = interest[2] ? {} : await readJson(req, 4096);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      sendJson(res, 400, { error: { message: "Expected valid JSON for an offer to help." } });
      return;
    }
    sendServiceResult(
      res,
      service
        .labSharing()
        .interest(memberId, decodeURIComponent(interest[1]), body, Boolean(interest[2])),
    );
    return;
  }
  const match = /^\/lab-sharing\/requests\/([^/]+)(\/close)?$/u.exec(url.pathname);
  if (match && ((req.method === "PUT" && !match[2]) || (req.method === "POST" && match[2]))) {
    const body = match[2] ? {} : await readJson(req, 16_384);
    sendServiceResult(
      res,
      service.labSharing().save(memberId, decodeURIComponent(match[1]), body, Boolean(match[2])),
    );
    return;
  }
  sendJson(res, 404, { error: { message: "Unknown Lab Sharing route." } });
}
