// AdminBot client: The local chat.
//
// Mirrors the service's api/routes/assistant.ts. Cut from auth/session.ts, which keeps the session
// lifecycle and the request plumbing every zone shares.
import { authedJson, type AuthResult } from "../auth/session.ts";

/** Dedicated local route: never the gateway agent or privacy broker. */
export async function sendLocalChat(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  sessionToken: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<AuthResult<{ output: string; model: string; route: "local" }>> {
  const result = await authedJson(
    baseUrl,
    "/local-chat",
    "POST",
    sessionToken,
    { messages },
    signal,
  );
  if ("unreachable" in result) return { ok: false, kind: "unreachable" };
  const body = result.body as { output?: unknown; model?: unknown; route?: unknown } | null;
  if (
    !result.response.ok ||
    typeof body?.output !== "string" ||
    typeof body.model !== "string" ||
    body.route !== "local"
  )
    return {
      ok: false,
      kind: "draft-failed",
      message: "Local chat could not answer. No external model was used.",
    };
  return { ok: true, value: { output: body.output, model: body.model, route: "local" } };
}
