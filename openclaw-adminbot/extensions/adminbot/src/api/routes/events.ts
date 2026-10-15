// My Info: the member Events tab -- upcoming events, who is going, who is nearby, and the
// member's own meetup-intro settings.
//
// A member session only, for the same reason as the Travel tab: whereabouts are not the agent's to
// read. Everything is the session member's own view or own settings; no id is taken from the URL.
import { readJson, sendJson, sendServiceResult } from "../server.http.js";
import { memberOnly } from "./guards.js";
import { get, post, put, type Route } from "./router.js";

const DENIED = { status: 403, message: "A member session is required." } as const;

export const eventsRoutes: readonly Route[] = [
  get(
    "/events",
    memberOnly(async ({ res, ctx, principal }) => {
      sendServiceResult(res, ctx.service.meetups().overview(principal.member.id));
    }, DENIED),
  ),
  put(
    "/events/preferences",
    memberOnly(async ({ req, res, ctx, principal }) => {
      let body: unknown;
      try {
        body = await readJson(req, 1024);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        sendJson(res, 400, { error: { message: "Expected JSON." } });
        return;
      }
      sendServiceResult(res, ctx.service.meetups().setPreferences(principal.member.id, body));
    }, DENIED),
  ),
  // The member's own tap, so it sends now: no admin approval (T1, like every intro) and no
  // quiet-hours wait. Idempotent per event and per pair; a second tap answers already_said_hi.
  post(
    "/events/say-hi",
    memberOnly(async ({ req, res, ctx, principal }) => {
      let body: unknown;
      try {
        body = await readJson(req, 1024);
      } catch (error) {
        if (!(error instanceof SyntaxError)) {
          throw error;
        }
        sendJson(res, 400, { error: { message: "Expected JSON." } });
        return;
      }
      sendServiceResult(res, await ctx.service.sayHi(principal.member.id, body));
    }, DENIED),
  ),
];
