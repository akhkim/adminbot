// The logistics request routes: what a member asks the lab for, and what the lab says back.
//
// Cut from server.ts's route table because the access rule is the same on all six routes and reads
// better in one place: reads are scoped to the caller unless the caller is an admin, writes to a
// request's content belong to whoever submitted it, and the status column belongs to the lab. The
// service re-checks every one of those -- what happens here decides which service call to make,
// not who is allowed to make it.
//
// Takes the resolved member rather than the router's principal union, so this file imports nothing
// from server.ts and the two cannot form a cycle.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  adminBotLogisticsRequestStatuses,
  type AdminBotLogisticsAttachment,
  type AdminBotLogisticsRequestInput,
  type AdminBotLogisticsRequestStatus,
} from "../contracts/actions.js";
import type { AdminBotService } from "../kernel/service.js";
import { MAX_REQUEST_BYTES } from "../workflows/logistics/requests.js";
import { asString, readJson, readRecord, sendJson, sendServiceResult } from "./server.http.js";

/**
 * The ceiling on a logistics POST/PUT body.
 *
 * The service's own cap is on the decoded files; this one is on the wire, so it allows for base64's
 * third and the JSON around it. A body past this is refused while it is still arriving rather than
 * buffered in full and rejected afterwards.
 */
const LOGISTICS_BODY_LIMIT_BYTES = Math.ceil(MAX_REQUEST_BYTES * 1.4);

/** Only what the routes need off the session: who is asking, and whether they speak for the lab. */
export type LogisticsRouteMember = {
  id: string;
  privilege_level: string;
};

export async function handleLogisticsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: AdminBotService,
  member: LogisticsRouteMember,
): Promise<void> {
  const isAdmin = member.privilege_level === "admin";
  if (req.method === "GET" && url.pathname === "/logistics/requests") {
    // The whole of the access decision, and it is one argument: an admin reads the lab's queue,
    // everyone else reads their own requests.
    sendServiceResult(res, service.listLogisticsRequests(isAdmin ? undefined : member.id));
    return;
  }
  if (req.method === "POST" && url.pathname === "/logistics/requests") {
    const body = (await readJson(req, LOGISTICS_BODY_LIMIT_BYTES)) as AdminBotLogisticsRequestInput;
    sendServiceResult(res, service.submitLogisticsRequest(member.id, body));
    return;
  }
  const withdraw = /^\/logistics\/requests\/([^/]+)\/withdraw$/u.exec(url.pathname);
  if (req.method === "POST" && withdraw?.[1]) {
    sendServiceResult(
      res,
      service.withdrawLogisticsRequest(decodeURIComponent(withdraw[1]), member.id),
    );
    return;
  }
  const signed = /^\/logistics\/requests\/([^/]+)\/signed$/u.exec(url.pathname);
  if (req.method === "POST" && signed?.[1]) {
    // Returning a signed document is the lab acting, and it mails the member: admin-only, and the
    // recipient is never in the body -- the service reads it off the roster.
    if (!isAdmin) {
      sendJson(res, 403, { error: { message: "insufficient privileges" } });
      return;
    }
    const body = readRecord(await readJson(req, LOGISTICS_BODY_LIMIT_BYTES));
    sendServiceResult(
      res,
      await service.fileSignedLogisticsDocument(
        decodeURIComponent(signed[1]),
        member.id,
        readSignedDocuments(body.documents),
        asString(body.resolution_note) || undefined,
      ),
    );
    return;
  }
  const status = /^\/logistics\/requests\/([^/]+)\/status$/u.exec(url.pathname);
  if (req.method === "PUT" && status?.[1]) {
    // Answering a request is the lab speaking, not the requester: admin-only, and the service
    // refuses "withdrawn" here however privileged the caller is.
    if (!isAdmin) {
      sendJson(res, 403, { error: { message: "insufficient privileges" } });
      return;
    }
    const body = readRecord(await readJson(req));
    const next = asString(body.status);
    if (!isLogisticsRequestStatus(next)) {
      sendJson(res, 400, {
        error: { message: `status must be one of ${adminBotLogisticsRequestStatuses.join(", ")}` },
      });
      return;
    }
    const note = asString(body.resolution_note);
    sendServiceResult(
      res,
      service.setLogisticsRequestStatus(
        decodeURIComponent(status[1]),
        next,
        member.id,
        note || undefined,
      ),
    );
    return;
  }
  const single = /^\/logistics\/requests\/([^/]+)$/u.exec(url.pathname);
  if (single?.[1]) {
    const requestId = decodeURIComponent(single[1]);
    if (req.method === "GET") {
      sendServiceResult(
        res,
        service.getLogisticsRequest(requestId, { member_id: member.id, is_admin: isAdmin }),
      );
      return;
    }
    if (req.method === "PUT") {
      const body = (await readJson(
        req,
        LOGISTICS_BODY_LIMIT_BYTES,
      )) as AdminBotLogisticsRequestInput;
      sendServiceResult(res, service.updateLogisticsRequest(requestId, member.id, body));
      return;
    }
  }
  sendJson(res, 404, { error: { message: "not found" } });
}

/**
 * The uploaded files, as the service wants them.
 *
 * Shaped here rather than trusted: `size` is recomputed from the bytes downstream, so whatever the
 * client claimed for it is dropped on the way in.
 */
function readSignedDocuments(value: unknown): AdminBotLogisticsAttachment[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const record = readRecord(entry);
    const name = asString(record.name).trim();
    const data = asString(record.data_base64);
    if (!name || !data) {
      return [];
    }
    const contentType = asString(record.content_type).trim();
    return [
      {
        name,
        size: 0,
        ...(contentType ? { content_type: contentType } : {}),
        data_base64: data,
      },
    ];
  });
}

function isLogisticsRequestStatus(value: string): value is AdminBotLogisticsRequestStatus {
  return (adminBotLogisticsRequestStatuses as readonly string[]).includes(value);
}
