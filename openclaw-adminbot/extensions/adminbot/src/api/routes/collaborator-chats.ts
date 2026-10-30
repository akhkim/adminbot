import { readJsonOrEmpty, sendJson } from "../server.http.js";
import { adminSessionOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const collaboratorChatRoutes: readonly Route[] = [
  get(
    "/collaborator-chats",
    adminSessionOnly(({ res, ctx, principal }) => {
      if (principal.kind !== "member") {return;}
      sendJson(res, 200, {
        requests: ctx.collaboratorChats.list(principal.member.id),
        members: ctx.store.listLabMembers().map((m) => ({ id: m.id, name: m.name })),
      });
    }),
  ),
  post(
    "/collaborator-chats",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      if (principal.kind !== "member") {return;}
      const body = (await readJsonOrEmpty(req)) as Record<string, unknown>;
      if (
        !body ||
        typeof body !== "object" ||
        typeof body.context !== "string" ||
        !Array.isArray(body.participant_ids) ||
        !body.participant_ids.every((id) => typeof id === "string" && ctx.store.getLabMember(id))
      ) {
        sendJson(res, 400, {
          error: { message: "Choose existing members and provide a context." },
        });
        return;
      }
      try {
        const saved = ctx.collaboratorChats.save(principal.member.id, {
          context: body.context,
          participant_ids: body.participant_ids as string[],
        });
        sendJson(res, 200, {
          request: saved,
          status: "saved",
          message: "Saved only. No Slack chat or invitation has been created.",
        });
      } catch (error) {
        sendJson(res, 400, {
          error: { message: error instanceof Error ? error.message : "Invalid request." },
        });
      }
    }),
  ),
];
