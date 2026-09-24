import type { IncomingMessage, ServerResponse } from "node:http";
import type { MemberDraftStore } from "../persistence/member-drafts.js";
import { readJson, sendJson } from "./server.http.js";

const KEYS = new Set(["document-signature", "recommendation-letters", "book-meeting"]);

export async function handleMemberDraft(
  req: IncomingMessage,
  res: ServerResponse,
  store: MemberDraftStore,
  memberId: string,
  key: string,
): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  if (!KEYS.has(key)) {
    sendJson(res, 404, { error: { message: "Unknown draft" } });
    return;
  }
  if (req.method === "GET") {
    sendJson(res, 200, { draft: store.read(memberId, key) });
    return;
  }
  if (req.method !== "PUT") {
    sendJson(res, 405, { error: { message: "Method not allowed" } });
    return;
  }
  const body = (await readJson(req, 8_100_000)) as Record<string, unknown> | null;
  if (
    !body ||
    !Number.isSafeInteger(body.baseRevision) ||
    (body.baseRevision as number) < 0 ||
    typeof body.mutationId !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(body.mutationId) ||
    !("data" in body) ||
    JSON.stringify(body.data).length > 8_000_000
  ) {
    sendJson(res, 400, { error: { message: "Invalid draft or draft exceeds 8 MB" } });
    return;
  }
  const draft = store.write(memberId, key, body.baseRevision as number, body.mutationId, body.data);
  sendJson(res, draft ? 200 : 409, { draft: draft ?? store.read(memberId, key) });
}
