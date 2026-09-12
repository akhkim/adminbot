/**
 * The HTTP face of the inference gate: how a member learns what happened to a request the GPU
 * could not take at once, and how they say "wait after all" without sending it again.
 *
 * Every route here derives the owner from the session, never from the body or the URL. A request
 * id is a handle, not authority: the gate hides another member's row completely (status, result,
 * wait and list all answer as if it did not exist), and this module is what makes the session the
 * only source of the owner it checks against. AGENTS.md is explicit that hiding a tab is not
 * security; this is the server-side half.
 *
 * Interactive callers (privacy tasks, reimbursement turns, blurb drafts) hand the gate three things
 * from the request: the owner, the member's answer to "wait or try later" (`X-Inference-Wait: 1`,
 * or the stored preference), and a submission key (`Idempotency-Key`). The key is what makes a
 * retry after a lost response find its row rather than make a second one; clients that do not send
 * one get no such protection, and the write-up says so.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInferenceDeferred,
  type InferenceGate,
  type InferenceOutcome,
} from "../inference/gate.js";
import { readJsonOrEmpty, readRecord, sendJson } from "./server.http.js";

export type InferenceCallContext = {
  owner: string;
  wait?: boolean;
  submissionKey?: string;
};

/** What the gate needs to know about the caller, read off the session and two headers. */
export function inferenceCallContext(req: IncomingMessage, owner: string): InferenceCallContext {
  const waitHeader = header(req, "x-inference-wait");
  const key = header(req, "idempotency-key");
  return {
    owner,
    ...(waitHeader === "1" || waitHeader === "true"
      ? { wait: true }
      : waitHeader === "0" || waitHeader === "false"
        ? { wait: false }
        : {}),
    ...(key ? { submissionKey: key.slice(0, 200) } : {}),
  };
}

/**
 * A queue decision as an HTTP response.
 *
 * 202 for queued (the work is accepted and will run), 409 for shed (the member has a choice to make
 * and the body says what it is), 410 for expired (the row is gone; resubmit), 409 for a submission-key
 * conflict, 503 for refused (nothing was stored). Every body carries the gate's status object, whose
 * `message` the UI can show as written and whose `request_id` is what a later wait click sends.
 */
export function sendInferenceDeferred(res: ServerResponse, error: unknown): boolean {
  if (!isInferenceDeferred(error)) {
    return false;
  }
  const outcome = error.outcome;
  if (outcome.kind === "refused") {
    sendJson(res, 503, { error: { message: error.message, inference: { state: "refused" } } });
    return true;
  }
  const status = outcome.kind === "queued" ? 202 : outcome.kind === "expired" ? 410 : 409;
  sendJson(res, status, {
    error: { message: outcome.status.message, inference: outcome.status },
    inference: outcome.status,
  });
  return true;
}

/** For callers that branch on the outcome themselves rather than through runGated. */
export function sendInferenceOutcome(res: ServerResponse, outcome: InferenceOutcome): boolean {
  if (outcome.kind === "completed" || outcome.kind === "failed") {
    return false;
  }
  if (outcome.kind === "refused") {
    sendJson(res, 503, { error: { message: outcome.reason, inference: { state: "refused" } } });
    return true;
  }
  const status = outcome.kind === "queued" ? 202 : outcome.kind === "expired" ? 410 : 409;
  sendJson(res, status, {
    error: { message: outcome.status.message, inference: outcome.status },
    inference: outcome.status,
  });
  return true;
}

/**
 * Member-facing routes. Returns false when the path is not one of ours.
 *
 *   GET  /inference/requests                 the caller's own requests, newest first
 *   GET  /inference/requests/:id             one request's status
 *   GET  /inference/requests/:id/result      the stored model reply, once completed
 *   POST /inference/requests/:id/wait        shed -> queued, at the member's request
 *   GET  /inference/preferences              { inference_always_wait }
 *   PUT  /inference/preferences              same shape
 *   GET  /inference/status                   gate health and depth -- privileged callers only
 */
export async function handleInferenceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  gate: InferenceGate,
  owner: string,
  privileged: boolean,
): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/inference/status") {
    if (!privileged) {
      sendJson(res, 403, { error: { message: "insufficient privileges" } });
      return true;
    }
    sendJson(res, 200, gate.stats());
    return true;
  }
  if (url.pathname === "/inference/preferences") {
    if (req.method === "GET") {
      sendJson(res, 200, gate.preferences(owner));
      return true;
    }
    if (req.method === "PUT") {
      const body = readRecord(await readJsonOrEmpty(req));
      if (typeof body.inference_always_wait !== "boolean") {
        sendJson(res, 400, { error: { message: "inference_always_wait must be true or false" } });
        return true;
      }
      sendJson(
        res,
        200,
        gate.setPreferences(owner, { inference_always_wait: body.inference_always_wait }),
      );
      return true;
    }
  }
  if (req.method === "GET" && url.pathname === "/inference/requests") {
    sendJson(res, 200, { requests: gate.listForOwner(owner) });
    return true;
  }
  const one = /^\/inference\/requests\/([^/]+)(?:\/(result|wait))?$/u.exec(url.pathname);
  if (!one?.[1]) {
    return false;
  }
  const id = decodeURIComponent(one[1]);
  const leaf = one[2];
  if (req.method === "GET" && !leaf) {
    const status = gate.status(owner, id);
    if (!status) {
      sendJson(res, 404, { error: { message: "no such request" } });
      return true;
    }
    sendJson(res, 200, status);
    return true;
  }
  if (req.method === "GET" && leaf === "result") {
    const result = gate.result(owner, id);
    if (!result) {
      // The same answer for "not yours", "not finished" and "purged": a handle must not be a way
      // to learn which of those it is about somebody else's request.
      sendJson(res, 404, { error: { message: "no result is available for this request" } });
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }
  if (req.method === "POST" && leaf === "wait") {
    const status = gate.wait(owner, id);
    if (!status) {
      sendJson(res, 404, { error: { message: "no such request" } });
      return true;
    }
    sendJson(res, status.state === "queued" ? 202 : 200, status);
    return true;
  }
  return false;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.trim() || undefined;
}
