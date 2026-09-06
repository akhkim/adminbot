import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotService } from "../kernel/service.js";
import { readJson, sendJson, sendServiceResult } from "./server.http.js";

export async function handleLabSharingRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: AdminBotService,
  memberId: string,
): Promise<void> {
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
