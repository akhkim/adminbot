import type { AdminBotMemberNudgeRequest } from "../../contracts/actions.js";
// Escalated and snoozed nudges, and the nudge sends.
//
// Cut from server.ts's handleAuthenticatedRoute. Each route states its audience with a guard
// decorator from guards.ts; the order below is the order the old if-chain tried them in.
import { campaignModeFromBody, isCampaignRefusal } from "../../workflows/nudges/campaign.js";
import {
  readJson,
  readJsonOrEmpty,
  readRecord,
  sendServiceResult,
  sendJson,
} from "../server.http.js";
import { pageOf, readPageQuery } from "../server.paging.js";
import { mapPayload } from "../server.paper-lists.wire.js";
import { adminSessionOnly, memberOnly, principalActor, privilegedOnly } from "./guards.js";
import { get, post, type Route } from "./router.js";

export const nudgesRoutes: readonly Route[] = [
  post(
    "/members/personal-website-reminder/run",
    privilegedOnly(async ({ req, res, principal, ctx }) => {
      const body = readRecord(await readJsonOrEmpty(req));
      const mode = campaignModeFromBody(body);
      const result = await ctx.service.sendPersonalWebsiteReminders(principalActor(principal), {
        ...mode,
        ...(principal.kind === "service" ? { scheduled: true } : {}),
      });
      sendJson(res, isCampaignRefusal(result) ? 409 : 200, result);
    }),
  ),
  // The nudge campaigns (workflows/nudges/campaign.ts), with how many members each has reached.
  get(
    "/nudges/campaigns",
    privilegedOnly(({ res, ctx }) => sendServiceResult(res, ctx.service.listNudgeCampaigns())),
  ),
  get(
    "/nudges/escalated",
    privilegedOnly(({ res, url, ctx }) => {
      const { service } = ctx;
      // The professor page opens this list to 20 people at most and links to Announcements for the
      // rest, so 20 is the page and `total` is the count on its header. Each person's line shows
      // one title or "N items", so a notification goes out as its title and stamps; the body,
      // read state and routing flags are the member's own page's business.
      const page = readPageQuery(url, { defaultLimit: 20, maxLimit: 100 });
      sendServiceResult(
        res,
        mapPayload(service.listEscalatedNudges(), ({ members }) => {
          const { items, ...paging } = pageOf(members, page);
          return {
            members: items.map((member) => ({
              ...member,
              notifications: member.notifications.map((entry) => ({
                id: entry.id,
                title: entry.title,
                created_at: entry.created_at,
                ...(entry.tab ? { tab: entry.tab } : {}),
              })),
            })),
            ...paging,
          };
        }),
      );
    }),
  ),
  // "stop"/"start" DMed to the bot. The plugin matches the DM and calls this with the service
  // token; the sender's Slack ID is what the gateway saw, never a value the message typed.
  post(
    "/nudges/slack-stop",
    privilegedOnly(async ({ req, res, ctx }) => {
      const body = readRecord(await readJson(req));
      const command = body.command === "start" ? "start" : body.command === "stop" ? "stop" : null;
      if (!command) {
        sendServiceResult(res, {
          ok: false,
          status: 400,
          error: { message: "command must be stop or start" },
        });
        return;
      }
      sendServiceResult(
        res,
        ctx.service.applySlackStop({ slackUserId: String(body.slack_user_id ?? ""), command }),
      );
    }),
  ),
  post(
    "/nudges/snooze",
    memberOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = readRecord(await readJson(req));
      sendServiceResult(
        res,
        service.snoozeNudge({
          domain: String(body.domain ?? ""),
          subjectId: String(body.subject_id ?? ""),
          memberId: principal.member.id,
          until: String(body.until ?? ""),
        }),
      );
    }),
  ),
  post(
    "/nudges/send",
    adminSessionOnly(async ({ req, res, principal, ctx }) => {
      const { service } = ctx;
      const body = (await readJson(req)) as AdminBotMemberNudgeRequest;
      // `important` is dropped rather than honored. It is the flag that puts the head professor in a
      // group DM five days later, and the reason that escalation can auto-execute is that nothing
      // but a server-computed sweep can raise it -- see escalateStaleNudges. This is the one nudge
      // route whose text and recipients come from a browser, so letting it set the flag would make
      // "AdminBot escalated this" mean "an admin typed something and waited".
      const { important: _ignored, ...request } = body;
      sendServiceResult(res, await service.sendMemberNudge(request, principalActor(principal)));
    }),
  ),
  post(
    "/nudges/escalate/run",
    privilegedOnly(async ({ res, principal, ctx }) => {
      const { service } = ctx;
      sendServiceResult(res, await service.escalateStaleNudges(principalActor(principal)));
    }),
  ),
];
