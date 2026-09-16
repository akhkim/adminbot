// Public submission handling split from server.ts. Visitors can enqueue a proposal, never read
// the queue or publish. The existing service owns validation, persistence and exact-hash approval.
import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DeadlineProposalInput,
  DeadlineSubmitterContact,
} from "../contracts/deadline-proposals.js";
import type { AdminBotService } from "../kernel/service.js";
import { asString, readJson, readRecord, sendJson, PayloadTooLargeError } from "./server.http.js";

const WINDOW_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 16 * 1024;

export function createPublicDeadlineLimiter(now: () => number = Date.now) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    check(ip: string | undefined): number {
      const time = now();
      const address = ip ?? "unknown";
      let window = attempts.get(address);
      if (!window || window.resetAt <= time) {
        // Bound memory without imposing a shared submission quota on unrelated visitors.
        if (attempts.size >= 10_000) {
          for (const [key, entry] of attempts) {
            if (entry.resetAt <= time) {
              attempts.delete(key);
            }
          }
          if (attempts.size >= 10_000) {
            return 3600;
          }
        }
        window = { count: 0, resetAt: time + WINDOW_MS };
        attempts.set(address, window);
      }
      if (window.count >= 5) {
        return Math.max(1, Math.ceil((window.resetAt - time) / 1000));
      }
      window.count++;
      return 0;
    },
  };
}

export async function handlePublicDeadlineProposal(
  req: IncomingMessage,
  res: ServerResponse,
  service: AdminBotService,
  limiter: ReturnType<typeof createPublicDeadlineLimiter>,
  ip: string | undefined,
  existingDeadlines: readonly unknown[],
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const retryAfter = limiter.check(ip);
  if (retryAfter) {
    res.setHeader("Retry-After", String(retryAfter));
    sendJson(res, 429, {
      error: { message: "Too many deadline proposals. Please try again later." },
    });
    return;
  }
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    sendJson(res, 415, { error: { message: "Use application/json for deadline proposals." } });
    return;
  }
  const key = asString(req.headers["idempotency-key"]).trim() || randomUUID();
  if (key.length > 200) {
    sendJson(res, 400, { error: { message: "Idempotency key is too long." } });
    return;
  }
  let body: Record<string, unknown>;
  try {
    body = readRecord(await readJson(req, MAX_BODY_BYTES));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      sendJson(res, 413, { error: { message: "Deadline proposal is too large." } });
      return;
    }
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    sendJson(res, 400, { error: { message: "Invalid JSON." } });
    return;
  }
  const input: DeadlineProposalInput = {
    name: asString(body.name),
    parentConference: asString(body.parentConference),
    parentYear: asString(body.parentYear),
    entryType: asString(body.entryType) as DeadlineProposalInput["entryType"],
    deadlineDate: asString(body.deadlineDate),
    deadlineTime: asString(body.deadlineTime),
    timezone: asString(body.timezone),
    homepageUrl: asString(body.homepageUrl),
    cfpUrl: asString(body.cfpUrl),
    openReviewUrl: asString(body.openReviewUrl),
    note: asString(body.note),
  };
  // A reserved opaque actor keeps the existing durable idempotency ledger and revision history.
  // It is not a member account or a credential, and gives no access to any authenticated route.
  const actor = `visitor:deadline:${createHash("sha256").update(key).digest("hex")}`;
  const result = service.submitDeadlineProposal(
    input,
    actor,
    key,
    existingDeadlines,
    body.submitter_contact as DeadlineSubmitterContact | undefined,
  );
  if (!result.ok) {
    sendJson(res, result.status, { error: result.error });
    return;
  }
  // Even a replay after review returns only this receipt, never private revisions or status.
  sendJson(res, 202, { status: "received" });
}
