// The guidebook question box and the local chat.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { askGuidebook } from "../../guidebook/ask.js";
import { localChatMessages } from "../../privacy/local-chat.js";
import { isTravelHistorySubject } from "../../workflows/members/travel-history.js";
import { readJson, sendJson } from "../server.http.js";
import { privilegedOnly } from "./guards.js";
import { post, route, type Route } from "./router.js";

export const assistantRoutes: readonly Route[] = [
  // Admins and the AdminBot service only. The guidebook is written for the people who run the lab
  // and holds shared credentials; the answer may quote it word for word, so a member session or a
  // member's CLI token must never reach it. Members ask through /lab-sharing/ask instead, which
  // answers from a separately approved member corpus.
  post("/guidebook/ask", privilegedOnly(async ({ req, res }) => {
    const body = (await readJson(req)) as { question?: unknown; maxResults?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) {
      sendJson(res, 400, { error: { message: "question is required" } });
      return;
    }
    // Retrieval and synthesis both run on loopback endpoints inside askGuidebook,
    // and only the prose it writes leaves this handler. Guidebook excerpts are
    // deliberately absent from the response so they cannot reach a hosted model
    // through the agent's context.
    try {
      const result = await askGuidebook({
        question,
        ...(typeof body.maxResults === "number" ? { maxResults: body.maxResults } : {}),
      });
      sendJson(res, 200, result);
    } catch (error) {
      // The cause names local paths and model endpoints; keep it in the server log only.
      console.error("guidebook ask failed", error);
      sendJson(res, 502, { error: { message: "the guidebook gate failed" } });
    }
  })),
  route(["GET", "POST"], "/local-chat", async ({ req, res, ctx, principal }) => {
    const { service } = ctx;
    const settings = service.getSettings();
    if (
      principal.kind !== "member" ||
      principal.impersonator ||
      principal.member.privilege_level !== "admin" ||
      !settings.ok ||
      !isTravelHistorySubject(principal.member.id, settings.payload)
    ) {
      sendJson(res, 404, { error: { message: "Local chat is not available for this account." } });
      return;
    }
    if (req.method === "GET") {
      sendJson(res, 200, {
        model: ctx.localChat.model,
        route: "local",
        history: "not_saved",
        tools: false,
      });
      return;
    }
    const messages = localChatMessages(await readJson(req));
    if (!messages) {
      sendJson(res, 400, {
        error: {
          message:
            "Use up to 23 alternating messages, 8000 characters each and 32000 in total, ending with your question.",
        },
      });
      return;
    }
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.once("close", disconnect);
    if (res.destroyed) disconnect();
    try {
      const output = await ctx.localChat.complete(messages, abort.signal);
      sendJson(res, 200, { output, model: ctx.localChat.model, route: "local" });
    } catch (error) {
      const busy = error instanceof Error && error.message === "local chat busy";
      sendJson(res, busy ? 429 : 503, {
        error: {
          message: busy
            ? "Local chat is busy. Retry shortly."
            : "The local model could not answer. No external model was used. Retry or contact the operator.",
        },
      });
    } finally {
      res.off("close", disconnect);
    }
  }),
];
