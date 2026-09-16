/**
 * Session-owned inference status, results, wait choices, and preferences.
 * Request IDs identify rows; the authenticated session authorizes access.
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
  tasks?: { pause(): void; resume(): void; metrics(): { persist: boolean } },
): Promise<boolean> {
  const controls = new Set([
    "/inference/pause",
    "/inference/resume",
    "/inference/cancel-pending",
    "/inference/settings",
  ]);
  if (controls.has(url.pathname)) {
    if (!privileged) {
      sendJson(res, 403, { error: { message: "insufficient privileges" } });
      return true;
    }
    if (url.pathname === "/inference/settings" && req.method === "GET") {
      sendJson(res, 200, {
        ...gate.settings(),
        ...(tasks ? { task_persistence: tasks.metrics().persist } : {}),
      });
      return true;
    }
    if (url.pathname === "/inference/settings" && req.method === "PUT") {
      const body = readRecord(await readJsonOrEmpty(req));
      const value = body.shutdown_grace_ms;
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 2_147_483_647
      ) {
        sendJson(res, 400, {
          error: { message: "shutdown_grace_ms must be an integer from 0 to 2147483647" },
        });
        return true;
      }
      sendJson(res, 200, gate.setShutdownGraceMs(value, owner));
      return true;
    }
    if (req.method !== "POST" || url.pathname === "/inference/settings") {
      return false;
    }
    if (url.pathname === "/inference/cancel-pending") {
      const body = readRecord(await readJsonOrEmpty(req));
      if (
        !Array.isArray(body.request_ids) ||
        body.request_ids.length === 0 ||
        body.request_ids.length > 1000 ||
        !body.request_ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)
      ) {
        sendJson(res, 400, {
          error: { message: "request_ids must contain 1 to 1000 request IDs" },
        });
        return true;
      }
      sendJson(res, 200, gate.cancelPending(body.request_ids as string[], owner));
      return true;
    }
    if (gate.settings().shutting_down) {
      sendJson(res, 409, { error: { message: "inference gate is shutting down" } });
      return true;
    }
    if (url.pathname === "/inference/pause") {
      tasks?.pause();
    } else {
      tasks?.resume();
    }
    sendJson(
      res,
      200,
      url.pathname === "/inference/pause" ? gate.pause(owner) : gate.resume(owner),
    );
    return true;
  }
  if (req.method === "GET" && url.pathname === "/inference/status") {
    if (!privileged) {
      sendJson(res, 403, { error: { message: "insufficient privileges" } });
      return true;
    }
    sendJson(res, 200, { ...gate.stats(), ...(tasks ? { tasks: tasks.metrics() } : {}) });
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
