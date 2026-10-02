/** Deadline recommendation routes; the caller supplies an authenticated, non-impersonated member. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AdminBotService } from "../kernel/service.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "./server.http.js";

export async function handleDeadlineRecommendationRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: AdminBotService,
  memberId: string,
): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method === "GET" && url.pathname === "/deadline-recommendations") {
    const mode = url.searchParams.get("mode") ?? "summary";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    if (
      !["summary", "members", "papers"].includes(mode) ||
      !Number.isSafeInteger(offset) ||
      offset < 0
    ) {
      sendJson(res, 400, { error: { message: "Invalid recommendation query" } });
      return;
    }
    sendServiceResult(
      res,
      service.deadlineRecommendationDirectory(memberId, {
        mode: mode as "summary" | "members" | "papers",
        offset,
        q: url.searchParams.get("q") ?? undefined,
        recipient: url.searchParams.get("recipient") ?? undefined,
        deadlineIds: url.searchParams.has("deadline")
          ? url.searchParams.getAll("deadline")
          : undefined,
      }),
    );
    return;
  }
  if (req.method === "POST" && url.pathname === "/deadline-recommendations/preview") {
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      service.previewDeadlineRecommendation(memberId, {
        deadline_id: asString(body.deadline_id) ?? "",
        recipient_member_id: asString(body.recipient_member_id) ?? "",
        paper_ids: body.paper_ids as string[] | undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      }),
    );
    return;
  }
  const send = /^\/deadline-recommendations\/([^/]+)\/send$/u.exec(url.pathname);
  if (req.method === "POST" && send) {
    const body = readRecord(await readJson(req));
    sendServiceResult(
      res,
      await service.sendDeadlineRecommendation(
        memberId,
        decodeURIComponent(send[1]),
        asString(body.payload_hash) ?? "",
      ),
    );
    return;
  }
  sendJson(res, 404, { error: { message: "not found" } });
}
