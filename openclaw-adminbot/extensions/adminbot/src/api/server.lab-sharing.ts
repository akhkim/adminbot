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
