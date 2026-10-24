// Narrow stage edits use the same ownership rules as the paper form, without a
// client-side GET/PUT that can overwrite a concurrent title or author edit.
import type { AdminBotPaperProgressUpdate } from "../contracts/actions.js";
import type { AdminBotMemberPrincipal } from "../workflows/identity/auth.js";
import { isPrivileged } from "./routes/guards.js";
import type { RouteRequest } from "./routes/router.js";
import { readJson, sendJson, sendServiceResult } from "./server.http.js";

export async function handlePaperProgress({
  req,
  res,
  ctx,
  principal,
  params,
}: RouteRequest<AdminBotMemberPrincipal>): Promise<void> {
  const { service } = ctx;
  const paperId = decodeURIComponent(params[1] ?? "");
  // Read first so a paper that does not exist answers 404 on every path. Without it a member's
  // write falls through to upsertOwnPaper, which would try to create it and fail on the title.
  const existing = service.getPaper(paperId);
  if (!existing.ok) {
    sendServiceResult(res, existing);
    return;
  }
  const body = (await readJson(req)) as Partial<AdminBotPaperProgressUpdate> | null;
  if (!body || typeof body.current_step !== "string") {
    sendJson(res, 400, { error: { message: "current_step is required" } });
    return;
  }
  if (!isPrivileged(principal)) {
    sendServiceResult(
      res,
      service.upsertOwnPaper(principal.member.id, { id: paperId, current_step: body.current_step }),
    );
    return;
  }
  // Nothing awaits between the read and the write, so the merge is atomic in the service process.
  // Only the stage comes from the client.
  sendServiceResult(
    res,
    service.upsertPaper(
      { ...existing.payload, current_step: body.current_step },
      { source: "admin", actor: principal.member.id },
    ),
  );
}
