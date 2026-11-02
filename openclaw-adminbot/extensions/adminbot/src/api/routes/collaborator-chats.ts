import { collaboratorChatReadiness } from "../../workflows/collaboration/chat-request.js";
import { readJsonOrEmpty, sendJson } from "../server.http.js";
import { adminSessionOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const collaboratorChatRoutes: readonly Route[] = [
  get(
    "/collaborator-chats",
    adminSessionOnly(({ res, ctx, principal }) => {
      if (principal.kind !== "member") {
        return;
      }
      const actions = ctx.store
        .listProposalsByType("slack.collaborator_chat")
        .filter((p) => p.target?.owner_id === principal.member.id);
      sendJson(res, 200, {
        requests: ctx.collaboratorChats.list(principal.member.id).map((request) => {
          const action = actions
            .filter((p) => p.target?.request_id === request.id)
            .toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0];
          const result = Object.assign(
            {},
            request,
            action
              ? { action, receipt: ctx.collaboratorChats.getEffect(`request:${request.id}`) }
              : {},
          );
          return result;
        }),
        members: ctx.store.listLabMembers().map((m) => ({ id: m.id, name: m.name })),
      });
    }),
  ),
  post(
    /^\/collaborator-chats\/([^/]+)\/prepare$/u,
    adminSessionOnly(async ({ res, ctx, principal, params }) => {
      if (principal.kind !== "member") {
        return;
      }
      const request = ctx.collaboratorChats
        .list(principal.member.id)
        .find((r) => r.id === params[1]);
      if (!request) {
        sendJson(res, 404, { error: { message: "Chat request not found." } });
        return;
      }
      const previous = ctx.store
        .listProposalsByType("slack.collaborator_chat")
        .filter((p) => p.target?.request_id === request.id)
        .toSorted((a, b) => b.created_at.localeCompare(a.created_at))[0];
      if (
        previous &&
        (previous.status === "executed" ||
          previous.status === "rejected" ||
          ctx.collaboratorChats.getEffect(`request:${request.id}`))
      ) {
        sendJson(res, 200, { action: previous });
        return;
      }
      if (!ctx.readSlackDirectory) {
        sendJson(res, 503, {
          error: {
            message: "Slack membership verification is unavailable. Request remains saved.",
          },
        });
        return;
      }
      let directory;
      try {
        directory = await ctx.readSlackDirectory();
      } catch {
        sendJson(res, 503, {
          error: { message: "Slack membership verification failed. No action was created." },
        });
        return;
      }
      const participants = request.participant_ids.map((id) => {
        const member = ctx.store.getLabMember(id);
        const slack = member?.slack_user_id;
        const active = directory.some(
          (u) => u.id === slack && !u.deleted && !u.is_bot && !u.is_app_user && !u.is_invited_user,
        );
        return {
          member_id: id,
          slack_user_id: slack,
          verified_slack_user_id: active ? slack : undefined,
        };
      });
      const readiness = collaboratorChatReadiness(participants);
      if (!readiness.ready) {
        sendJson(res, 409, { error: { message: readiness.reason }, readiness });
        return;
      }
      const proposedPayload = {
        participants: participants.map((p) => ({
          member_id: p.member_id,
          slack_user_id: p.slack_user_id,
        })),
        message: request.context,
      };
      if (previous) {
        if (JSON.stringify(previous.proposed_payload) === JSON.stringify(proposedPayload)) {
          sendJson(res, 200, { action: previous });
          return;
        }
        const removed = ctx.service.removePending(previous.id, {
          actor: principal.member.id,
          note: "Slack identities changed; a new exact-payload approval is required.",
        });
        if (!removed.ok) {
          sendJson(res, removed.status, { error: removed.error });
          return;
        }
      }
      const proposal = ctx.service.createProposal({
        type: "slack.collaborator_chat",
        summary: "Create the reviewed collaborator chat and post its opening message",
        target: { request_id: request.id, owner_id: request.owner_id },
        proposed_payload: proposedPayload,
        idempotency_key: `collaborator-chat:${request.id}`,
      });
      if (!proposal.ok) {
        sendJson(res, proposal.status, { error: proposal.error });
        return;
      }
      sendJson(res, 200, { action: proposal.payload });
    }),
  ),
  post(
    "/collaborator-chats",
    adminSessionOnly(async ({ req, res, ctx, principal }) => {
      if (principal.kind !== "member") {
        return;
      }
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
