// The guidebook question box and the local chat.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { localChatMessages } from "../../privacy/local-chat.js";
import { isTravelHistorySubject } from "../../workflows/members/travel-history.js";
import { readJson, sendJson } from "../server.http.js";
import { post, route, type Route } from "./router.js";
import { submitRouteTask } from "./tasks.js";

export const assistantRoutes: readonly Route[] = [
  post("/guidebook/ask", async ({ req, res, ctx, principal }) => {
    const body = (await readJson(req)) as { question?: unknown; maxResults?: unknown };
    const question = typeof body.question === "string" ? body.question : "";
    if (!question.trim()) {
      sendJson(res, 400, { error: { message: "question is required" } });
      return;
    }
    await submitRouteTask(req, res, ctx, principal, "guidebook", {
      question,
      ...(typeof body.maxResults === "number" ? { maxResults: body.maxResults } : {}),
    });
  }),
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
